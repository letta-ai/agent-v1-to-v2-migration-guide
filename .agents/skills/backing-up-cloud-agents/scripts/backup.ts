import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
type Json = Record<string, any>;
const RESTORED_FIELDS = [
	"description",
	"system",
	"model_settings",
	"compaction_settings",
	"response_format",
	"timezone",
	"max_files_open",
	"per_file_view_window_char_limit",
] as const;
const OMITTED_FIELDS = [
	"secrets",
	"tool_exec_environment_variables",
	"memory_variables",
];

export interface Cloud {
	baseUrl: string;
	request(method: string, path: string, body?: Json): Promise<any>;
	memoryUrl(agentId: string): string;
	gitEnv(): NodeJS.ProcessEnv;
}

export class CloudApi implements Cloud {
	readonly baseUrl: string;
	constructor(
		baseUrl: string,
		private apiKey: string,
	) {
		const url = new URL(baseUrl);
		if (
			url.protocol !== "https:" &&
			!(
				url.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
			)
		) {
			throw new Error("Use HTTPS, or HTTP on localhost for tests.");
		}
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!["/", ""].includes(url.pathname)
		) {
			throw new Error(
				"Base URL must be an origin, without credentials, path, or query.",
			);
		}
		this.baseUrl = url.origin;
	}
	async request(method: string, path: string, body?: Json) {
		if (!this.apiKey)
			throw new Error("Set LETTA_API_KEY for the selected Cloud account.");
		const response = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
				"X-Letta-Memfs-Backend": "hosted",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(60_000),
			redirect: "error",
		});
		// Error bodies can contain message content or credentials. Do not print them.
		if (!response.ok)
			throw new Error(`${method} ${path}: HTTP ${response.status}`);
		return response.json();
	}
	memoryUrl(agentId: string) {
		checkAgentId(agentId);
		return `${this.baseUrl}/v1/git/${agentId}/state.git`;
	}
	gitEnv() {
		if (!this.apiKey)
			throw new Error("Set LETTA_API_KEY for the selected Cloud account.");
		// Pass authorization through the process environment, never URLs/config files.
		return {
			GIT_CONFIG_COUNT: "3",
			GIT_CONFIG_KEY_0: `http.${this.baseUrl}/.extraHeader`,
			GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`letta:${this.apiKey}`).toString("base64")}`,
			GIT_CONFIG_KEY_1: "credential.helper",
			GIT_CONFIG_VALUE_1: "",
			GIT_CONFIG_KEY_2: `http.${this.baseUrl}/.extraHeader`,
			GIT_CONFIG_VALUE_2: "X-Letta-Memfs-Backend: hosted",
		};
	}
}

function checkAgentId(id: string) {
	if (!/^agent-[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid agent ID.");
}

export async function git(args: string[], env: NodeJS.ProcessEnv = {}) {
	try {
		const { stdout } = await execute(
			"git",
			["-c", "http.followRedirects=false", ...args],
			{
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
				timeout: 120_000,
				maxBuffer: 16 * 1024 * 1024,
			},
		);
		return stdout.trim();
	} catch {
		const operation = args[0] === "-C" ? args[2] : args[0];
		throw new Error(
			`Git ${operation} failed or timed out. Check repository access and connectivity; no credential-bearing stderr was printed.`,
		);
	}
}

function digest(text: string) {
	return createHash("sha256").update(text).digest("hex");
}

export function backupState(state: Json): Json {
	const result = { ...state };
	for (const key of OMITTED_FIELDS) delete result[key];
	return result;
}

function contextIds(state: Json): string[] {
	if (
		!Array.isArray(state.message_ids) ||
		state.message_ids.some(
			(id: unknown) =>
				typeof id !== "string" || !/^message-[a-zA-Z0-9-]+$/.test(id),
		)
	) {
		throw new Error(
			"Agent has no valid main-chat message_ids list; refusing to substitute recent history.",
		);
	}
	if (new Set(state.message_ids).size !== state.message_ids.length)
		throw new Error("Duplicate context message IDs.");
	return state.message_ids;
}

async function remoteHead(cloud: Cloud, agentId: string) {
	const output = await git(
		["ls-remote", cloud.memoryUrl(agentId), "refs/heads/main"],
		cloud.gitEnv(),
	);
	const sha = output.split(/\s+/)[0];
	if (!/^[0-9a-f]{40,64}$/.test(sha))
		throw new Error(
			"Memory repository has no main branch. No block-to-Git conversion was attempted.",
		);
	return sha;
}

export async function exportAgent(
	cloud: Cloud,
	agentId: string,
	destination: string,
) {
	checkAgentId(agentId);
	const folder = resolve(destination);
	const state = backupState(
		await cloud.request("GET", `/v1/agents/${agentId}`),
	);
	if (state.id !== agentId)
		throw new Error("Retrieved agent ID differs from requested agent.");
	const ids = contextIds(state);
	await mkdir(dirname(folder), { recursive: true });
	// Exclusive mkdir refuses every existing output, including partial backups.
	await mkdir(folder, { mode: 0o700 });
	try {
		const before = await remoteHead(cloud, agentId);
		const memory = join(folder, "memory");
		await git(
			[
				"clone",
				"--single-branch",
				"--branch",
				"main",
				"--no-tags",
				"--no-local",
				cloud.memoryUrl(agentId),
				memory,
			],
			cloud.gitEnv(),
		);
		await git([
			"-C",
			memory,
			"update-ref",
			"--no-deref",
			"-d",
			"refs/remotes/origin/HEAD",
		]);
		await git(["-C", memory, "remote", "remove", "origin"]);
		const head = await git(["-C", memory, "rev-parse", "HEAD"]);
		const messages: Json[] = [];
		for (const id of ids) {
			const variants = await cloud.request("GET", `/v1/messages/${id}`);
			if (
				!Array.isArray(variants) ||
				variants.length === 0 ||
				variants.some((m: Json) => m.id !== id)
			) {
				throw new Error(`Missing or mismatched context message: ${id}`);
			}
			// One stored message may produce several API variants. Keep all of them,
			// exactly as returned, grouped under its source ID, in context-ID order.
			messages.push({ id, messages: variants });
		}
		const afterState = backupState(
			await cloud.request("GET", `/v1/agents/${agentId}`),
		);
		const after = await remoteHead(cloud, agentId);
		if (
			before !== head ||
			head !== after ||
			JSON.stringify(state) !== JSON.stringify(afterState)
		) {
			throw new Error(
				"Agent state or committed memory changed during export. Pause the agent and retry.",
			);
		}
		const agentJson = `${JSON.stringify(state, null, 2)}\n`;
		const messagesJson = `${JSON.stringify(messages, null, 2)}\n`;
		await writeFile(join(folder, "agent.json"), agentJson, { mode: 0o600 });
		await writeFile(join(folder, "messages.json"), messagesJson, {
			mode: 0o600,
		});
		const manifest = {
			format: "letta-cloud-agent-backup",
			version: 1,
			exported_at: new Date().toISOString(),
			source_url: cloud.baseUrl,
			source_agent_id: agentId,
			conversation_id: "default",
			message_ids: ids,
			memory_commit: head,
			memory_tree: await git(["-C", memory, "rev-parse", "HEAD^{tree}"]),
			sha256: {
				"agent.json": digest(agentJson),
				"messages.json": digest(messagesJson),
			},
			omitted_agent_fields: OMITTED_FIELDS,
			messages_restored: false,
		};
		// A manifest is written only after a complete, stable capture.
		await writeFile(
			join(folder, "manifest.json"),
			`${JSON.stringify(manifest, null, 2)}\n`,
			{ mode: 0o600 },
		);
		return {
			folder,
			agent_id: agentId,
			context_messages: ids.length,
			memory_commit: head,
		};
	} catch (error) {
		await rm(folder, { recursive: true, force: true });
		throw error;
	}
}

export async function readBackup(folder: string) {
	folder = resolve(folder);
	const manifest = JSON.parse(
		await readFile(join(folder, "manifest.json"), "utf8"),
	);
	if (
		manifest.format !== "letta-cloud-agent-backup" ||
		manifest.version !== 1 ||
		manifest.conversation_id !== "default"
	) {
		throw new Error("Unsupported backup format or conversation scope.");
	}
	checkAgentId(manifest.source_agent_id);
	const agentJson = await readFile(join(folder, "agent.json"), "utf8");
	const messagesJson = await readFile(join(folder, "messages.json"), "utf8");
	if (
		manifest.sha256?.["agent.json"] !== digest(agentJson) ||
		manifest.sha256?.["messages.json"] !== digest(messagesJson)
	) {
		throw new Error("Backup JSON checksum mismatch.");
	}
	const agent: Json = JSON.parse(agentJson);
	const messages = JSON.parse(messagesJson);
	if (
		agent.id !== manifest.source_agent_id ||
		JSON.stringify(contextIds(agent)) !==
			JSON.stringify(manifest.message_ids) ||
		!Array.isArray(messages) ||
		JSON.stringify(messages.map((m: Json) => m.id)) !==
			JSON.stringify(manifest.message_ids)
	) {
		throw new Error(
			"Backup message IDs or agent identity do not match the manifest.",
		);
	}
	const memory = join(folder, "memory");
	if (
		(await git(["-C", memory, "rev-parse", "HEAD"])) !==
			manifest.memory_commit ||
		(await git(["-C", memory, "rev-parse", "HEAD^{tree}"])) !==
			manifest.memory_tree
	) {
		throw new Error("Memory commit/tree differs from the backup manifest.");
	}
	if (
		await git([
			"-C",
			memory,
			"status",
			"--porcelain",
			"--untracked-files=normal",
		])
	) {
		throw new Error(
			"Backup memory has uncommitted changes; restore only a verified committed snapshot.",
		);
	}
	await git(["-C", memory, "fsck", "--full", "--no-dangling"]);
	return { manifest, agent, memory };
}

export function createBody(
	agent: Json,
	options: { name?: string; model?: string },
): Json {
	const model = options.model ?? agent.model;
	if (typeof model !== "string" || !model.includes("/"))
		throw new Error(
			"Supply --model with a model handle available in the destination account.",
		);
	const body: Json = {
		name: options.name ?? `${agent.name || "Agent"} (restored)`,
		model,
		tags: ["origin:letta-code", "git-memory-enabled"],
		initial_message_sequence: [],
	};
	for (const field of RESTORED_FIELDS) {
		if (agent[field] !== null && agent[field] !== undefined)
			body[field] = agent[field];
	}
	// A different provider/model must use its own defaults, not the source's tuning.
	if (options.model && options.model !== agent.model)
		delete body.model_settings;
	const window = agent.llm_config?.context_window;
	if (!options.model && Number.isInteger(window) && window > 0)
		body.context_window_limit = window;
	return body;
}

export async function restoreAgent(
	cloud: Cloud,
	folder: string,
	options: { name?: string; model?: string; apply?: boolean } = {},
) {
	const { manifest, agent, memory } = await readBackup(folder);
	const body = createBody(agent, options);
	const report: Json = {
		source_agent_id: agent.id,
		destination_url: cloud.baseUrl,
		name: body.name,
		model: body.model,
		context_messages_in_backup: manifest.message_ids.length,
		messages_restored: 0,
		memory_commit: manifest.memory_commit,
		restored_settings: Object.keys(body).filter(
			(key) => key !== "initial_message_sequence",
		),
		excluded: [
			"message history",
			"secrets",
			"tools",
			"connections",
			"shared repositories",
			"source metadata and tags",
			"schedules",
			"archival memory",
		],
	};
	if (!options.apply) return { ...report, dry_run: true };
	const created = await cloud.request("POST", "/v1/agents", body);
	checkAgentId(created.id);
	if (created.id === agent.id)
		throw new Error(
			"Server returned the source ID; refusing to touch its memory.",
		);
	const newId = created.id;
	// Print the new ID before any follow-up can fail. Never retry creation
	// automatically: a timed-out POST may already have created an agent.
	console.error(
		`Created ${newId}. Restoring memory; do not start this agent yet.`,
	);
	const temp = await mkdtemp(join(tmpdir(), "letta-restore-"));
	try {
		const target = join(temp, "memory");
		await git(
			[
				"clone",
				"--single-branch",
				"--branch",
				"main",
				"--no-tags",
				cloud.memoryUrl(newId),
				target,
			],
			cloud.gitEnv(),
		);
		const initial = await git(["-C", target, "rev-parse", "HEAD"]);
		await git(["-C", target, "fetch", "--no-tags", memory, "HEAD"]);
		const imported = await git(["-C", target, "rev-parse", "FETCH_HEAD"]);
		if (imported !== manifest.memory_commit)
			throw new Error("Fetched backup revision differs from manifest.");
		// Keep both histories while taking exactly the backup tree. The destination
		// seed is a parent, so this is a normal fast-forward push, never a force push.
		const commit = await git(
			[
				"-C",
				target,
				"commit-tree",
				manifest.memory_tree,
				"-p",
				initial,
				"-p",
				imported,
				"-m",
				"Restore agent memory from backup",
			],
			{
				GIT_AUTHOR_NAME: "Letta backup restore",
				GIT_AUTHOR_EMAIL: "noreply@letta.com",
				GIT_COMMITTER_NAME: "Letta backup restore",
				GIT_COMMITTER_EMAIL: "noreply@letta.com",
			},
		);
		await git(
			["-C", target, "push", "origin", `${commit}:refs/heads/main`],
			cloud.gitEnv(),
		);
		if ((await remoteHead(cloud, newId)) !== commit)
			throw new Error("Destination memory changed during restore.");
		await cloud.request("POST", `/v1/agents/${newId}/recompile`, {});
		const restored = await cloud.request("GET", `/v1/agents/${newId}`);
		if (restored.id !== newId) throw new Error("Restored agent ID mismatch.");
		for (const id of contextIds(restored)) {
			const variants = await cloud.request("GET", `/v1/messages/${id}`);
			if (
				!Array.isArray(variants) ||
				variants.length === 0 ||
				variants.some(
					(m: Json) => m.id !== id || m.message_type !== "system_message",
				)
			) {
				throw new Error(
					"Destination chat is no longer empty. Do not run concurrent turns during restore.",
				);
			}
		}
		return {
			...report,
			dry_run: false,
			agent_id: newId,
			memory_commit: commit,
			memory_tree: manifest.memory_tree,
		};
	} catch (error) {
		throw new Error(
			`Restore incomplete for ${newId}; the source and backup are unchanged. Inspect this new agent before retrying. ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}
