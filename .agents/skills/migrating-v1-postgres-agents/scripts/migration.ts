import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type JsonRecord = Record<string, unknown>;

export interface LegacyAgentExport {
  agent: JsonRecord;
  blocks: JsonRecord[];
  messages: JsonRecord[];
  source?: {
    alembicVersion?: string;
    postgresVersion?: string;
  };
}

export interface MigrationOptions {
  storageDir: string;
  model?: string;
  dryRun?: boolean;
}

export interface MigrationWarning {
  agentId: string;
  message: string;
}

export interface MigrationResult {
  agentId: string;
  agentName: string;
  conversations: number;
  sourceMessages: number;
  importedMessages: number;
  memoryFiles: string[];
  warnings: MigrationWarning[];
}

interface LocalMessageMetadata {
  created_at: string;
  updated_at: string;
  agent_id: string;
  conversation_id: string;
  migrated_from: {
    server: "letta-python-postgres";
    message_id: string;
  };
  compaction?: { summary: string };
}

interface LocalMessage extends JsonRecord {
  id: string;
  role: "user" | "assistant" | "toolResult";
  timestamp: number;
  metadata: LocalMessageMetadata;
}

interface ConversationArtifact {
  conversationId: string;
  key: string;
  record: JsonRecord;
  messages: LocalMessage[];
}

interface AgentArtifacts {
  result: MigrationResult;
  agentRecord: JsonRecord;
  memoryFiles: Map<string, string>;
  conversations: ConversationArtifact[];
}

const LETTA_CODE_ORIGIN_TAG = "origin:letta-code";
const GIT_MEMORY_TAG = "git-memory-enabled";
const MIGRATION_TAG = "migrated-from-v1-postgres";
const DEFAULT_MODEL = "local/default";

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function asArray(value: unknown): unknown[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function asRecordArray(value: unknown): JsonRecord[] {
  return asArray(value).filter(isRecord);
}

function isoTimestamp(value: unknown, fallbackIndex = 0): string {
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return new Date(fallbackIndex).toISOString();
}

function textPart(text: string): JsonRecord {
  return { type: "text", text };
}

function contentParts(row: JsonRecord): JsonRecord[] {
  const parsed = parseJson(row.content);
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  const text =
    asString(row.text) ?? (typeof parsed === "string" ? parsed : undefined);
  return text ? [textPart(text)] : [];
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  const parsed = parseJson(value);
  if (typeof parsed === "string") return parsed;
  if (Array.isArray(parsed)) {
    return parsed
      .map((part) => {
        if (!isRecord(part)) return "";
        if (part.type === "text" && typeof part.text === "string")
          return part.text;
        if (part.type === "tool_return" && typeof part.content === "string") {
          return part.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (parsed === undefined || parsed === null) return "";
  return JSON.stringify(parsed);
}

function parseArguments(value: unknown): unknown {
  const parsed = parseJson(value);
  return parsed === undefined || parsed === null ? {} : parsed;
}

function imageContent(part: JsonRecord): JsonRecord | undefined {
  if (part.type !== "image" || !isRecord(part.source)) return undefined;
  if (
    part.source.type === "base64" &&
    typeof part.source.data === "string" &&
    typeof part.source.media_type === "string"
  ) {
    return {
      type: "image",
      data: part.source.data,
      mimeType: part.source.media_type,
    };
  }
  return undefined;
}

function localUserContent(row: JsonRecord): JsonRecord[] {
  const result: JsonRecord[] = [];
  for (const part of contentParts(row)) {
    if (part.type === "text" && typeof part.text === "string") {
      result.push(textPart(part.text));
      continue;
    }
    const image = imageContent(part);
    if (image) result.push(image);
    else if (part.type === "image")
      result.push(textPart("[Image omitted during migration]"));
  }
  const fallback = asString(row.text);
  if (result.length === 0 && fallback) result.push(textPart(fallback));
  return result;
}

function reasoningText(part: JsonRecord): string | undefined {
  if (part.type === "reasoning") {
    return asString(part.reasoning) ?? asString(part.text);
  }
  if (part.type === "summarized_reasoning") {
    return asString(part.summary) ?? asString(part.text);
  }
  if (part.type === "omitted_reasoning")
    return "[Earlier reasoning omitted by provider]";
  if (part.type === "redacted_reasoning")
    return "[Earlier reasoning redacted by provider]";
  return undefined;
}

interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

function toolCallFromPart(part: JsonRecord): NormalizedToolCall | undefined {
  if (part.type !== "tool_call") return undefined;
  const id = asString(part.id) ?? asString(part.tool_call_id);
  const name = asString(part.name);
  if (!id || !name) return undefined;
  return { id, name, arguments: part.input ?? part.arguments ?? {} };
}

function toolCallFromOpenAi(value: JsonRecord): NormalizedToolCall | undefined {
  const id = asString(value.id) ?? asString(value.tool_call_id);
  const fn = isRecord(value.function) ? value.function : value;
  const name = asString(fn.name);
  if (!id || !name) return undefined;
  return {
    id,
    name,
    arguments: parseArguments(fn.arguments ?? value.arguments),
  };
}

function allToolCalls(row: JsonRecord): NormalizedToolCall[] {
  const calls: NormalizedToolCall[] = [];
  for (const part of contentParts(row)) {
    const call = toolCallFromPart(part);
    if (call) calls.push(call);
  }
  for (const value of asRecordArray(row.tool_calls)) {
    const call = toolCallFromOpenAi(value);
    if (call) calls.push(call);
  }
  const deduplicated = new Map<string, NormalizedToolCall>();
  for (const call of calls) deduplicated.set(call.id, call);
  return [...deduplicated.values()];
}

function sendMessageText(call: NormalizedToolCall): string | undefined {
  if (call.name !== "send_message") return undefined;
  const args = isRecord(call.arguments) ? call.arguments : undefined;
  return args ? asString(args.message) : undefined;
}

function messageMetadata(
  row: JsonRecord,
  agentId: string,
  conversationId: string,
  index: number,
): LocalMessageMetadata {
  const createdAt = isoTimestamp(row.created_at, index);
  return {
    created_at: createdAt,
    updated_at: isoTimestamp(row.updated_at, Date.parse(createdAt)),
    agent_id: agentId,
    conversation_id: conversationId,
    migrated_from: {
      server: "letta-python-postgres",
      message_id: asString(row.id) ?? `source-${index}`,
    },
  };
}

function localMessageId(row: JsonRecord, suffix?: string): string {
  const sourceId = asString(row.id) ?? `message-${randomUUID()}`;
  return suffix ? `${sourceId}:${suffix}` : sourceId;
}

function emptyUsage(): JsonRecord {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function convertAssistantMessage(
  row: JsonRecord,
  agentId: string,
  conversationId: string,
  index: number,
): { message?: LocalMessage; skippedToolCallIds: Set<string> } {
  const content: JsonRecord[] = [];
  for (const part of contentParts(row)) {
    if (part.type === "text" && typeof part.text === "string") {
      content.push({ type: "thinking", thinking: part.text });
      continue;
    }
    const reasoning = reasoningText(part);
    if (reasoning) content.push({ type: "thinking", thinking: reasoning });
  }

  const skippedToolCallIds = new Set<string>();
  for (const call of allToolCalls(row)) {
    const deliveredText = sendMessageText(call);
    if (deliveredText) {
      content.push(textPart(deliveredText));
      skippedToolCallIds.add(call.id);
    } else {
      content.push({
        type: "toolCall",
        id: call.id,
        name: call.name,
        arguments: isRecord(call.arguments)
          ? call.arguments
          : { input: call.arguments },
      });
    }
  }

  if (content.length === 0) {
    const fallback = asString(row.text);
    if (fallback) content.push(textPart(fallback));
  }
  if (content.length === 0) return { skippedToolCallIds };

  const metadata = messageMetadata(row, agentId, conversationId, index);
  return {
    message: {
      id: localMessageId(row),
      role: "assistant",
      content,
      api: "openai-completions",
      provider: "openai",
      model: asString(row.model) ?? "legacy-letta",
      usage: emptyUsage(),
      stopReason: row.is_err === true ? "error" : "stop",
      timestamp: Date.parse(metadata.created_at),
      metadata,
    },
    skippedToolCallIds,
  };
}

interface ToolReturnValue {
  toolCallId: string;
  content: unknown;
  isError: boolean;
}

function toolReturns(row: JsonRecord): ToolReturnValue[] {
  const values: ToolReturnValue[] = [];
  for (const item of asRecordArray(row.tool_returns)) {
    const toolCallId = asString(item.tool_call_id);
    if (!toolCallId) continue;
    values.push({
      toolCallId,
      content: item.func_response ?? item.tool_return ?? item.content ?? "",
      isError: item.status === "error" || item.is_error === true,
    });
  }
  for (const part of contentParts(row)) {
    if (part.type !== "tool_return") continue;
    const toolCallId = asString(part.tool_call_id);
    if (!toolCallId) continue;
    values.push({
      toolCallId,
      content: part.content ?? "",
      isError: part.is_error === true || part.status === "error",
    });
  }
  if (values.length === 0) {
    const toolCallId = asString(row.tool_call_id);
    if (toolCallId) {
      values.push({
        toolCallId,
        content: row.content ?? row.text ?? "",
        isError: row.is_err === true,
      });
    }
  }
  const deduplicated = new Map<string, ToolReturnValue>();
  for (const value of values) deduplicated.set(value.toolCallId, value);
  return [...deduplicated.values()];
}

function localToolResultContent(value: unknown): JsonRecord[] {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) {
    const parts: JsonRecord[] = [];
    for (const item of parsed) {
      if (!isRecord(item)) continue;
      if (item.type === "text" && typeof item.text === "string") {
        parts.push(textPart(item.text));
        continue;
      }
      const image = imageContent(item);
      if (image) parts.push(image);
    }
    if (parts.length > 0) return parts;
  }
  return [textPart(textFromUnknown(parsed))];
}

export function convertLegacyMessages(
  rows: JsonRecord[],
  agentId: string,
  conversationId = "default",
): { messages: LocalMessage[]; warnings: MigrationWarning[] } {
  const messages: LocalMessage[] = [];
  const warnings: MigrationWarning[] = [];
  const pendingToolCalls = new Map<string, string>();
  const skippedToolCallIds = new Set<string>();

  for (const [index, row] of rows.entries()) {
    if (row.is_deleted === true) continue;
    const role = asString(row.role);
    if (role === "system") continue;

    if (role === "user") {
      const content = localUserContent(row);
      if (content.length === 0) continue;
      const metadata = messageMetadata(row, agentId, conversationId, index);
      messages.push({
        id: localMessageId(row),
        role: "user",
        content,
        ...(asString(row.otid) ? { otid: row.otid } : {}),
        timestamp: Date.parse(metadata.created_at),
        metadata,
      });
      pendingToolCalls.clear();
      continue;
    }

    if (role === "summary") {
      const summary = textFromUnknown(row.content ?? row.text);
      if (!summary) continue;
      const metadata = messageMetadata(row, agentId, conversationId, index);
      messages.push({
        id: localMessageId(row),
        role: "user",
        content: [textPart(`[Summary of earlier conversation]\n${summary}`)],
        timestamp: Date.parse(metadata.created_at),
        metadata: { ...metadata, compaction: { summary } },
      });
      pendingToolCalls.clear();
      continue;
    }

    if (role === "assistant" || role === "approval") {
      const converted = convertAssistantMessage(
        row,
        agentId,
        conversationId,
        index,
      );
      for (const toolCallId of converted.skippedToolCallIds) {
        skippedToolCallIds.add(toolCallId);
      }
      pendingToolCalls.clear();
      if (converted.message) {
        messages.push(converted.message);
        for (const part of converted.message.content as JsonRecord[]) {
          if (part.type === "toolCall" && typeof part.id === "string") {
            pendingToolCalls.set(part.id, asString(part.name) ?? "legacy_tool");
          }
        }
      }
      continue;
    }

    if (role === "tool") {
      const returns = toolReturns(row);
      for (const [returnIndex, value] of returns.entries()) {
        if (skippedToolCallIds.has(value.toolCallId)) continue;
        const toolName = pendingToolCalls.get(value.toolCallId);
        if (!toolName) {
          warnings.push({
            agentId,
            message: `Skipped orphan tool result ${value.toolCallId} from ${asString(row.id) ?? "unknown message"}`,
          });
          continue;
        }
        const metadata = messageMetadata(row, agentId, conversationId, index);
        messages.push({
          id: localMessageId(
            row,
            returns.length > 1 ? String(returnIndex) : undefined,
          ),
          role: "toolResult",
          toolCallId: value.toolCallId,
          toolName,
          content: localToolResultContent(value.content),
          isError: value.isError,
          timestamp: Date.parse(metadata.created_at),
          metadata,
        });
        pendingToolCalls.delete(value.toolCallId);
      }
      continue;
    }

    warnings.push({
      agentId,
      message: `Skipped unsupported legacy role ${role ?? "unknown"} on ${asString(row.id) ?? "unknown message"}`,
    });
  }

  return { messages, warnings };
}

function safeMemoryPath(label: string): string | undefined {
  const normalized = label.trim().replace(/\\/g, "/").replace(/\.md$/, "");
  if (!normalized) return undefined;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return undefined;
  }
  const path = segments.join("/");
  return `${path === "system" || path.startsWith("system/") ? path : `system/${path}`}.md`;
}

function renderMemoryFile(block: JsonRecord, label: string): string {
  const description =
    asString(block.description) ?? `Imported legacy memory block ${label}`;
  const value = typeof block.value === "string" ? block.value : "";
  return [
    "---",
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    value,
    "",
  ].join("\n");
}

function inlineMemoryBlocks(agent: JsonRecord): JsonRecord[] {
  const memory = parseJson(agent.memory);
  if (!isRecord(memory)) return [];
  const source = isRecord(memory.memory) ? memory.memory : memory;
  const blocks: JsonRecord[] = [];
  for (const [label, rawValue] of Object.entries(source)) {
    if (typeof rawValue === "string") {
      blocks.push({ label, value: rawValue });
    } else if (isRecord(rawValue)) {
      blocks.push({ label, ...rawValue });
    }
  }
  return blocks;
}

export function convertLegacyBlocks(
  agent: JsonRecord,
  blocks: JsonRecord[],
): { files: Map<string, string>; warnings: MigrationWarning[] } {
  const agentId = asString(agent.id) ?? "unknown-agent";
  const sourceBlocks = blocks.length > 0 ? blocks : inlineMemoryBlocks(agent);
  const files = new Map<string, string>();
  const warnings: MigrationWarning[] = [];
  for (const block of sourceBlocks) {
    if (block.is_deleted === true || block.hidden === true) continue;
    const label = asString(block.block_label) ?? asString(block.label);
    if (!label) {
      warnings.push({
        agentId,
        message: "Skipped a memory block with no label",
      });
      continue;
    }
    const path = safeMemoryPath(label);
    if (!path) {
      warnings.push({
        agentId,
        message: `Skipped unsafe memory block label ${label}`,
      });
      continue;
    }
    files.set(path, renderMemoryFile(block, label));
  }
  return { files, warnings };
}

function sourceConversationId(row: JsonRecord): string {
  return asString(row.conversation_id) ?? "default";
}

function encodePathSegment(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function conversationKey(conversationId: string, agentId: string): string {
  return conversationId === "default"
    ? `default:${agentId}`
    : `conversation:${conversationId}`;
}

function conversationRecord(
  conversationId: string,
  agentId: string,
  messages: LocalMessage[],
  agent: JsonRecord,
): JsonRecord {
  const createdAt =
    messages[0]?.metadata.created_at ?? isoTimestamp(agent.created_at, 0);
  const updatedAt =
    messages.at(-1)?.metadata.updated_at ?? isoTimestamp(agent.updated_at, 0);
  return {
    id: conversationId,
    agent_id: agentId,
    archived: false,
    archived_at: null,
    created_at: createdAt,
    updated_at: updatedAt,
    last_message_at: messages.at(-1)?.metadata.created_at ?? null,
    summary: null,
    in_context_message_ids: messages.map((message) => message.id),
  };
}

export function buildAgentArtifacts(
  exported: LegacyAgentExport,
  options: { model?: string } = {},
): AgentArtifacts {
  const agentId = asString(exported.agent.id);
  if (!agentId) throw new Error("Legacy agent row has no id");
  const agentName = asString(exported.agent.name) ?? agentId;
  const tags = [LETTA_CODE_ORIGIN_TAG, GIT_MEMORY_TAG, MIGRATION_TAG];
  const agentRecord: JsonRecord = {
    id: agentId,
    name: agentName,
    description:
      typeof exported.agent.description === "string"
        ? exported.agent.description
        : null,
    system:
      typeof exported.agent.system === "string" ? exported.agent.system : "",
    tags,
    model: options.model ?? DEFAULT_MODEL,
    model_settings: {},
  };

  const memory = convertLegacyBlocks(exported.agent, exported.blocks);
  const sourceByConversation = new Map<string, JsonRecord[]>();
  for (const row of exported.messages) {
    const id = sourceConversationId(row);
    const group = sourceByConversation.get(id) ?? [];
    group.push(row);
    sourceByConversation.set(id, group);
  }
  if (!sourceByConversation.has("default"))
    sourceByConversation.set("default", []);

  const conversations: ConversationArtifact[] = [];
  const warnings = [...memory.warnings];
  let importedMessages = 0;
  for (const [conversationId, rows] of sourceByConversation) {
    const converted = convertLegacyMessages(rows, agentId, conversationId);
    warnings.push(...converted.warnings);
    importedMessages += converted.messages.length;
    const key = conversationKey(conversationId, agentId);
    conversations.push({
      conversationId,
      key,
      record: conversationRecord(
        conversationId,
        agentId,
        converted.messages,
        exported.agent,
      ),
      messages: converted.messages,
    });
  }
  conversations.sort((a, b) =>
    a.conversationId === "default"
      ? -1
      : b.conversationId === "default"
        ? 1
        : a.conversationId.localeCompare(b.conversationId),
  );

  return {
    agentRecord,
    memoryFiles: memory.files,
    conversations,
    result: {
      agentId,
      agentName,
      conversations: conversations.length,
      sourceMessages: exported.messages.length,
      importedMessages,
      memoryFiles: [...memory.files.keys()].sort(),
      warnings,
    },
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sessionEntries(
  conversationId: string,
  messages: LocalMessage[],
): JsonRecord[] {
  const firstTimestamp =
    messages[0]?.metadata.created_at ?? new Date(0).toISOString();
  const entries: JsonRecord[] = [
    {
      type: "session",
      version: 3,
      id: conversationId,
      timestamp: firstTimestamp,
      cwd: process.cwd(),
    },
  ];
  let parentId: string | null = null;
  for (const message of messages) {
    const entryId = randomUUID().slice(0, 8);
    entries.push({
      type: "message",
      id: entryId,
      parentId,
      timestamp: message.metadata.created_at,
      message,
    });
    parentId = entryId;
  }
  return entries;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args[0]} failed in ${cwd}: ${stderr.trim()}`);
  }
}

async function writeMemoryRepo(
  memoryDir: string,
  agentId: string,
  agentName: string,
  files: Map<string, string>,
): Promise<void> {
  mkdirSync(memoryDir, { recursive: true });
  await runGit(memoryDir, ["init", "-b", "main"]);
  for (const [relativePath, content] of files) {
    const path = join(memoryDir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  await runGit(memoryDir, ["add", "-A"]);
  await runGit(memoryDir, [
    "-c",
    `user.name=${agentName}`,
    "-c",
    `user.email=${agentId}@letta.com`,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "chore: import memory from legacy Letta server",
  ]);
}

function destinationPaths(
  storageDir: string,
  artifacts: AgentArtifacts,
): string[] {
  const agentId = artifacts.result.agentId;
  return [
    join(storageDir, "agents", `${encodePathSegment(agentId)}.json`),
    ...artifacts.conversations.map((conversation) =>
      join(storageDir, "conversations", encodePathSegment(conversation.key)),
    ),
    join(storageDir, "memfs", agentId),
  ];
}

function assertDestinationsAvailable(
  storageDir: string,
  artifacts: AgentArtifacts[],
): void {
  const paths = artifacts.flatMap((item) => destinationPaths(storageDir, item));
  const duplicates = paths.filter(
    (path, index) => paths.indexOf(path) !== index,
  );
  if (duplicates.length > 0) {
    throw new Error(
      `Migration would create duplicate destination: ${duplicates[0]}`,
    );
  }
  const collision = paths.find(existsSync);
  if (collision) {
    throw new Error(
      `Destination already exists: ${collision}. This migration never overwrites local agents or conversations.`,
    );
  }
}

async function writeAgentToStage(
  stageDir: string,
  artifacts: AgentArtifacts,
): Promise<void> {
  const agentId = artifacts.result.agentId;
  writeJson(
    join(stageDir, "agents", `${encodePathSegment(agentId)}.json`),
    artifacts.agentRecord,
  );
  for (const conversation of artifacts.conversations) {
    const conversationDir = join(
      stageDir,
      "conversations",
      encodePathSegment(conversation.key),
    );
    writeJson(join(conversationDir, "conversation.json"), conversation.record);
    writeJson(join(conversationDir, "manifest.json"), {
      schema_version: 2,
      message_format: "pi-session-entry-jsonl",
      provider_stack: "pi-ai",
      created_at:
        conversation.messages[0]?.metadata.created_at ??
        new Date().toISOString(),
      migrated_from: "letta-python-postgres",
      migrated_at: new Date().toISOString(),
    });
    const rows = sessionEntries(
      conversation.conversationId,
      conversation.messages,
    );
    writeFileSync(
      join(conversationDir, "messages.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
  }
  await writeMemoryRepo(
    join(stageDir, "memfs", agentId, "memory"),
    agentId,
    artifacts.result.agentName,
    artifacts.memoryFiles,
  );
}

function moveStagedPaths(
  stageDir: string,
  storageDir: string,
  artifacts: AgentArtifacts[],
): void {
  const moved: Array<{ source: string; destination: string }> = [];
  try {
    for (const item of artifacts) {
      for (const destination of destinationPaths(storageDir, item)) {
        const relative = destination.slice(storageDir.length + 1);
        const source = join(stageDir, relative);
        mkdirSync(dirname(destination), { recursive: true });
        renameSync(source, destination);
        moved.push({ source, destination });
      }
    }
  } catch (error) {
    for (const item of moved.reverse()) {
      if (!existsSync(item.destination)) continue;
      mkdirSync(dirname(item.source), { recursive: true });
      renameSync(item.destination, item.source);
    }
    throw error;
  }
}

export async function migrateLegacyExports(
  exports: LegacyAgentExport[],
  options: MigrationOptions,
): Promise<MigrationResult[]> {
  const artifacts = exports.map((item) =>
    buildAgentArtifacts(item, { model: options.model }),
  );
  assertDestinationsAvailable(options.storageDir, artifacts);
  if (options.dryRun) return artifacts.map((item) => item.result);

  mkdirSync(dirname(options.storageDir), { recursive: true });
  const stageDir = join(
    dirname(options.storageDir),
    `.letta-v1-migration-${randomUUID()}`,
  );
  mkdirSync(stageDir, { recursive: true });
  try {
    for (const item of artifacts) await writeAgentToStage(stageDir, item);
    moveStagedPaths(stageDir, options.storageDir, artifacts);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
  return artifacts.map((item) => item.result);
}
