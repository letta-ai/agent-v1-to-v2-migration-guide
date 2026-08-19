import {
  LettaAgentClient,
  type SDKResultMessage,
} from "@letta-ai/letta-agent-sdk";

const apiKey = process.env.LETTA_API_KEY;
if (!apiKey) throw new Error("LETTA_API_KEY is required");

const agentId = process.env.EXISTING_AGENT_ID;
if (!agentId) throw new Error("EXISTING_AGENT_ID is required");

const client = new LettaAgentClient({
  backend: "cloud",
  apiKey,
  sandbox: { terminateOnClose: true },
});

interface CompletedTurn {
  assistantText: string;
  conversationId: string | null;
  runIds: string[];
}

async function runAgentTurn(
  agentId: string,
  prompt: string,
): Promise<CompletedTurn> {
  await using session = client.resumeSession(agentId);

  await session.send(prompt);

  const assistantParts: string[] = [];
  let lastError: string | undefined;
  let terminalResult: SDKResultMessage | undefined;

  for await (const message of session.stream()) {
    if (message.type === "assistant") {
      assistantParts.push(message.content);
    } else if (message.type === "error") {
      lastError = message.errorDetail ?? message.message;
    } else if (message.type === "result") {
      terminalResult = message;
    }
  }

  if (!terminalResult) {
    throw new Error(lastError ?? "Session stream ended without a result message");
  }

  if (!terminalResult.success) {
    throw new Error(
      lastError ??
        terminalResult.errorDetail ??
        terminalResult.error ??
        "Agent turn failed",
    );
  }

  return {
    assistantText: assistantParts.join(""),
    conversationId: terminalResult.conversationId,
    runIds: terminalResult.runIds ?? [],
  };
}

async function markJobComplete(result: CompletedTurn) {
  console.log(`assistant: ${result.assistantText}`);
  console.log(`conversation: ${result.conversationId ?? "unknown"}`);
  console.log(`runs: ${result.runIds.join(", ") || "not reported"}`);
}

const result = await runAgentTurn(
  agentId,
  "Reply with exactly: migration example complete",
);
await markJobComplete(result);
