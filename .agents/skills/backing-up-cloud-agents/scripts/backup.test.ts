import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CloudApi,
	type Cloud,
	createBody,
	exportAgent,
	git,
	readBackup,
	restoreAgent,
} from "./backup";

const cleanup: string[] = [];
afterEach(async () => {
	await Promise.all(
		cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});
const author = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "cloud-backup-test-"));
	cleanup.push(root);
	const source = join(root, "source");
	const destination = join(root, "destination.git");
	await git(["init", "--initial-branch=main", source]);
	await writeFile(
		join(source, "MEMORY.md"),
		"# Memory\n\nAn earlier memory.\n",
	);
	await git(["-C", source, "add", "MEMORY.md"]);
	await git(["-C", source, "commit", "-m", "First memory"], author);
	const first = await git(["-C", source, "rev-parse", "HEAD"]);
	await writeFile(join(source, "MEMORY.md"), "# Memory\n\nCurrent memory.\n");
	await writeFile(join(source, "profile.png"), Buffer.from([0, 1, 2, 255]));
	await git(["-C", source, "add", "MEMORY.md", "profile.png"]);
	await git(["-C", source, "commit", "-m", "Current memory"], author);
	const sourceHead = await git(["-C", source, "rev-parse", "HEAD"]);
	await git(["init", "--bare", "--initial-branch=main", destination]);
	const seed = join(root, "seed");
	await git(["init", "--initial-branch=main", seed]);
	await writeFile(
		join(seed, "default.md"),
		"Destination default, must not survive restore.\n",
	);
	await git(["-C", seed, "add", "default.md"]);
	await git(["-C", seed, "commit", "-m", "Destination seed"], author);
	await git(["-C", seed, "push", destination, "main"]);
	const seedHead = await git(["-C", seed, "rev-parse", "HEAD"]);
	const state: Record<string, any> = {
		id: "agent-source",
		name: "Original",
		system: "Raw prompt template.",
		model: "provider/model",
		message_ids: ["message-system", "message-user", "message-tool"],
		secrets: [{ key: "SECRET", value: "not-for-backup" }],
		tool_exec_environment_variables: [{ value: "also-private" }],
		tags: ["subagent"],
		metadata_: { parent_agent_id: "agent-parent" },
		model_settings: { temperature: 0.7 },
		llm_config: { context_window: 8192 },
	};
	const requests: Array<{ method: string; path: string; body?: any }> = [];
	const cloud: Cloud = {
		baseUrl: "https://api.example.com",
		gitEnv: () => ({}),
		memoryUrl: (id) => (id === "agent-source" ? source : destination),
		async request(method, path, body) {
			requests.push({ method, path, body });
			if (method === "POST" && path === "/v1/agents")
				return { id: "agent-restored" };
			if (path.endsWith("/recompile")) return "Compiled for the new agent.";
			if (path === "/v1/agents/agent-source") return structuredClone(state);
			if (path === "/v1/agents/agent-restored")
				return { id: "agent-restored", message_ids: ["message-new-system"] };
			const id = path.split("/").at(-1);
			if (id === "message-system" || id === "message-new-system")
				return [
					{ id, message_type: "system_message", content: "Compiled prompt." },
				];
			if (id === "message-user")
				return [
					{ id, message_type: "user_message", content: "Remember this." },
				];
			if (id === "message-tool")
				return [
					{
						id,
						message_type: "tool_call_message",
						tool_calls: [
							{ tool_call_id: "call-1", name: "Read", arguments: "{}" },
						],
					},
					{
						id,
						message_type: "reasoning_message",
						reasoning: "Inspect the file.",
					},
				];
			throw new Error(`Unexpected request ${method} ${path}`);
		},
	};
	return {
		root,
		source,
		destination,
		state,
		requests,
		cloud,
		first,
		sourceHead,
		seedHead,
		backup: join(root, "backup"),
	};
}

test("export reads only explicit main-chat IDs, keeps variants and Git history, strips credential fields", async () => {
	const f = await fixture();
	const report = await exportAgent(f.cloud, "agent-source", f.backup);
	expect(report.context_messages).toBe(3);
	expect(f.requests.map((r) => r.path)).toEqual([
		"/v1/agents/agent-source",
		"/v1/messages/message-system",
		"/v1/messages/message-user",
		"/v1/messages/message-tool",
		"/v1/agents/agent-source",
	]);
	const { agent, manifest } = await readBackup(f.backup);
	expect(agent.secrets).toBeUndefined();
	expect(agent.tool_exec_environment_variables).toBeUndefined();
	expect(agent.system).toBe("Raw prompt template.");
	expect(manifest.memory_commit).toBe(f.sourceHead);
	const messages = JSON.parse(
		await readFile(join(f.backup, "messages.json"), "utf8"),
	);
	expect(messages[2].messages).toHaveLength(2);
	expect(await git(["-C", join(f.backup, "memory"), "remote"])).toBe("");
	expect(
		await git(["-C", join(f.backup, "memory"), "show", `${f.first}:MEMORY.md`]),
	).toContain("earlier memory");
});

test("empty context never falls back to history; missing context fails", async () => {
	const f = await fixture();
	f.state.message_ids = [];
	await exportAgent(f.cloud, "agent-source", f.backup);
	expect(f.requests.some((r) => r.path.startsWith("/v1/messages"))).toBe(false);
	expect(
		JSON.parse(await readFile(join(f.backup, "messages.json"), "utf8")),
	).toEqual([]);
	delete f.state.message_ids;
	await expect(
		exportAgent(f.cloud, "agent-source", join(f.root, "missing")),
	).rejects.toThrow("message_ids");
});

test("restore preview makes no API calls; apply restores exact tree and both histories, never messages", async () => {
	const f = await fixture();
	await exportAgent(f.cloud, "agent-source", f.backup);
	f.requests.length = 0;
	const preview = await restoreAgent(f.cloud, f.backup);
	expect(preview.dry_run).toBe(true);
	expect(f.requests).toEqual([]);
	const result = await restoreAgent(f.cloud, f.backup, { apply: true });
	const create = f.requests.find((r) => r.path === "/v1/agents")!;
	expect(create.body.initial_message_sequence).toEqual([]);
	expect(create.body.secrets).toBeUndefined();
	expect(create.body.metadata_).toBeUndefined();
	expect(create.body.tags).not.toContain("subagent");
	expect(
		f.requests.filter((r) => r.method !== "GET").map((r) => r.path),
	).toEqual(["/v1/agents", "/v1/agents/agent-restored/recompile"]);
	expect(result.messages_restored).toBe(0);
	expect(result.memory_tree).toBe(
		await git(["-C", f.destination, "rev-parse", "main^{tree}"]),
	);
	expect(
		await git(["-C", f.destination, "merge-base", "main", f.sourceHead]),
	).toBe(f.sourceHead);
	expect(
		await git(["-C", f.destination, "merge-base", "main", f.seedHead]),
	).toBe(f.seedHead);
	expect(
		await git(["-C", f.destination, "ls-tree", "--name-only", "main"]),
	).not.toContain("default.md");
	expect(await git(["-C", f.source, "rev-parse", "HEAD"])).toBe(f.sourceHead);
});

test("model override drops provider-specific settings", () => {
	const body = createBody(
		{
			name: "Test",
			model: "a/b",
			model_settings: { temperature: 1 },
			llm_config: { context_window: 8192 },
		},
		{ model: "c/d" },
	);
	expect(body.model_settings).toBeUndefined();
	expect(body.context_window_limit).toBeUndefined();
});

test("existing backups and corrupt or dirty backups are refused before restore writes", async () => {
	const f = await fixture();
	await exportAgent(f.cloud, "agent-source", f.backup);
	await expect(
		exportAgent(f.cloud, "agent-source", f.backup),
	).rejects.toThrow();
	await readBackup(f.backup);
	await writeFile(join(f.backup, "memory", "MEMORY.md"), "Uncommitted changes");
	await expect(
		restoreAgent(f.cloud, f.backup, { apply: true }),
	).rejects.toThrow("uncommitted");
	await writeFile(join(f.backup, "agent.json"), "{}");
	await expect(
		restoreAgent(f.cloud, f.backup, { apply: true }),
	).rejects.toThrow("checksum");
	expect(f.requests.every((r) => r.method === "GET")).toBe(true);
});

test("changing source context aborts export and removes only its incomplete output", async () => {
	const f = await fixture();
	const request = f.cloud.request;
	f.cloud.request = async (method, path, body) => {
		const value = await request(method, path, body);
		if (path === "/v1/messages/message-user") f.state.message_ids = [];
		return value;
	};
	await expect(exportAgent(f.cloud, "agent-source", f.backup)).rejects.toThrow(
		"changed during export",
	);
	await expect(readFile(join(f.backup, "manifest.json"))).rejects.toThrow();
	expect(await git(["-C", f.source, "rev-parse", "HEAD"])).toBe(f.sourceHead);
});

test("partial restore reports the new ID and never deletes or retries creation", async () => {
	const f = await fixture();
	await exportAgent(f.cloud, "agent-source", f.backup);
	const request = f.cloud.request;
	f.cloud.request = async (method, path, body) => {
		if (path.endsWith("/recompile")) throw new Error("HTTP 503");
		return request(method, path, body);
	};
	await expect(
		restoreAgent(f.cloud, f.backup, { apply: true }),
	).rejects.toThrow("Restore incomplete for agent-restored");
	expect(
		f.requests.filter((r) => r.method === "POST" && r.path === "/v1/agents"),
	).toHaveLength(1);
	expect(f.requests.some((r) => r.method === "DELETE")).toBe(false);
});

test("API auth is not embedded in URLs; remote plaintext origins are rejected", () => {
	const api = new CloudApi("https://api.example.com", "private-key");
	expect(api.memoryUrl("agent-source")).toBe(
		"https://api.example.com/v1/git/agent-source/state.git",
	);
	expect(api.gitEnv().GIT_CONFIG_VALUE_0).toBe(
		`Authorization: Basic ${Buffer.from("letta:private-key").toString("base64")}`,
	);
	expect(() => new CloudApi("http://api.example.com", "key")).toThrow("HTTPS");
	expect(
		() => new CloudApi("https://user:password@api.example.com", "key"),
	).toThrow("credentials");
});

test("missing context messages fail rather than silently making a partial backup", async () => {
	const f = await fixture();
	const request = f.cloud.request;
	f.cloud.request = async (method, path, body) =>
		path === "/v1/messages/message-user" ? [] : request(method, path, body);
	await expect(exportAgent(f.cloud, "agent-source", f.backup)).rejects.toThrow(
		"Missing or mismatched context message",
	);
	await expect(readFile(join(f.backup, "manifest.json"))).rejects.toThrow();
});

test("a concurrent memory commit invalidates an otherwise unchanged context capture", async () => {
	const f = await fixture();
	const request = f.cloud.request;
	f.cloud.request = async (method, path, body) => {
		if (path === "/v1/messages/message-user") {
			await writeFile(
				join(f.source, "MEMORY.md"),
				"Concurrent memory change\n",
			);
			await git(["-C", f.source, "add", "MEMORY.md"]);
			await git(["-C", f.source, "commit", "-m", "Concurrent change"], author);
		}
		return request(method, path, body);
	};
	await expect(exportAgent(f.cloud, "agent-source", f.backup)).rejects.toThrow(
		"changed during export",
	);
	await expect(readFile(join(f.backup, "manifest.json"))).rejects.toThrow();
	expect(await readFile(join(f.source, "MEMORY.md"), "utf8")).toBe(
		"Concurrent memory change\n",
	);
});
