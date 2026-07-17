import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import Letta from "@letta-ai/letta-client";

const apiKey = process.env.LETTA_API_KEY;
if (!apiKey) throw new Error("LETTA_API_KEY is required");

const paperPath = resolve(process.env.PAPER_PDF ?? "memgpt.pdf");
const suffix = Date.now().toString(36);
const client = new Letta({
  apiKey,
  baseURL: "https://api.letta.com",
});

let agentId: string | undefined;
let folderId: string | undefined;
let attached = false;

const question = `Use the attached MemGPT paper to answer these questions. Cite short supporting excerpts from the paper for each answer.

1. What operating-system mechanism inspired MemGPT's virtual context management, and how does the paper map the LLM's main and external context to that mechanism?
2. Which two domains were used to evaluate MemGPT, and what new synthetic retrieval task did the paper introduce?`;

async function waitForUpload(fileId: string, targetFolderId: string) {
  const deadline = Date.now() + 5 * 60_000;

  while (Date.now() < deadline) {
    const file = await client.folders.files.retrieve(fileId, {
      folder_id: targetFolderId,
    });

    console.log(`upload status: ${file.processing_status ?? "unknown"}`);
    if (file.processing_status === "completed") return;
    if (file.processing_status === "error") {
      throw new Error(file.error_message ?? "File processing failed");
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }

  throw new Error("Timed out waiting for file processing");
}

try {
  const folder = await client.folders.create({
    name: `memgpt-paper-v1-${suffix}`,
    description: "MemGPT paper used for filesystem document Q&A",
    embedding: "openai/text-embedding-3-small",
  });
  folderId = folder.id;

  const upload = await client.folders.files.upload(folder.id, {
    file: createReadStream(paperPath),
    name: "memgpt.pdf",
  });
  await waitForUpload(upload.id, folder.id);

  const agent = await client.agents.create({
    name: `memgpt-filesystem-example-${suffix}`,
    model: "openai/gpt-5.2",
    embedding: "openai/text-embedding-3-small",
    memory_blocks: [
      {
        label: "persona",
        value:
          "You are a careful research assistant. Answer document questions from attached files and quote the supporting text.",
      },
    ],
  });
  agentId = agent.id;

  // The current generated SDK takes folder ID first and agent ID in the body.
  await client.agents.folders.attach(folder.id, { agent_id: agent.id });
  attached = true;

  const response = await client.agents.messages.create(agent.id, {
    input: question,
  });

  for (const message of response.messages) {
    if (message.message_type === "assistant_message") {
      console.log(message.content);
    }
  }
} finally {
  if (process.env.KEEP_RESOURCES !== "1") {
    if (attached && agentId && folderId) {
      await client.agents.folders
        .detach(folderId, { agent_id: agentId })
        .catch(() => undefined);
    }
    if (agentId) await client.agents.delete(agentId).catch(() => undefined);
    if (folderId) await client.folders.delete(folderId).catch(() => undefined);
  }
}
