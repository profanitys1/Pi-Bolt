import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const MAX_OUTPUT_TOKENS = 8192;
const MAX_CONSECUTIVE_FAILURES = 2;
const TOKEN_LIMIT_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const;
const BENIGN_EXIT_ONE_COMMANDS = new Set(["rg", "grep", "egrep", "fgrep", "diff"]);
const SHELL_CHAIN_CHARS = new Set([";", "&", "|", ">", "<", "\n", "\r", "`"]);
const DISALLOWED_ERROR_PHRASES = [
	"no such file",
	"permission denied",
	"unrecognized option",
	"regex parse error",
];

function isStandaloneSearchOrDiff(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;

	let quote: "'" | '"' | null = null;
	let escaped = false;
	let firstToken = "";
	let readingFirstToken = true;

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = null;
			} else if (ch === "`" || (ch === "$" && trimmed[i + 1] === "(")) {
				return false;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			if (readingFirstToken && firstToken.length === 0) return false;
			quote = ch;
			continue;
		}
		if (SHELL_CHAIN_CHARS.has(ch)) return false;
		if (ch === "$" && trimmed[i + 1] === "(") return false;
		if (readingFirstToken) {
			if (/\s/.test(ch)) {
				readingFirstToken = false;
			} else {
				firstToken += ch;
			}
		}
	}

	if (quote !== null || escaped) return false;
	return BENIGN_EXIT_ONE_COMMANDS.has(firstToken);
}

function extractText(content: ToolResultEvent["content"]): string {
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") {
			parts.push(part.text);
		}
	}
	return parts.join("\n");
}

function isBenignExitOne(event: ToolResultEvent): boolean {
	if (event.toolName !== "bash" || !event.isError) return false;

	const exitCode = (event.structuredContent as { exit_code?: unknown } | undefined)?.exit_code;
	if (exitCode !== 1) return false;

	const cmd = String((event.input as { command?: unknown } | undefined)?.command ?? "").trim();
	if (!isStandaloneSearchOrDiff(cmd)) return false;

	const lower = extractText(event.content).toLowerCase();
	return !DISALLOWED_ERROR_PHRASES.some((phrase) => lower.includes(phrase));
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? JSON.stringify(value) : "null";
	}
	if (typeof value === "bigint") {
		return JSON.stringify(value.toString());
	}
	if (typeof value !== "object") {
		return "null";
	}
	if (seen.has(value)) {
		return '"[Circular]"';
	}

	const withToJson = value as { toJSON?: unknown };
	if (typeof withToJson.toJSON === "function") {
		seen.add(value);
		try {
			return canonicalJson((withToJson as { toJSON: () => unknown }).toJSON(), seen);
		} finally {
			seen.delete(value);
		}
	}

	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
		}
		const record = value as Record<string, unknown>;
		const parts: string[] = [];
		for (const key of Object.keys(record).sort()) {
			const prop = record[key];
			if (prop === undefined || typeof prop === "function" || typeof prop === "symbol") {
				continue;
			}
			parts.push(`${JSON.stringify(key)}:${canonicalJson(prop, seen)}`);
		}
		return `{${parts.join(",")}}`;
	} finally {
		seen.delete(value);
	}
}

function toolCallKey(toolName: string, input: unknown): string {
	return `${toolName}:${canonicalJson(input ?? {})}`;
}

export default function workerGuard(pi: ExtensionAPI) {
	const failuresByKey = new Map<string, number>();

	pi.on("agent_start", () => {
		failuresByKey.clear();
	});

	pi.on("before_provider_request", (event) => {
		const payload = event.payload as Record<string, unknown> | undefined;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			return undefined;
		}
		let hasTokenLimitField = false;
		for (const field of TOKEN_LIMIT_FIELDS) {
			if (!Object.hasOwn(payload, field) || payload[field] === undefined) {
				continue;
			}
			hasTokenLimitField = true;
			const value = payload[field];
			if (typeof value !== "number" || !Number.isFinite(value) || value > MAX_OUTPUT_TOKENS) {
				payload[field] = MAX_OUTPUT_TOKENS;
			}
		}
		if (!hasTokenLimitField) {
			const defaultField = "input" in payload && !("messages" in payload) ? "max_output_tokens" : "max_tokens";
			payload[defaultField] = MAX_OUTPUT_TOKENS;
		}
		return payload;
	});

	pi.on("tool_call", (event) => {
		const key = toolCallKey(event.toolName, event.input);
		if ((failuresByKey.get(key) ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
			return {
				block: true,
				terminate: true,
				reason: "Loop breaker: identical failing tool call repeated 3 times. Stop and report the blocker.",
			};
		}
		return undefined;
	});

	pi.on("tool_result", (event) => {
		const benignExitOne = isBenignExitOne(event);
		const effectiveIsError = benignExitOne ? false : event.isError;
		const key = toolCallKey(event.toolName, event.input);

		if (effectiveIsError) {
			failuresByKey.set(key, (failuresByKey.get(key) ?? 0) + 1);
		} else {
			failuresByKey.delete(key);
		}

		if (benignExitOne) {
			return { isError: false };
		}
		return undefined;
	});
}
