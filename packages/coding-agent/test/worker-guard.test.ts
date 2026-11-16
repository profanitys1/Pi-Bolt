import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import workerGuard from "../../../examples/worker/extensions/worker-guard.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ToolResultEvent } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";
import { createHarness, getAssistantTexts, type Harness } from "./suite/harness.ts";

async function createWorkerGuardRunner(): Promise<ExtensionRunner> {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(workerGuard, process.cwd(), createEventBus(), runtime);
	const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	return new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), modelRegistry);
}

function makeBashToolResult(
	command: string,
	options: { exitCode?: number; isError?: boolean; text?: string; toolCallId?: string } = {},
): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId: options.toolCallId ?? "call-1",
		input: { command },
		content: [{ type: "text", text: options.text ?? "" }],
		details: undefined,
		structuredContent: options.exitCode === undefined ? undefined : { exit_code: options.exitCode },
		isError: options.isError ?? true,
	};
}

describe("worker-guard extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	describe("before_provider_request", () => {
		it("clamps max_tokens, max_completion_tokens, and max_output_tokens over 8192 or non-finite", async () => {
			const runner = await createWorkerGuardRunner();

			const chatHigh = (await runner.emitBeforeProviderRequest({
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 32768,
			})) as Record<string, unknown>;
			expect(chatHigh.max_tokens).toBe(8192);

			const chatLow = (await runner.emitBeforeProviderRequest({
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 4096,
			})) as Record<string, unknown>;
			expect(chatLow.max_tokens).toBe(4096);

			const reasoning = (await runner.emitBeforeProviderRequest({
				messages: [{ role: "user", content: "hi" }],
				max_completion_tokens: 16384,
			})) as Record<string, unknown>;
			expect(reasoning.max_completion_tokens).toBe(8192);
			expect("max_tokens" in reasoning).toBe(false);

			const responses = (await runner.emitBeforeProviderRequest({
				input: "hi",
				max_output_tokens: 20000,
			})) as Record<string, unknown>;
			expect(responses.max_output_tokens).toBe(8192);
			expect("max_tokens" in responses).toBe(false);

			const nanPayload = (await runner.emitBeforeProviderRequest({
				messages: [],
				max_tokens: Number.NaN,
				max_completion_tokens: Number.POSITIVE_INFINITY,
				max_output_tokens: Number.NEGATIVE_INFINITY,
			})) as Record<string, unknown>;
			expect(nanPayload).toEqual({
				messages: [],
				max_tokens: 8192,
				max_completion_tokens: 8192,
				max_output_tokens: 8192,
			});
		});

		it("defaults Responses payloads to max_output_tokens and Chat or empty payloads to max_tokens", async () => {
			const runner = await createWorkerGuardRunner();

			const responsesDefault = (await runner.emitBeforeProviderRequest({
				input: [{ role: "user", content: "hi" }],
			})) as Record<string, unknown>;
			expect(responsesDefault.max_output_tokens).toBe(8192);
			expect("max_tokens" in responsesDefault).toBe(false);

			const chatDefault = (await runner.emitBeforeProviderRequest({
				messages: [{ role: "user", content: "hi" }],
			})) as Record<string, unknown>;
			expect(chatDefault.max_tokens).toBe(8192);
			expect("max_output_tokens" in chatDefault).toBe(false);

			const genericDefault = (await runner.emitBeforeProviderRequest({ model: "deepseek-chat" })) as Record<
				string,
				unknown
			>;
			expect(genericDefault.max_tokens).toBe(8192);
			expect("max_output_tokens" in genericDefault).toBe(false);
		});

		it("leaves non-object payloads untouched", async () => {
			const runner = await createWorkerGuardRunner();

			expect(await runner.emitBeforeProviderRequest(null)).toBeNull();
			expect(await runner.emitBeforeProviderRequest(undefined)).toBeUndefined();
			expect(await runner.emitBeforeProviderRequest("raw-string")).toBe("raw-string");
			expect(await runner.emitBeforeProviderRequest(42)).toBe(42);
			const arr = [1, 2, 3];
			expect(await runner.emitBeforeProviderRequest(arr)).toBe(arr);
		});
	});

	describe("tool_result benign exit-1 suppression", () => {
		it("suppresses exit code 1 for standalone search or diff commands", async () => {
			const runner = await createWorkerGuardRunner();

			for (const cmd of [
				"rg pattern src/",
				'rg "foo|bar" src/',
				"grep -rn needle .",
				"egrep 'a|b' file.txt",
				"fgrep literal file.txt",
				"diff a.txt b.txt",
			]) {
				const result = await runner.emitToolResult(makeBashToolResult(cmd, { exitCode: 1 }));
				expect(result?.isError, cmd).toBe(false);
			}
		});

		it("does not suppress missing file, permission denied, regex parse errors, exit code 2, or pipelines", async () => {
			const runner = await createWorkerGuardRunner();

			expect(
				await runner.emitToolResult(
					makeBashToolResult("rg needle missing.txt", {
						exitCode: 1,
						text: "rg: missing.txt: No such file or directory",
					}),
				),
			).toBeUndefined();
			expect(
				await runner.emitToolResult(
					makeBashToolResult("rg needle /root", { exitCode: 1, text: "rg: /root: Permission denied" }),
				),
			).toBeUndefined();
			expect(
				await runner.emitToolResult(
					makeBashToolResult("rg '[' src/", { exitCode: 1, text: "regex parse error:\n    [" }),
				),
			).toBeUndefined();
			expect(
				await runner.emitToolResult(
					makeBashToolResult("rg --bad-flag", { exitCode: 1, text: "unrecognized option" }),
				),
			).toBeUndefined();
			expect(await runner.emitToolResult(makeBashToolResult("rg foo | head", { exitCode: 1 }))).toBeUndefined();
			expect(
				await runner.emitToolResult(makeBashToolResult('rg "$(whoami)" src/', { exitCode: 1 })),
			).toBeUndefined();
			expect(await runner.emitToolResult(makeBashToolResult("rg foo src/", { exitCode: 2 }))).toBeUndefined();
		});

		it("does not accumulate loop-breaker streaks for benign exit-1 results", async () => {
			const runner = await createWorkerGuardRunner();
			const command = "rg missing_symbol src/";

			for (let i = 1; i <= 3; i++) {
				const toolCallId = `rg-${i}`;
				expect(
					await runner.emitToolCall({
						type: "tool_call",
						toolName: "bash",
						toolCallId,
						input: { command },
					}),
				).toBeUndefined();
				const result = await runner.emitToolResult(makeBashToolResult(command, { exitCode: 1, toolCallId }));
				expect(result?.isError).toBe(false);
			}
		});
	});

	describe("loop breaker", () => {
		it("blocks and terminates on the 3rd attempt even when object keys are reordered", async () => {
			const runner = await createWorkerGuardRunner();

			const firstInput = { b: 2, a: 1, nested: { z: true, a: [1, { d: 4, c: 3 }] } };
			const reorderedInput = { nested: { a: [1, { c: 3, d: 4 }], z: true }, a: 1, b: 2 };

			expect(
				await runner.emitToolCall({
					type: "tool_call",
					toolName: "custom_edit",
					toolCallId: "t1",
					input: firstInput,
				}),
			).toBeUndefined();
			await runner.emitToolResult({
				type: "tool_result",
				toolName: "custom_edit",
				toolCallId: "t1",
				input: firstInput,
				content: [{ type: "text", text: "failed" }],
				details: undefined,
				isError: true,
			});

			expect(
				await runner.emitToolCall({
					type: "tool_call",
					toolName: "custom_edit",
					toolCallId: "t2",
					input: reorderedInput,
				}),
			).toBeUndefined();
			await runner.emitToolResult({
				type: "tool_result",
				toolName: "custom_edit",
				toolCallId: "t2",
				input: reorderedInput,
				content: [{ type: "text", text: "failed" }],
				details: undefined,
				isError: true,
			});

			const thirdResult = await runner.emitToolCall({
				type: "tool_call",
				toolName: "custom_edit",
				toolCallId: "t3",
				input: { a: 1, b: 2, nested: { a: [1, { c: 3, d: 4 }], z: true } },
			});
			expect(thirdResult).toEqual({
				block: true,
				terminate: true,
				reason: "Loop breaker: identical failing tool call repeated 3 times. Stop and report the blocker.",
			});
		});

		it("keeps per-key streaks across parallel sibling successes and clears only on matching success or agent_start", async () => {
			const runner = await createWorkerGuardRunner();

			const failInputA = { path: "a.ts" };
			const okInputB = { path: "b.ts" };

			await runner.emitToolResult({
				type: "tool_result",
				toolName: "fail_a",
				toolCallId: "a1",
				input: failInputA,
				content: [{ type: "text", text: "err" }],
				details: undefined,
				isError: true,
			});
			await runner.emitToolResult({
				type: "tool_result",
				toolName: "ok_b",
				toolCallId: "b1",
				input: okInputB,
				content: [{ type: "text", text: "ok" }],
				details: undefined,
				isError: false,
			});
			await runner.emitToolResult({
				type: "tool_result",
				toolName: "fail_a",
				toolCallId: "a2",
				input: failInputA,
				content: [{ type: "text", text: "err" }],
				details: undefined,
				isError: true,
			});
			await runner.emitToolResult({
				type: "tool_result",
				toolName: "ok_b",
				toolCallId: "b2",
				input: okInputB,
				content: [{ type: "text", text: "ok" }],
				details: undefined,
				isError: false,
			});

			expect(
				await runner.emitToolCall({ type: "tool_call", toolName: "fail_a", toolCallId: "a3", input: failInputA }),
			).toMatchObject({ block: true, terminate: true });

			await runner.emitToolResult({
				type: "tool_result",
				toolName: "fail_a",
				toolCallId: "a-ok",
				input: failInputA,
				content: [{ type: "text", text: "recovered" }],
				details: undefined,
				isError: false,
			});
			expect(
				await runner.emitToolCall({ type: "tool_call", toolName: "fail_a", toolCallId: "a4", input: failInputA }),
			).toBeUndefined();

			await runner.emitToolResult({
				type: "tool_result",
				toolName: "fail_c",
				toolCallId: "c1",
				input: { path: "c.ts" },
				content: [{ type: "text", text: "err" }],
				details: undefined,
				isError: true,
			});
			await runner.emitToolResult({
				type: "tool_result",
				toolName: "fail_c",
				toolCallId: "c2",
				input: { path: "c.ts" },
				content: [{ type: "text", text: "err" }],
				details: undefined,
				isError: true,
			});
			await runner.dispatch({ type: "agent_start" });
			expect(
				await runner.emitToolCall({
					type: "tool_call",
					toolName: "fail_c",
					toolCallId: "c3",
					input: { path: "c.ts" },
				}),
			).toBeUndefined();
		});

		it("aborts a real Agent and ExtensionRunner loop cleanly on the 3rd identical failing call", async () => {
			let probeExecutions = 0;
			let okExecutions = 0;
			const probeTool: AgentTool = {
				name: "probe",
				label: "Probe",
				description: "Failing probe tool",
				parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
				execute: async () => {
					probeExecutions++;
					throw new Error("probe failed");
				},
			};
			const okTool: AgentTool = {
				name: "ok_sibling",
				label: "OK Sibling",
				description: "Succeeding sibling tool",
				parameters: Type.Object({ value: Type.String() }),
				execute: async () => {
					okExecutions++;
					return { content: [{ type: "text", text: "ok" }], details: undefined };
				},
			};

			const harness = await createHarness({
				tools: [probeTool, okTool],
				extensionFactories: [workerGuard],
			});
			harnesses.push(harness);

			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("probe", { a: 1, b: 2 }), fauxToolCall("ok_sibling", { value: "keep" })],
					{
						stopReason: "toolUse",
					},
				),
				fauxAssistantMessage([fauxToolCall("probe", { b: 2, a: 1 })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("probe", { a: 1, b: 2 })], { stopReason: "toolUse" }),
				fauxAssistantMessage("should not run"),
			]);

			await harness.session.prompt("run failing probe");

			expect(probeExecutions).toBe(2);
			expect(okExecutions).toBe(1);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(getAssistantTexts(harness)).not.toContain("should not run");

			const toolEnds = harness.eventsOfType("tool_execution_end");
			expect(toolEnds.at(-1)?.result).toHaveProperty("terminate", true);
		});
	});
});
