import Letta from "@letta-ai/letta-client";

const apiKey = process.env.LETTA_API_KEY;
if (!apiKey) throw new Error("LETTA_API_KEY is required");

const agentId = process.env.EXISTING_AGENT_ID;
if (!agentId) throw new Error("EXISTING_AGENT_ID is required");

const client = new Letta({
  apiKey,
  baseURL: "https://api.letta.com",
});

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const run = await client.agents.messages.createAsync(agentId, {
  input: "Reply with exactly: migration example complete",
  callback_url: process.env.CALLBACK_URL,
});

console.log(`run: ${run.id}`);

let current = run;
const deadline = Date.now() + 5 * 60_000;
while (!current.status || !terminalStatuses.has(current.status)) {
  if (Date.now() >= deadline) {
    throw new Error(`Timed out waiting for run ${run.id}`);
  }
  await delay(1_000);
  current = await client.runs.retrieve(run.id);
  console.log(`status: ${current.status ?? "unknown"}`);
}

if (current.status !== "completed") {
  throw new Error(
    `Run ${run.id} ended with status ${current.status ?? "unknown"}`,
  );
}
