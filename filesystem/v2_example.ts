import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";

const apiKey = process.env.LETTA_API_KEY;
if (!apiKey) throw new Error("LETTA_API_KEY is required");

// Repository files are text content, so extract text from the source PDF first.
const paperText = await readFile(
  resolve(process.env.PAPER_TEXT ?? "memgpt.txt"),
  "utf8",
);
const suffix = Date.now().toString(36);
const client = new LettaAgentClient({
  backend: "cloud",
  apiKey,
  apiBaseUrl: "https://api.letta.com",
  sandbox: { terminateOnClose: true },
});

let agentId: string | undefined;
let repositoryId: string | undefined;
let session: ReturnType<typeof client.createSession> | undefined;

async function deleteAgent(id: string) {
  const response = await fetch(
    `https://api.letta.com/v1/agents/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );

  if (!response.ok && response.status !== 404) {
    throw new Error(`Agent cleanup failed with HTTP ${response.status}`);
  }
}

try {
  const repository = await client.repositories.create({
    name: `memgpt-paper-v2-${suffix}`,
  });
  repositoryId = repository.id;
  console.log(`repository: ${repository.id}`);

  const mutation = await client.repositories.files.create(repository.id, {
    path: "papers/memgpt.txt",
    content: paperText,
  });
  console.log(`file commit: ${mutation.commitSha}`);

  const files = await client.repositories.files.list(repository.id, {
    pathPrefix: "papers/",
  });
  console.log(`files: ${files.files.map((file) => file.path).join(", ")}`);

  agentId = await client.createAgent({
    name: `memgpt-repositories-example-${suffix}`,
    model: "openai/gpt-5.2",
    persona:
      "You are a careful research assistant. Answer document questions from attached repositories and quote the supporting text.",
    memfs: false,
  });
  console.log(`agent: ${agentId}`);

  // The SDK attaches this repository before startup and detaches it on close.
  session = client.createSession(agentId, {
    permissionMode: "unrestricted",
    resources: [{ type: "repository", repositoryId: repository.id }],
  });

  const question = `Use the attached repository ${repository.name}, specifically papers/memgpt.txt, to answer these questions. Cite short supporting excerpts from the paper for each answer.

1. What operating-system mechanism inspired MemGPT's virtual context management, and how does the paper map the LLM's main and external context to that mechanism?
2. Which two domains were used to evaluate MemGPT, and what new synthetic retrieval task did the paper introduce?`;

  await session.send(question);

  const assistantParts: string[] = [];
  const toolCalls = new Map<string, string>();

  for await (const message of session.stream()) {
    if (message.type === "tool_call") {
      toolCalls.set(message.toolCallId, message.toolName);
    } else if (message.type === "assistant") {
      assistantParts.push(message.content);
    } else if (message.type === "error") {
      throw new Error(message.message);
    } else if (message.type === "result" && !message.success) {
      throw new Error(
        message.errorDetail ?? message.error ?? "Agent turn failed",
      );
    }
  }

  console.log(`tools used: ${[...new Set(toolCalls.values())].join(", ")}`);
  console.log(`\nANSWER\n${assistantParts.join("")}`);
} finally {
  session?.close();

  if (process.env.KEEP_RESOURCES !== "1") {
    // Session detach and managed-sandbox cleanup are asynchronous and best effort.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
    if (repositoryId) {
      await client.repositories.delete(repositoryId).catch(() => undefined);
    }
    if (agentId) await deleteAgent(agentId).catch(() => undefined);
  }
}
