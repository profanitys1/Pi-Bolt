import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const MAX_OUTPUT_TOKENS = 8192;
const MAX_CONSECUTIVE_FAILURES = 2;
const BENIGN_EXIT_ONE_COMMANDS = new Set(["rg", "grep", "egrep", "fgrep", "diff"]);
const SHELL_CHAIN_CHARS = new Set([";", "&", "|", ">", "<", "\n", "\r", "`"]);
const DISALLOWED_ERROR_PHRASES = [
	"no such file",
	"permission denied",
	"unrecognized option",
	"regex parse error",
];

interface FailureStreak {
	key: string;
	count: number;
}

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

function toolCallKey(toolName: string, input: unknown): string {
	return `${toolName}:${JSON.stringify(input ?? {})}`;
}

export default function workerGuard(pi: ExtensionAPI) {
	let lastFailure: FailureStreak | null = null;

	pi.on("agent_start", () => {
		lastFailure = null;
	});

	pi.on("before_provider_request", (event) => {
		const payload = event.payload as Record<string, unknown> | undefined;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			return undefined;
		}
		if (
			typeof payload.max_tokens !== "number" ||
			!Number.isFinite(payload.max_tokens) ||
			payload.max_tokens > MAX_OUTPUT_TOKENS
		) {
			payload.max_tokens = MAX_OUTPUT_TOKENS;
		}
		return payload;
	});

	pi.on("tool_call", (event) => {
		const key = toolCallKey(event.toolName, event.input);
		if (lastFailure && lastFailure.key === key && lastFailure.count >= MAX_CONSECUTIVE_FAILURES) {
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

		if (effectiveIsError) {
			const key = toolCallKey(event.toolName, event.input);
			lastFailure =
				lastFailure && lastFailure.key === key ? { key, count: lastFailure.count + 1 } : { key, count: 1 };
		} else {
			lastFailure = null;
		}

		if (benignExitOne) {
			return { isError: false };
		}
		return undefined;
	});
}
