import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyDeepSeekCompatRules,
	applyDeepSeekFamilyRules,
	DEEPSEEK_COMPAT,
	DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP,
} from "../catalog/families/deepseek.ts";
import { convertMessages } from "../src/api/openai-completions.ts";
import {
	clampThinkingLevel,
	getModel,
	getSupportedThinkingLevels,
	normalizeContext,
	streamSimple,
} from "../src/compat.ts";
import type { AssistantMessage, Model, SimpleStreamOptions, ToolResultMessage, Usage } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	chunks: undefined as
		| Array<null | {
				id?: string;
				choices?: Array<{ delta: Record<string, unknown>; finish_reason: string | null; usage?: unknown }>;
				usage?: {
					prompt_tokens: number;
					completion_tokens: number;
					prompt_tokens_details: { cached_tokens: number; cache_write_tokens?: number };
					completion_tokens_details: { reasoning_tokens: number };
				};
		  }>
		| undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							const chunks = mockState.chunks ?? [
								{
									choices: [{ delta: {}, finish_reason: "stop" }],
									usage: {
										prompt_tokens: 1,
										completion_tokens: 1,
										prompt_tokens_details: { cached_tokens: 0 },
										completion_tokens_details: { reasoning_tokens: 0 },
									},
								},
							];
							for (const chunk of chunks) {
								yield chunk;
							}
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

type CapturedParams = {
	thinking?: unknown;
	reasoning_effort?: string;
	max_tokens?: number;
	max_completion_tokens?: number;
};

async function captureSimpleParams(
	model: Model<"openai-completions">,
	options?: Pick<SimpleStreamOptions, "reasoning" | "maxTokens">,
): Promise<CapturedParams> {
	let payload: unknown;

	await streamSimple(
		model,
		{
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		},
		{
			apiKey: "test",
			reasoning: options?.reasoning,
			maxTokens: options?.maxTokens,
			onPayload: (params: unknown) => {
				payload = params;
			},
		},
	).result();

	return (payload ?? mockState.lastParams) as CapturedParams;
}

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const deepSeekCompat: Parameters<typeof convertMessages>[2] = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresNonNullAssistantContent: false,
	requiresToolsWithToolHistory: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "deepseek",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsThinkingTokenBudget: false,
	thinkingTokenBudgetField: undefined,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	supportsMidConvoSystemMessages: false,
	supportsMidConvoToolAdditions: false,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
};

function syntheticDeepSeekModel(provider: string, id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 384000,
	};
}

function buildAssistantToolHistory(model: Model<"openai-completions">) {
	const now = Date.now();
	const assistantWithThinking: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [
			{ type: "thinking", thinking: "plan step", thinkingSignature: "reasoning_content" },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
		],
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: now,
	};
	const toolResultOne: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [{ type: "text", text: "contents" }],
		isError: false,
		timestamp: now + 1,
	};
	const assistantWithoutThinking: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "package.json" } }],
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: now + 2,
	};
	const toolResultTwo: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_2",
		toolName: "read",
		content: [{ type: "text", text: "{}" }],
		isError: false,
		timestamp: now + 3,
	};

	return normalizeContext({
		messages: [
			{ role: "user", content: "Read files", timestamp: now - 1 },
			assistantWithThinking,
			toolResultOne,
			assistantWithoutThinking,
			toolResultTwo,
		],
	});
}

describe("openai-completions DeepSeek wire contract", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.chunks = undefined;
	});

	it.each([
		{ name: "deepseek/deepseek-flash", getTarget: () => getModel("deepseek", "deepseek-flash")! },
		{ name: "opencode-go/deepseek-v4.1-flash", getTarget: () => getModel("opencode-go", "deepseek-v4.1-flash")! },
	])(
		"sends disabled thinking without reasoning_effort for $name when reasoning is undefined",
		async ({ getTarget }) => {
			const model = getTarget();
			expect(clampThinkingLevel(model, "off")).toBe("off");
			const params = await captureSimpleParams(model, { reasoning: undefined });

			expect(params.thinking).toEqual({ type: "disabled" });
			expect(params.reasoning_effort).toBeUndefined();
		},
	);

	it.each(["low", "high", "max"] as const)(
		"sends enabled thinking and reasoning_effort=%s for deepseek-flash",
		async (reasoning) => {
			const model = getModel("deepseek", "deepseek-flash")!;
			const params = await captureSimpleParams(model, { reasoning });

			expect(params.thinking).toEqual({ type: "enabled" });
			expect(params.reasoning_effort).toBe(reasoning);
		},
	);

	it("forwards explicit maxTokens as max_tokens and clamps model.maxTokens when omitted", async () => {
		const model = getModel("deepseek", "deepseek-flash")!;

		const explicitParams = await captureSimpleParams(model, { maxTokens: 8192 });
		expect(explicitParams.max_tokens).toBe(8192);
		expect(explicitParams.max_completion_tokens).toBeUndefined();

		const defaultParams = await captureSimpleParams(model);
		expect(defaultParams.max_tokens).toBe(model.maxTokens);
		expect(defaultParams.max_completion_tokens).toBeUndefined();
	});

	it("clamps unsupported low reasoning forward to high for deepseek-v4-pro", async () => {
		const model = getModel("deepseek", "deepseek-v4-pro")!;
		const params = await captureSimpleParams(model, { reasoning: "low" });

		expect(params.thinking).toEqual({ type: "enabled" });
		expect(params.reasoning_effort).toBe("high");
	});

	it("exposes expected supported thinking levels and catalog compat for real DeepSeek models", () => {
		const deepseekFlash = getModel("deepseek", "deepseek-flash")!;
		const opencodeGoFlash = getModel("opencode-go", "deepseek-v4.1-flash")!;
		const deepseekPro = getModel("deepseek", "deepseek-v4-pro")!;
		const openRouterFlash = getModel("openrouter", "~deepseek/deepseek-flash-latest")!;

		expect(getSupportedThinkingLevels(deepseekFlash)).toEqual(["off", "low", "high", "max"]);
		expect(getSupportedThinkingLevels(opencodeGoFlash)).toEqual(["off", "low", "high", "max"]);
		expect(getSupportedThinkingLevels(deepseekPro)).toEqual(["off", "high", "max"]);
		expect(getSupportedThinkingLevels(openRouterFlash)).toEqual(["off", "low", "high", "max"]);

		expect(opencodeGoFlash.thinkingLevelMap?.off).toBeUndefined();
		expect(opencodeGoFlash.compat?.thinkingFormat).toBe("deepseek");
		expect(openRouterFlash.compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
		expect(openRouterFlash.compat?.thinkingFormat).toBe("openrouter");
	});

	it.each([
		{ name: "deepseek/deepseek-flash", getTarget: () => getModel("deepseek", "deepseek-flash")! },
		{
			name: "openrouter/~deepseek/deepseek-flash-latest",
			getTarget: () => getModel("openrouter", "~deepseek/deepseek-flash-latest")!,
		},
	])(
		"preserves reasoning_content and backfills empty reasoning_content on assistant tool-call turns for $name",
		({ getTarget }) => {
			const model = getTarget();
			const messages = convertMessages(model, buildAssistantToolHistory(model), {
				...deepSeekCompat,
				requiresReasoningContentOnAssistantMessages: false,
				...(model.compat ?? {}),
			});

			const assistantMessages = messages.filter((message) => message.role === "assistant");
			expect(assistantMessages).toHaveLength(2);
			expect(assistantMessages[0]).toMatchObject({ role: "assistant", reasoning_content: "plan step" });
			expect(assistantMessages[1]).toMatchObject({ role: "assistant", reasoning_content: "" });
		},
	);

	it.each([
		{ provider: "deepseek", id: "deepseek-flash" },
		{ provider: "deepseek", id: "deepseek-v4.1-flash" },
		{ provider: "opencode-go", id: "deepseek-flash" },
		{ provider: "opencode-go", id: "deepseek-v4.1-flash" },
	])("applies DeepSeek compat and flash thinking rules to $provider/$id", ({ provider, id }) => {
		const model = syntheticDeepSeekModel(provider, id);
		applyDeepSeekCompatRules(model);
		applyDeepSeekFamilyRules(model);

		expect(model.compat).toEqual(DEEPSEEK_COMPAT);
		expect(model.thinkingLevelMap).toEqual(DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP);
		expect(model.thinkingLevelMap?.low).toBe("low");
	});

	it("applies replay compat without deepseek thinkingFormat to synthetic openrouter ~deepseek/deepseek-flash-latest", () => {
		const model = syntheticDeepSeekModel("openrouter", "~deepseek/deepseek-flash-latest");
		applyDeepSeekCompatRules(model);

		expect(model.compat).toEqual({
			requiresReasoningContentOnAssistantMessages: true,
		});
		expect(model.compat?.thinkingFormat).toBeUndefined();
	});
});
