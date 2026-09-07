---
name: migrating-v1-postgres-agents
description: Migrates agents from the retired Python Letta server's PostgreSQL database into Letta Code's local backend/App Server. Use when moving legacy agents, message history, and attached memory blocks into the current local backend and converting block memory to Git-backed MemFS Markdown files.
---

# Migrating V1 Postgres Agents

Move active agents, their full active message history, and current attached memory blocks from the retired Python server into a stopped Letta local backend.

## Before running

1. Back up the PostgreSQL database and the destination local-backend directory.
2. Install [Bun](https://bun.sh/).
3. Stop every App Server or Letta Code process that uses the destination directory. The local backend has no offline-import lock.
4. Choose a new destination or confirm that none of the source agent IDs already exist there. The script never overwrites an agent, conversation, or MemFS directory.
5. Read [references/format.md](references/format.md) when checking message conversion, storage compatibility, or excluded data.

## Preview the migration

Run a dry run first:

```bash
bun .agents/skills/migrating-v1-postgres-agents/scripts/migrate.ts \
  --postgres-url "$LETTA_V1_POSTGRES_URL" \
  --storage-dir "$HOME/.letta/lc-local-backend" \
  --dry-run
```

To select agents, repeat `--agent`:

```bash
bun .agents/skills/migrating-v1-postgres-agents/scripts/migrate.ts \
  --postgres-url "$LETTA_V1_POSTGRES_URL" \
  --storage-dir "$HOME/.letta/lc-local-backend" \
  --agent agent-01234567-89ab-cdef-0123-456789abcdef \
  --dry-run
```

Inspect each result's source/imported message counts, memory files, and warnings. Resolve unexpected warnings before writing.

## Write the destination

Rerun without `--dry-run`. Set a model handle valid for the destination App Server:

```bash
bun .agents/skills/migrating-v1-postgres-agents/scripts/migrate.ts \
  --postgres-url "$LETTA_V1_POSTGRES_URL" \
  --storage-dir "$HOME/.letta/lc-local-backend" \
  --model "<provider/model>"
```

The script:

1. Opens a read-only, repeatable-read PostgreSQL transaction.
2. Detects available legacy tables and columns.
3. Reads complete agent, block, and message rows as JSON.
4. Converts attached blocks to `system/<label>.md` MemFS files.
5. Converts each legacy conversation to the current local transcript format.
6. Builds all files in a temporary staging directory.
7. Moves staged agent, conversation, and MemFS paths into the destination only after every conversion succeeds.

If a destination path already exists, choose a fresh destination. Do not delete it blindly. It may contain current local work.

## Verify before resuming work

1. Keep the old server and database unchanged.
2. Run the migration tests:

```bash
bun test .agents/skills/migrating-v1-postgres-agents/scripts/migration.test.ts
```

3. Inspect the imported memory repository:

```bash
git -C "$HOME/.letta/lc-local-backend/memfs/<agent-id>/memory" log --oneline
git -C "$HOME/.letta/lc-local-backend/memfs/<agent-id>/memory" status --short
```

4. Start the current App Server against the destination.
5. List the imported agent and open each migrated conversation before sending a new message.
6. Compare the visible message count and the `system/*.md` memory contents with the dry-run report and source server.
7. Send a new message only after the read-only comparison passes.

Keep the PostgreSQL backup until every migrated agent has completed a new turn successfully.
