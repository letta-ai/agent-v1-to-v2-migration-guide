import { parseArgs } from "node:util";
import { CloudApi, exportAgent, restoreAgent } from "./backup";

const HELP = `Cloud agent backup (requires Bun and Git)

Export main-chat in-context messages, agent state, and committed Git memory:
  bun cloud-agent.ts export --agent agent-... --out /private/path/backup

Preview a fresh Cloud restore (no API writes):
  bun cloud-agent.ts import --from /private/path/backup [--name Name] [--model provider/model]

Restore settings and memory, with an EMPTY chat:
  bun cloud-agent.ts import --from /private/path/backup --apply

Set LETTA_API_KEY for the source or destination account respectively.
--base-url defaults to LETTA_BASE_URL or https://api.letta.com.
Import NEVER restores messages, credentials, connections, or shared repositories.
`;

async function main() {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		strict: true,
		allowPositionals: true,
		options: {
			agent: { type: "string" },
			out: { type: "string" },
			from: { type: "string" },
			name: { type: "string" },
			model: { type: "string" },
			"base-url": { type: "string" },
			apply: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) {
		console.log(HELP);
		return;
	}
	const command = positionals[0];
	if (positionals.length !== 1 || !["export", "import"].includes(command ?? ""))
		throw new Error(HELP);
	if (
		command === "export" &&
		(!values.agent ||
			!values.out ||
			values.from ||
			values.apply ||
			values.name ||
			values.model)
	)
		throw new Error(
			"Export requires --agent and --out; import-only flags are not allowed.",
		);
	if (command === "import" && (!values.from || values.agent || values.out))
		throw new Error(
			"Import requires --from; --agent and --out are not allowed.",
		);
	const client = new CloudApi(
		values["base-url"] ?? process.env.LETTA_BASE_URL ?? "https://api.letta.com",
		process.env.LETTA_API_KEY ?? "",
	);
	const result =
		command === "export"
			? await exportAgent(client, values.agent!, values.out!)
			: await restoreAgent(client, values.from!, {
					name: values.name,
					model: values.model,
					apply: values.apply,
				});
	console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
	console.error(
		error instanceof Error ? error.message : "Backup operation failed.",
	);
	process.exitCode = 1;
});
