import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildAgentArtifacts,
  convertLegacyMessages,
  type JsonRecord,
  type LegacyAgentExport,
  migrateLegacyExports,
} from "./migration";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "letta-v1-migration-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fixture(
  overrides: Partial<LegacyAgentExport> = {},
): LegacyAgentExport {
  return {
    agent: {
      id: "agent-legacy",
      name: "Legacy agent",
      description: "Migrated fixture",
      system: "Legacy system prompt",
      created_at: "2025-01-01T00:00:00Z",
    },
    blocks: [
      {
        id: "block-persona",
        block_label: "persona",
        label: "persona",
        description: "How I behave",
        value: "I remember the old server.",
      },
      {
        id: "block-human",
        block_label: "human",
        label: "human",
        value: "The human is Charles.",
      },
    ],
    messages: [
      {
        id: "message-user",
        role: "user",
        content: [{ type: "text", text: "Where are we?" }],
        created_at: "2025-01-01T00:00:01Z",
      },
      {
        id: "message-assistant",
        role: "assistant",
        content: [{ type: "text", text: "I should answer plainly." }],
        tool_calls: [
          {
            id: "call-send",
            type: "function",
            function: {
              name: "send_message",
              arguments: JSON.stringify({
                message: "On the old Python server.",
              }),
            },
          },
        ],
        created_at: "2025-01-01T00:00:02Z",
      },
      {
        id: "message-send-result",
        role: "tool",
        tool_call_id: "call-send",
        content: [{ type: "text", text: "Success" }],
        created_at: "2025-01-01T00:00:03Z",
      },
    ],
    ...overrides,
  };
}

function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
}

describe("legacy message conversion", () => {
  test("turns send_message into visible assistant text and drops its tool result", () => {
    const exported = fixture();
    const converted = convertLegacyMessages(exported.messages, "agent-legacy");

    expect(converted.messages).toHaveLength(2);
    expect(converted.messages[0]?.role).toBe("user");
    expect(converted.messages[1]?.role).toBe("assistant");
    expect(converted.messages[1]?.content).toEqual([
      { type: "thinking", thinking: "I should answer plainly." },
      { type: "text", text: "On the old Python server." },
    ]);
  });

  test("preserves ordinary tool calls and matching results", () => {
    const rows: JsonRecord[] = [
      {
        id: "message-assistant",
        role: "assistant",
        tool_calls: [
          {
            id: "call-search",
            function: {
              name: "archival_memory_search",
              arguments: '{"query":"x"}',
            },
          },
        ],
      },
      {
        id: "message-tool",
        role: "tool",
        tool_returns: [
          {
            tool_call_id: "call-search",
            status: "success",
            func_response: "found x",
          },
        ],
      },
    ];

    const converted = convertLegacyMessages(rows, "agent-legacy");
    expect(converted.messages.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
    ]);
    expect(converted.messages[1]).toMatchObject({
      toolCallId: "call-search",
      toolName: "archival_memory_search",
      isError: false,
    });
  });
});

describe("local backend artifact import", () => {
  test("writes current transcript files and a committed MemFS repo", async () => {
    const root = tempDirectory();
    const storageDir = join(root, "local-backend");
    const [result] = await migrateLegacyExports([fixture()], { storageDir });

    expect(result).toMatchObject({
      agentId: "agent-legacy",
      conversations: 1,
      sourceMessages: 3,
      importedMessages: 2,
      memoryFiles: ["system/human.md", "system/persona.md"],
    });

    const agentPath = join(
      storageDir,
      "agents",
      `${Buffer.from("agent-legacy").toString("base64url")}.json`,
    );
    expect(readJson(agentPath)).toMatchObject({
      id: "agent-legacy",
      name: "Legacy agent",
      model: "local/default",
      tags: [
        "origin:letta-code",
        "git-memory-enabled",
        "migrated-from-v1-postgres",
      ],
    });

    const key = Buffer.from("default:agent-legacy").toString("base64url");
    const conversationDir = join(storageDir, "conversations", key);
    expect(readJson(join(conversationDir, "manifest.json"))).toMatchObject({
      schema_version: 2,
      message_format: "pi-session-entry-jsonl",
      provider_stack: "pi-ai",
      migrated_from: "letta-python-postgres",
    });
    const rows = readFileSync(join(conversationDir, "messages.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as JsonRecord);
    expect(rows[0]).toMatchObject({
      type: "session",
      version: 3,
      id: "default",
    });
    expect(rows.slice(1).map((row) => row.type)).toEqual([
      "message",
      "message",
    ]);
    expect(readJson(join(conversationDir, "conversation.json"))).toMatchObject({
      id: "default",
      agent_id: "agent-legacy",
      in_context_message_ids: ["message-user", "message-assistant"],
    });

    const memoryDir = join(storageDir, "memfs", "agent-legacy", "memory");
    expect(
      readFileSync(join(memoryDir, "system", "persona.md"), "utf8"),
    ).toContain("I remember the old server.");
    const subject = execFileSync("git", ["log", "-1", "--format=%s"], {
      cwd: memoryDir,
      encoding: "utf8",
    }).trim();
    expect(subject).toBe("chore: import memory from legacy Letta server");
  });

  test("dry run writes nothing", async () => {
    const root = tempDirectory();
    const storageDir = join(root, "local-backend");
    const result = await migrateLegacyExports([fixture()], {
      storageDir,
      dryRun: true,
    });
    expect(result[0]?.importedMessages).toBe(2);
    expect(() => readFileSync(join(storageDir, "agents"))).toThrow();
  });

  test("refuses to overwrite an existing local agent", async () => {
    const root = tempDirectory();
    const storageDir = join(root, "local-backend");
    await migrateLegacyExports([fixture()], { storageDir });
    await expect(
      migrateLegacyExports([fixture()], { storageDir }),
    ).rejects.toThrow("Destination already exists");
  });

  test("keeps non-default legacy conversations separate", () => {
    const exported = fixture({
      messages: [
        {
          id: "default-message",
          role: "user",
          text: "default",
          created_at: "2025-01-01T00:00:01Z",
        },
        {
          id: "other-message",
          role: "user",
          text: "other",
          conversation_id: "conversation-old",
          created_at: "2025-01-01T00:00:02Z",
        },
      ],
    });
    const artifacts = buildAgentArtifacts(exported);
    expect(
      artifacts.conversations.map(
        (conversation) => conversation.conversationId,
      ),
    ).toEqual(["default", "conversation-old"]);
  });
});
