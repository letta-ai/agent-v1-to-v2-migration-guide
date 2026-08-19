# Async messages migration: runs to Agent SDK sessions

This guide migrates background turns from the deprecated V1 async messages API to [`@letta-ai/letta-agent-sdk`](https://docs.letta.com/agent-sdk/).

The Agent SDK is the supported application interface. It is currently available for TypeScript only.

## What changed

| V1 async messages | Agent SDK sessions |
| --- | --- |
| `client.agents.messages.createAsync(...)` starts a run. | `session.send(...)` starts a turn. |
| The application polls `client.runs.retrieve(...)`. | The application consumes `session.stream()` until a `result` message arrives. |
| `callback_url` asks the API to call an external endpoint. | Application code handles completion after the terminal `result` message. |
| The application handles API messages, run state, and transport details. | The SDK returns normalized assistant, tool, error, retry, and result messages. |
| The request targets an agent's implicit conversation. | `resumeSession(agentId)` uses the default conversation. `createSession(agentId)` starts a new conversation. |
| The server owns a background run. | The application owns the session and its worker lifecycle. |

The Agent SDK does not replace your job queue. Run each long turn in an application worker. Keep the worker alive until the stream returns a terminal `result` message.

## Preferred migration

`v2_example.ts` shows the complete lifecycle:

1. Select an existing agent.
2. Resume its default conversation.
3. Send one user turn.
4. Consume assistant and error messages.
5. Check the terminal `result` message.
6. Run application completion logic.
7. Dispose the session and its managed sandbox.

Use `createSession(agentId)` instead of `resumeSession(agentId)` when the task needs a new conversation.

### Replace polling

V1 code polls a run until it reaches a terminal state:

```typescript
const run = await client.agents.messages.createAsync(agentId, {
  input: prompt,
});

let current = run;
while (current.status === "created" || current.status === "running") {
  await delay(1_000);
  current = await client.runs.retrieve(run.id);
}
```

Agent SDK code consumes one typed stream:

```typescript
await session.send(prompt);
let lastError: string | undefined;

for await (const message of session.stream()) {
  if (message.type === "assistant") {
    process.stdout.write(message.content);
  }

  if (message.type === "error") {
    lastError = message.errorDetail ?? message.message;
  }

  if (message.type === "result" && !message.success) {
    throw new Error(
      lastError ?? message.errorDetail ?? message.error ?? "Agent turn failed",
    );
  }
}
```

### Replace callbacks

The Agent SDK does not accept the V1 `callback_url` field. Call your completion code after the terminal `result` message:

```typescript
const result = await runAgentTurn(agentId, prompt);
await markJobComplete(result);
```

If another service needs a webhook, send it from `markJobComplete`. Keep retry and delivery policy in your application.

If the application cancels the work, call `await session.abort()` before you dispose the session.

## Setup

Requirements:

- Node.js 22.19 or later
- A `LETTA_API_KEY`

```bash
cd async-messages
npm install
export LETTA_API_KEY="your-key"
export EXISTING_AGENT_ID="agent-id"
```

## Run the Agent SDK example

```bash
npm run check
npm run v2
```

The example resumes the existing agent's default conversation and runs one turn. It closes the session and requests termination of its managed sandbox. It does not delete the agent.

`v1_example.ts` preserves the old polling flow for comparison. Do not run it unless you must test a V1 integration before the endpoint retires.

## Temporary raw compatibility bridge

> **Use this only while you migrate an existing integration to the Agent SDK. Do not build new applications on the raw endpoint.**

If you cannot move to TypeScript immediately, the unified V1 message endpoint can run a background stream:

```bash
curl -N https://api.letta.com/v1/agents/$AGENT_ID/messages \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Your message",
    "streaming": true,
    "background": true
  }'
```

Both fields must be `true`. The response is a Server-Sent Events stream. Save `run_id` and `seq_id` from JSON stream events when you need replay or reconnection. Terminal frames such as `[DONE]` are not JSON events.

This compatibility request does not support `callback_url`. It also does not preserve the old run-object response.

Do not use `POST /v1/agents/{agent_id}/messages/stream`. That alias is deprecated.

See the [Create Message API reference](https://docs.letta.com/api/resources/agents/subresources/messages/methods/create/) for the request contract.
