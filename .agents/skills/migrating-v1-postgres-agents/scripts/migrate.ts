#!/usr/bin/env bun
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { SQL } from "bun";
import {
  type JsonRecord,
  type LegacyAgentExport,
  migrateLegacyExports,
} from "./migration";

interface CliOptions {
  postgresUrl: string;
  storageDir: string;
  agentIds: string[];
  model?: string;
  dryRun: boolean;
}

interface TableInventoryRow {
  table_name: string;
  column_name: string;
}

interface JsonRow {
  row: JsonRecord;
}

function usage(): string {
  return `Usage:
  bun migrate.ts --postgres-url <url> [--agent <id> ...] [options]

Moves active agents, message history, and current memory blocks from the retired
Python server's PostgreSQL database into a stopped Letta local backend.

Options:
  --postgres-url <url>  Source PostgreSQL URL (or LETTA_V1_POSTGRES_URL)
  --storage-dir <path>  Local backend root (default ~/.letta/lc-local-backend)
  --agent <id>          Migrate one agent; repeat to migrate several (default all)
  --model <handle>      Destination model handle (default local/default)
  --dry-run             Read and convert without writing destination files
  -h, --help            Show this help

The App Server must be stopped while this script runs. The migration never
changes PostgreSQL and never overwrites an existing local agent or conversation.`;
}

function parseCli(argv: string[]): CliOptions {
  const parsed = parseArgs({
    args: argv,
    options: {
      "postgres-url": { type: "string" },
      "storage-dir": { type: "string" },
      agent: { type: "string", multiple: true },
      model: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (parsed.values.help) {
    console.log(usage());
    process.exit(0);
  }
  const postgresUrl =
    parsed.values["postgres-url"] ?? process.env.LETTA_V1_POSTGRES_URL;
  if (!postgresUrl)
    throw new Error("--postgres-url or LETTA_V1_POSTGRES_URL is required");
  return {
    postgresUrl,
    storageDir: resolve(
      parsed.values["storage-dir"] ??
        process.env.LETTA_LOCAL_BACKEND_DIR ??
        `${homedir()}/.letta/lc-local-backend`,
    ),
    agentIds: parsed.values.agent ?? [],
    model: parsed.values.model,
    dryRun: parsed.values["dry-run"] === true,
  };
}

function inventoryMap(rows: TableInventoryRow[]): Map<string, Set<string>> {
  const inventory = new Map<string, Set<string>>();
  for (const row of rows) {
    const columns = inventory.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    inventory.set(row.table_name, columns);
  }
  return inventory;
}

function assertRequiredSchema(inventory: Map<string, Set<string>>): void {
  for (const table of ["agents", "messages"]) {
    if (!inventory.has(table))
      throw new Error(`Source database has no public.${table} table`);
  }
  for (const [table, columns] of [
    ["agents", ["id"]],
    ["messages", ["id", "agent_id", "role"]],
  ] as const) {
    const actual = inventory.get(table);
    for (const column of columns) {
      if (!actual?.has(column)) {
        throw new Error(`Source table public.${table} has no ${column} column`);
      }
    }
  }
}

function activeRow(row: JsonRecord): boolean {
  return row.is_deleted !== true;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function selectedAgents(rows: JsonRow[], requestedIds: string[]): JsonRecord[] {
  const agents = rows.map((item) => item.row).filter(activeRow);
  if (requestedIds.length === 0) return agents;
  const byId = new Map(agents.map((agent) => [asString(agent.id), agent]));
  return requestedIds.map((id) => {
    const agent = byId.get(id);
    if (!agent) throw new Error(`Active legacy agent not found: ${id}`);
    return agent;
  });
}

async function extractLegacyAgents(
  options: CliOptions,
): Promise<LegacyAgentExport[]> {
  const db = new SQL(options.postgresUrl);
  try {
    return await db.begin(async (tx) => {
      await tx.unsafe(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const inventoryRows = (await tx.unsafe(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position
      `)) as TableInventoryRow[];
      const inventory = inventoryMap(inventoryRows);
      assertRequiredSchema(inventory);

      const agentRows = (await tx.unsafe(`
        SELECT to_jsonb(a) AS row
        FROM public.agents AS a
        ORDER BY a.id
      `)) as JsonRow[];
      const agents = selectedAgents(agentRows, options.agentIds);
      if (agents.length === 0)
        throw new Error("Source database has no active agents");

      let alembicVersion: string | undefined;
      if (inventory.has("alembic_version")) {
        const versions = (await tx.unsafe(
          "SELECT version_num FROM public.alembic_version LIMIT 1",
        )) as Array<{ version_num?: string }>;
        alembicVersion = versions[0]?.version_num;
      }
      const versionRows = (await tx.unsafe(
        "SELECT current_setting('server_version') AS version",
      )) as Array<{ version?: string }>;
      const postgresVersion = versionRows[0]?.version;

      const hasBlocks =
        inventory.has("block") && inventory.has("blocks_agents");
      const messageColumns = inventory.get("messages") ?? new Set<string>();
      const orderBy = messageColumns.has("sequence_id")
        ? "m.sequence_id ASC NULLS LAST, m.created_at ASC NULLS FIRST, m.id ASC"
        : messageColumns.has("created_at")
          ? "m.created_at ASC NULLS FIRST, m.id ASC"
          : "m.id ASC";

      const exports: LegacyAgentExport[] = [];
      for (const agent of agents) {
        const agentId = asString(agent.id);
        if (!agentId) throw new Error("Source agents row has no string id");
        const blocks = hasBlocks
          ? (
              (await tx.unsafe(
                `SELECT to_jsonb(b) || jsonb_build_object('block_label', ba.block_label) AS row
               FROM public.block AS b
               JOIN public.blocks_agents AS ba ON ba.block_id = b.id
               WHERE ba.agent_id = $1
               ORDER BY ba.block_label, ba.block_id`,
                [agentId],
              )) as JsonRow[]
            ).map((item) => item.row)
          : [];
        const messages = (
          (await tx.unsafe(
            `SELECT to_jsonb(m) AS row
           FROM public.messages AS m
           WHERE m.agent_id = $1
           ORDER BY ${orderBy}`,
            [agentId],
          )) as JsonRow[]
        ).map((item) => item.row);
        exports.push({
          agent,
          blocks,
          messages,
          source: { alembicVersion, postgresVersion },
        });
      }
      return exports;
    });
  } finally {
    await db.close();
  }
}

export async function run(argv: string[]): Promise<number> {
  try {
    const options = parseCli(argv);
    console.error(
      options.dryRun
        ? `Dry run: reading PostgreSQL and checking ${options.storageDir}`
        : `Importing into ${options.storageDir}; confirm the App Server is stopped`,
    );
    const exports = await extractLegacyAgents(options);
    const results = await migrateLegacyExports(exports, options);
    console.log(JSON.stringify({ dryRun: options.dryRun, results }, null, 2));
    return 0;
  } catch (error) {
    console.error(
      `Migration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
