import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { McpTool, McpToolResult } from "../src/extensions/mcp-server/tools.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
// --import takes a module specifier, not a filesystem path.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
/** A built executable to test instead of the sources, such as Pi-Bolt's `out/pi-bolt/pi`. */
const executable = process.env.PI_MCP_TEST_EXECUTABLE;

// ============================================================================
// A fake OpenAI-compatible model: the last user message picks a script, one step per model turn.
// ============================================================================

type Step = { text?: string; tool?: { name: string; args: Record<string, unknown> }; hang?: boolean };

const SCRIPTS: Record<string, Step[]> = {
	tools: [
		{ text: "Writing. ", tool: { name: "write", args: { path: "notes.txt", content: "alpha\n" } } },
		{ tool: { name: "bash", args: { command: "echo from-bash" } } },
		{ text: "All done.\nSecond line." },
	],
	hello: [{ text: "Hello from the fake model." }],
	live: [
		{ tool: { name: "bash", args: { command: "echo first; sleep 1.5; echo second; sleep 5.5" } } },
		{ text: "Ran it." },
	],
	slow: [{ hang: true }],
};

/** The model, token cap, and user messages of the requests the fake model got. */
const requests: { model: string; max_tokens?: number; reasoning_effort?: string; users: string[] }[] = [];

function sse(delta: Record<string, unknown>, finish: string | null = null): string {
	return `data: ${JSON.stringify({
		id: "fake",
		object: "chat.completion.chunk",
		model: "fake-model",
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`;
}

function startFakeModel(): Promise<Server> {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			if (req.method !== "POST") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
				return;
			}
			const request = JSON.parse(body || "{}") as {
				model: string;
				max_tokens?: number;
				max_completion_tokens?: number;
				reasoning_effort?: string;
				messages?: Array<{ role: string; content: unknown }>;
			};
			let turn = 0;
			let prompt = "";
			const users: string[] = [];
			for (const message of request.messages ?? []) {
				if (message.role === "user") {
					turn = 0;
					prompt =
						typeof message.content === "string"
							? message.content
							: (message.content as { text?: string }[]).map((part) => part.text ?? "").join("");
					users.push(prompt);
				} else if (message.role === "tool") {
					turn++;
				}
			}
			requests.push({
				model: request.model,
				max_tokens: request.max_tokens ?? request.max_completion_tokens,
				reasoning_effort: request.reasoning_effort,
				users,
			});
			const script = SCRIPTS[Object.keys(SCRIPTS).find((name) => prompt.includes(`[${name}]`)) ?? "hello"];
			const step = script[Math.min(turn, script.length - 1)];
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(sse({ role: "assistant", content: "" }));
			if (step.hang) return; // Never answers: the client cancels.
			if (step.text) res.write(sse({ content: step.text }));
			if (step.tool) {
				res.write(
					sse({
						tool_calls: [
							{
								index: 0,
								id: `call_${turn}`,
								type: "function",
								function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) },
							},
						],
					}),
				);
				res.write(sse({}, "tool_calls"));
			} else {
				res.write(sse({}, "stop"));
			}
			res.write(
				`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", model: "fake-model", choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\n`,
			);
			res.end("data: [DONE]\n\n");
		});
	});
	return new Promise((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise(server)));
}

// ============================================================================
// A minimal MCP client over the child's stdio
// ============================================================================

type Message = {
	jsonrpc: "2.0";
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
};

type PromptResult = McpToolResult & {
	structuredContent: { sessionId: string; text: string; stopReason: string; usage?: Record<string, number> };
};

class McpTestClient {
	readonly child: ChildProcessWithoutNullStreams;
	readonly notifications: Message[] = [];
	readonly serverRequests: Message[] = [];
	readonly responses: Message[] = [];
	stderr = "";
	private buffer = "";
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (m: Message) => void }>();
	/** Answers the server's requests (elicitation). */
	onRequest: (message: Message) => unknown = () => ({ action: "decline" });

	constructor(cwd: string, agentDir: string, args: string[] = []) {
		const command = executable
			? { file: executable, args: ["--mcp", ...args] }
			: { file: process.execPath, args: ["--import", sourceResolverUrl, cliPath, "--mcp", ...args] };
		this.child = spawn(command.file, command.args, {
			cwd,
			env: { ...process.env, [ENV_AGENT_DIR]: agentDir, PI_OFFLINE: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => {
			this.buffer += chunk;
			for (let index = this.buffer.indexOf("\n"); index !== -1; index = this.buffer.indexOf("\n")) {
				const line = this.buffer.slice(0, index);
				this.buffer = this.buffer.slice(index + 1);
				if (line.trim()) this.handle(JSON.parse(line) as Message);
			}
		});
		this.child.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString();
		});
	}

	private handle(message: Message): void {
		if (message.method && message.id !== undefined) {
			this.serverRequests.push(message);
			this.write({ jsonrpc: "2.0", id: message.id, result: this.onRequest(message) });
		} else if (message.method) {
			this.notifications.push(message);
		} else if (message.id !== undefined) {
			this.responses.push(message);
			this.pending.get(message.id)?.resolve(message);
			this.pending.delete(message.id);
		}
	}

	private write(message: Message): void {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	/** Sends a request; returns its id and the response to come. */
	send(method: string, params: unknown): { id: number; response: Promise<Message> } {
		const id = this.nextId++;
		const response = new Promise<Message>((resolvePromise) => {
			this.pending.set(id, { resolve: resolvePromise });
		});
		this.write({ jsonrpc: "2.0", id, method, params });
		return { id, response };
	}

	async request<T>(method: string, params: unknown): Promise<T> {
		const response = await this.send(method, params).response;
		if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}\n${this.stderr}`);
		return response.result as T;
	}

	notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	call(args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<PromptResult> {
		return this.request<PromptResult>("tools/call", {
			name: "prompt",
			arguments: args,
			...(meta ? { _meta: meta } : {}),
		});
	}

	async waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error(`timed out\n${this.stderr}`);
			await new Promise((r) => setTimeout(r, 20));
		}
	}

	async stop(): Promise<number | null> {
		this.child.stdin.end();
		return new Promise((resolvePromise) => {
			if (this.child.exitCode !== null) resolvePromise(this.child.exitCode);
			else this.child.once("exit", (code) => resolvePromise(code));
		});
	}
}

function readSessionEntries(sessionDir: string, sessionId: string): Array<Record<string, unknown>> {
	const file = readdirSync(sessionDir).find((name) => name.endsWith(`_${sessionId}.jsonl`));
	if (!file) throw new Error(`Session file not found for ${sessionId} in ${sessionDir}`);
	return readFileSync(join(sessionDir, file), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("MCP mode", () => {
	let server: Server;
	let root: string;
	let agentDir: string;
	let projectDir: string;
	const clients: McpTestClient[] = [];

	const startClient = async (args: string[] = [], capabilities: object = {}) => {
		const client = new McpTestClient(projectDir, agentDir, args);
		clients.push(client);
		const init = await client.request<{
			protocolVersion: string;
			capabilities: Record<string, unknown>;
			serverInfo: { name: string };
			instructions?: string;
		}>("initialize", {
			protocolVersion: "2025-11-25",
			capabilities,
			clientInfo: { name: "test-client", version: "1.0.0" },
		});
		client.notify("notifications/initialized", {});
		return { client, init };
	};

	beforeAll(async () => {
		server = await startFakeModel();
		const { port } = server.address() as AddressInfo;
		// (The real path: the server's working directory is, and sessions record it.)
		root = realpathSync(mkdtempSync(join(tmpdir(), "pi-mcp-")));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		const models = [
			{ id: "fake-model", contextWindow: 200000, maxTokens: 8192 },
			{ id: "other-model", contextWindow: 200000, maxTokens: 8192 },
			{ id: "thinking-model", contextWindow: 200000, maxTokens: 4096, reasoning: true },
			{ id: "small-model", contextWindow: 200000, maxTokens: 512 },
		];
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fake", models },
				},
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ lastChangelogVersion: "9999.0.0", defaultProvider: "fake", defaultModel: "fake-model" }),
		);
		writeFileSync(join(agentDir, "auth.json"), "{}");
	});

	afterEach(async () => {
		await Promise.all(clients.splice(0).map((client) => client.stop()));
	});

	afterAll(() => {
		server?.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("initializes and lists its tools", async () => {
		const { client, init } = await startClient();
		expect(init.protocolVersion).toBe("2025-11-25");
		expect(init.capabilities).toEqual({ tools: { listChanged: false } });
		// (Pi-Bolt's executable is named pi-bolt.)
		expect(["pi", "pi-bolt"]).toContain(init.serverInfo.name);
		expect(init.instructions).toContain("sessionId");
		const { tools } = await client.request<{ tools: McpTool[] }>("tools/list", {});
		expect(tools.map((tool) => tool.name)).toEqual(["prompt", "list_sessions"]);
		expect(await client.request("ping", {})).toEqual({});

		const older = new McpTestClient(projectDir, agentDir);
		clients.push(older);
		const oldInit = await older.request<{ protocolVersion: string }>("initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "old", version: "1" },
		});
		expect(oldInit.protocolVersion).toBe("2025-03-26");
		const unknown = await older.request<{ protocolVersion: string }>("initialize", {
			protocolVersion: "1999-01-01",
			capabilities: {},
			clientInfo: { name: "odd", version: "1" },
		});
		expect(unknown.protocolVersion).toBe("2025-11-25");
	});

	it("runs a prompt with progress and returns the answer and the session", async () => {
		const { client } = await startClient();
		const result = await client.call({ prompt: "[tools] please work" }, { progressToken: "p1" });
		expect(result.isError).toBeUndefined();
		expect(result.content[0]).toEqual({ type: "text", text: "All done.\nSecond line." });
		const { sessionId, stopReason, usage, text } = result.structuredContent;
		expect(text).toBe("All done.\nSecond line.");
		expect(stopReason).toBe("end_turn");
		expect(result.content[1]).toEqual({ type: "text", text: `sessionId: ${sessionId}` });
		expect(usage).toMatchObject({ inputTokens: 36, outputTokens: 9, totalTokens: 45 });
		expect(readFileSync(join(projectDir, "notes.txt"), "utf8")).toBe("alpha\n");

		const progress = client.notifications.filter((m) => m.method === "notifications/progress");
		const params = progress.map((m) => m.params as { progressToken: string; progress: number; message: string });
		expect(params.every((p) => p.progressToken === "p1")).toBe(true);
		expect(params.map((p) => p.progress)).toEqual(params.map((_, index) => index + 1));
		expect(params.map((p) => p.message).filter((message) => message !== "from-bash")).toEqual([
			"Writing.",
			"Write notes.txt",
			"echo from-bash",
			"All done.",
		]);

		// Without a progress token, no progress.
		const before = client.notifications.length;
		await client.call({ prompt: "[hello] quiet" });
		expect(client.notifications.slice(before).filter((m) => m.method === "notifications/progress")).toEqual([]);
	});

	it("reports a running command's output, and what Pi does when nothing else happens for a while", async () => {
		const { client } = await startClient();
		await client.call({ prompt: "[live] run it" }, { progressToken: 7 });
		const messages = client.notifications
			.filter((m) => m.method === "notifications/progress")
			.map((m) => (m.params as { message: string }).message);
		const command = "echo first; sleep 1.5; echo second; sleep 5.5";
		expect(messages).toEqual([command, "first", "second", command, "Ran it."]);
	});

	it("continues a session, in this process and in a new one", async () => {
		const { client } = await startClient();
		const first = await client.call({ prompt: "[hello] remember me" });
		const { sessionId } = first.structuredContent;
		const second = await client.call({ prompt: "[hello] again", sessionId });
		expect(second.structuredContent.sessionId).toBe(sessionId);
		expect(requests.at(-1)?.users).toEqual(["[hello] remember me", "[hello] again"]);
		await client.stop();

		const other = await startClient();
		const third = await other.client.call({ prompt: "[hello] once more", sessionId, cwd: projectDir });
		expect(third.structuredContent.sessionId).toBe(sessionId);
		expect(requests.at(-1)?.users).toEqual(["[hello] remember me", "[hello] again", "[hello] once more"]);

		const listed = await other.client.request<McpToolResult>("tools/call", { name: "list_sessions", arguments: {} });
		const sessions = (listed.structuredContent as { sessions: { sessionId: string; cwd: string }[] }).sessions;
		expect(sessions[0]).toMatchObject({ sessionId, cwd: projectDir });
		expect(listed.content[0].text).toContain(sessionId);

		const missing = await other.client.call({ prompt: "hi", sessionId: "no-such-session" });
		expect(missing.isError).toBe(true);
		expect(missing.content[0].text).toContain("Session not found");
	});

	it("opens a session once when two calls name it at the same time", async () => {
		const first = await startClient();
		const { sessionId } = (await first.client.call({ prompt: "[hello] start" })).structuredContent;
		await first.client.stop();

		const { client } = await startClient();
		const before = requests.length;
		await Promise.all([
			client.call({ prompt: "[hello] one", sessionId }),
			client.call({ prompt: "[hello] two", sessionId }),
		]);
		// One session: the prompt that runs second sees the first one.
		const [shorter, longer] = requests
			.slice(before)
			.map((request) => request.users)
			.sort((a, b) => a.length - b.length);
		expect(shorter).toHaveLength(2);
		expect(longer).toEqual([...shorter, longer[2]]);
		expect(new Set([shorter[1], longer[2]])).toEqual(new Set(["[hello] one", "[hello] two"]));
	});

	it("continues the old session by its id after an extension moved the open one to a new session", async () => {
		const extensionPath = join(root, "fresh-extension.ts");
		writeFileSync(
			extensionPath,
			`export default function (pi) {
	pi.registerCommand("fresh", {
		description: "Start a new session",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});
}
`,
		);
		const { client } = await startClient(["-e", extensionPath]);
		const old = (await client.call({ prompt: "[hello] old one" })).structuredContent.sessionId;
		const moved = (await client.call({ prompt: "/fresh", sessionId: old })).structuredContent.sessionId;
		expect(moved).not.toBe(old);

		const back = await client.call({ prompt: "[hello] back again", sessionId: old });
		expect(back.structuredContent.sessionId).toBe(old);
		expect(requests.at(-1)?.users).toEqual(["[hello] old one", "[hello] back again"]);
		const fresh = await client.call({ prompt: "[hello] in the new one", sessionId: moved });
		expect(fresh.structuredContent.sessionId).toBe(moved);
		expect(requests.at(-1)?.users).toEqual(["[hello] in the new one"]);
	});

	it("finds a session of another directory by its id alone when the settings name a session directory", async () => {
		const settingsAgentDir = join(root, "agent-session-dir");
		const otherDir = join(root, "other-project");
		mkdirSync(settingsAgentDir, { recursive: true });
		mkdirSync(otherDir, { recursive: true });
		for (const file of ["models.json", "auth.json"]) {
			writeFileSync(join(settingsAgentDir, file), readFileSync(join(agentDir, file)));
		}
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		writeFileSync(
			join(settingsAgentDir, "settings.json"),
			JSON.stringify({ ...settings, sessionDir: join(root, "settings-sessions") }),
		);
		const start = async () => {
			const client = new McpTestClient(projectDir, settingsAgentDir);
			clients.push(client);
			await client.request("initialize", {
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "t", version: "1" },
			});
			return client;
		};
		const first = await start();
		const { sessionId } = (await first.call({ prompt: "[hello] elsewhere", cwd: otherDir })).structuredContent;
		await first.stop();

		const second = await start();
		const again = await second.call({ prompt: "[hello] by id", sessionId });
		expect(again.isError).toBeUndefined();
		expect(requests.at(-1)?.users).toEqual(["[hello] elsewhere", "[hello] by id"]);
	});

	it("decides project trust for each new session, not once when the process started", async () => {
		const dir = join(root, "late-project");
		mkdirSync(dir, { recursive: true });
		const marker = join(root, "late-project-extension-ran");
		const client = new McpTestClient(dir, agentDir);
		clients.push(client);
		await client.request("initialize", {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "test-client", version: "1.0.0" },
		});
		expect((await client.call({ prompt: "[hello] first" })).isError).toBeUndefined();
		// The project's extension arrives after the process started (a pull, a branch switch). Nothing answered a trust
		// prompt, so it does not load.
		mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
		writeFileSync(
			join(dir, ".pi", "extensions", "marker.ts"),
			`import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(marker)}, "ran"); }\n`,
		);
		expect((await client.call({ prompt: "[hello] second" })).isError).toBeUndefined();
		expect(existsSync(marker)).toBe(false);
	});

	it("uses the model and thinking level a call names", async () => {
		const { client } = await startClient();
		const result = await client.call({ prompt: "[hello] which model", model: "fake/other-model" });
		expect(requests.at(-1)?.model).toBe("other-model");
		// The session keeps it.
		await client.call({ prompt: "[hello] still", sessionId: result.structuredContent.sessionId });
		expect(requests.at(-1)?.model).toBe("other-model");

		const unknown = await client.call({ prompt: "hi", model: "fake/nope" });
		expect(unknown.isError).toBe(true);
		expect(unknown.content[0].text).toContain("Unknown model");
		const level = await client.call({ prompt: "hi", thinking: "extreme" });
		expect(level.isError).toBe(true);
	});

	it("includes maxTokens in the prompt tool schema", async () => {
		const { client } = await startClient();
		const { tools } = await client.request<{ tools: McpTool[] }>("tools/list", {});
		const promptTool = tools.find((tool) => tool.name === "prompt");
		const properties = promptTool?.inputSchema.properties as Record<string, unknown>;
		expect(properties.maxTokens).toMatchObject({ type: "integer", minimum: 1 });
	});

	it("caps max_tokens for the session when maxTokens is given", async () => {
		const { client } = await startClient();
		const first = await client.call({ prompt: "[hello] capped", maxTokens: 256 });
		expect(first.isError).toBeUndefined();
		expect(requests.at(-1)?.max_tokens).toBe(256);

		const second = await client.call({
			prompt: "[hello] still capped",
			sessionId: first.structuredContent.sessionId,
		});
		expect(second.isError).toBeUndefined();
		expect(requests.at(-1)?.max_tokens).toBe(256);

		const raised = await client.call({
			prompt: "[hello] raised cap",
			sessionId: first.structuredContent.sessionId,
			maxTokens: 512,
		});
		expect(raised.isError).toBeUndefined();
		expect(requests.at(-1)?.max_tokens).toBe(512);
	});

	it("rejects maxTokens above the model maximum without calling the provider", async () => {
		const { client } = await startClient();
		const before = requests.length;
		const result = await client.call({ prompt: "[hello] too high", maxTokens: 500000 });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("8192");
		expect(requests).toHaveLength(before);
	});

	it("rejects non-positive or non-integer maxTokens without calling the provider", async () => {
		const { client } = await startClient();
		const before = requests.length;
		const zero = await client.call({ prompt: "[hello] zero", maxTokens: 0 });
		expect(zero.isError).toBe(true);
		const fractional = await client.call({ prompt: "[hello] fractional", maxTokens: 1.5 });
		expect(fractional.isError).toBe(true);
		expect(requests).toHaveLength(before);
	});

	it("preserves thinkingLevel and avoids model or thinking entries on maxTokens-only calls", async () => {
		const sessionDir = join(root, "sessions-max-tokens-only");
		mkdirSync(sessionDir, { recursive: true });
		const { client } = await startClient(["--session-dir", sessionDir]);

		const first = await client.call({
			prompt: "[hello] set model and thinking",
			model: "fake/thinking-model",
			thinking: "high",
		});
		expect(first.isError).toBeUndefined();
		const { sessionId } = first.structuredContent;
		expect(requests.at(-1)?.reasoning_effort).toBe("high");

		const beforeEntries = readSessionEntries(sessionDir, sessionId);
		const modelChangesBefore = beforeEntries.filter((entry) => entry.type === "model_change");
		const thinkingChangesBefore = beforeEntries.filter((entry) => entry.type === "thinking_level_change");

		const second = await client.call({
			prompt: "[hello] cap only",
			sessionId,
			maxTokens: 256,
		});
		expect(second.isError).toBeUndefined();
		expect(requests.at(-1)).toMatchObject({
			model: "thinking-model",
			max_tokens: 256,
			reasoning_effort: "high",
		});

		const afterEntries = readSessionEntries(sessionDir, sessionId);
		expect(afterEntries.filter((entry) => entry.type === "model_change")).toHaveLength(modelChangesBefore.length);
		expect(afterEntries.filter((entry) => entry.type === "thinking_level_change")).toHaveLength(
			thinkingChangesBefore.length,
		);
		expect(afterEntries.some((entry) => entry.type === "custom" && entry.customType === "pi:mcp-max-tokens")).toBe(
			true,
		);
	});

	it("rejects invalid thinking before mutating model, maxTokens, or thinkingLevel", async () => {
		const sessionDir = join(root, "sessions-invalid-thinking");
		mkdirSync(sessionDir, { recursive: true });
		const { client } = await startClient(["--session-dir", sessionDir]);

		const first = await client.call({
			prompt: "[hello] baseline",
			model: "fake/thinking-model",
			thinking: "low",
			maxTokens: 300,
		});
		expect(first.isError).toBeUndefined();
		const { sessionId } = first.structuredContent;
		expect(requests.at(-1)).toMatchObject({
			model: "thinking-model",
			max_tokens: 300,
			reasoning_effort: "low",
		});

		const beforeRequests = requests.length;
		const modelChangesBefore = readSessionEntries(sessionDir, sessionId).filter(
			(entry) => entry.type === "model_change",
		);
		const rejected = await client.call({
			prompt: "[hello] bad thinking for fake-model",
			sessionId,
			model: "fake/fake-model",
			maxTokens: 500,
			thinking: "high",
		});
		expect(rejected.isError).toBe(true);
		expect(rejected.content[0].text).toContain("Unknown thinking level");
		expect(requests).toHaveLength(beforeRequests);

		const after = await client.call({
			prompt: "[hello] after rejection",
			sessionId,
		});
		expect(after.isError).toBeUndefined();
		expect(requests.at(-1)).toMatchObject({
			model: "thinking-model",
			max_tokens: 300,
			reasoning_effort: "low",
		});

		const entries = readSessionEntries(sessionDir, sessionId);
		const modelChanges = entries.filter((entry) => entry.type === "model_change");
		expect(modelChanges).toHaveLength(modelChangesBefore.length);
	});

	it("preserves maxTokens cap when reopening a session in a new client", async () => {
		const sessionDir = join(root, "sessions-reopen-cap");
		mkdirSync(sessionDir, { recursive: true });

		const first = await startClient(["--session-dir", sessionDir]);
		const created = await first.client.call({ prompt: "[hello] capped before reopen", maxTokens: 256 });
		expect(created.isError).toBeUndefined();
		const { sessionId } = created.structuredContent;
		expect(requests.at(-1)?.max_tokens).toBe(256);
		await first.client.stop();

		const second = await startClient(["--session-dir", sessionDir]);
		const reopened = await second.client.call({ prompt: "[hello] reopened", sessionId });
		expect(reopened.isError).toBeUndefined();
		expect(requests.at(-1)?.max_tokens).toBe(256);
	});

	it("applies maxTokens with a model switch and validates against the new model maximum", async () => {
		const { client } = await startClient();

		const first = await client.call({ prompt: "[hello] start on fake", maxTokens: 1024 });
		expect(first.isError).toBeUndefined();
		const { sessionId } = first.structuredContent;
		expect(requests.at(-1)).toMatchObject({ model: "fake-model", max_tokens: 1024 });

		const beforeRequests = requests.length;
		const tooHigh = await client.call({
			prompt: "[hello] too high for small-model",
			sessionId,
			model: "fake/small-model",
			maxTokens: 1024,
		});
		expect(tooHigh.isError).toBe(true);
		expect(tooHigh.content[0].text).toContain("512");
		expect(requests).toHaveLength(beforeRequests);

		const switched = await client.call({
			prompt: "[hello] valid for small-model",
			sessionId,
			model: "fake/small-model",
			maxTokens: 400,
		});
		expect(switched.isError).toBeUndefined();
		expect(requests.at(-1)).toMatchObject({ model: "small-model", max_tokens: 400 });

		const raised = await client.call({
			prompt: "[hello] raise back on fake-model",
			sessionId,
			model: "fake/fake-model",
			maxTokens: 1024,
		});
		expect(raised.isError).toBeUndefined();
		expect(requests.at(-1)).toMatchObject({ model: "fake-model", max_tokens: 1024 });

		const bounded = await client.call({
			prompt: "[hello] switch without maxTokens keeps cap bounded by model max",
			sessionId,
			model: "fake/small-model",
		});
		expect(bounded.isError).toBeUndefined();
		expect(requests.at(-1)).toMatchObject({ model: "small-model", max_tokens: 512 });
	});

	it("reports bad arguments and unknown tools", async () => {
		const { client } = await startClient();
		const empty = await client.call({ prompt: "" });
		expect(empty.isError).toBe(true);
		const relative = await client.call({ prompt: "hi", cwd: "relative/dir" });
		expect(relative.isError).toBe(true);
		expect(relative.content[0].text).toContain("absolute path");
		const unknown = await client.send("tools/call", { name: "nope", arguments: {} }).response;
		expect(unknown.error?.code).toBe(-32602);
		const method = await client.send("resources/list", {}).response;
		expect(method.error?.code).toBe(-32601);
	});

	it("stops a prompt when the client cancels the call, and sends no response for it", async () => {
		const { client } = await startClient();
		const call = client.send("tools/call", { name: "prompt", arguments: { prompt: "[slow] take your time" } });
		await client.waitFor(() => requests.some((request) => request.users.at(-1) === "[slow] take your time"));
		client.notify("notifications/cancelled", { requestId: call.id, reason: "changed my mind" });
		// The session is free again: a later prompt in it runs.
		await new Promise((r) => setTimeout(r, 300));
		const after = await client.call({ prompt: "[hello] after" });
		expect(after.structuredContent.text).toBe("Hello from the fake model.");
		expect(client.responses.some((response) => response.id === call.id)).toBe(false);
	});

	it("asks the client through elicitation when an extension asks the user", async () => {
		const extensionPath = join(root, "ask-extension.ts");
		const answerPath = join(root, "answer.txt");
		writeFileSync(
			extensionPath,
			`import { writeFileSync } from "node:fs";
export default function (pi) {
	pi.registerCommand("ask", {
		description: "Ask a question",
		handler: async (_args, ctx) => {
			const ok = await ctx.ui.confirm("Proceed?", "Shall I go on?");
			const choice = await ctx.ui.select("Pick one", ["red", "blue"]);
			const name = await ctx.ui.input("Your name");
			writeFileSync(${JSON.stringify(answerPath)}, ok + " " + choice + " " + name);
		},
	});
}
`,
		);
		const { client } = await startClient(["-e", extensionPath], { elicitation: { form: {} } });
		client.onRequest = (message) => {
			const properties = (message.params as { requestedSchema: { properties: Record<string, unknown> } })
				.requestedSchema.properties;
			if ("confirm" in properties) return { action: "accept", content: { confirm: true } };
			if ("choice" in properties) return { action: "accept", content: { choice: "blue" } };
			return { action: "accept", content: { value: "Ada" } };
		};
		await client.call({ prompt: "/ask" });
		expect(client.serverRequests.map((m) => m.method)).toEqual([
			"elicitation/create",
			"elicitation/create",
			"elicitation/create",
		]);
		expect((client.serverRequests[0].params as { message: string }).message).toBe("Proceed?\n\nShall I go on?");
		expect(readFileSync(answerPath, "utf8")).toBe("true blue Ada");

		// A client without elicitation is not asked: the dialogs get no answer, as in print mode.
		const plain = await startClient(["-e", extensionPath]);
		await plain.client.call({ prompt: "/ask" });
		expect(plain.client.serverRequests).toEqual([]);
		expect(readFileSync(answerPath, "utf8")).toBe("false undefined undefined");
	});
});
