import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canExecute } from "./guardrails.ts";
import { registerLegacyNativeRlmQueryTool } from "./legacy-native-tool.ts";
import { runRecursiveChild } from "./runtime-core.ts";
import type { YpiRuntime } from "./runtime.ts";
import { debug } from "./runtime.ts";

const RlmQueryParams = Type.Object({
	prompt: Type.String({
		description: "Task for a child Pi agent. Keep it clear and bounded.",
	}),
	context: Type.Optional(Type.String({
		description: "Optional exact context to pass to the child via CONTEXT.",
	})),
	fork: Type.Optional(Type.Boolean({
		description: "Copy the current session file into the child session before running.",
	})),
});

export function registerNativeRlmQueryTool(pi: ExtensionAPI, runtime: YpiRuntime): void {
	if (process.env.YPI_LEGACY_IMPL === "1") {
		registerLegacyNativeRlmQueryTool(pi, runtime);
		return;
	}

	const tool = defineTool({
		name: "rlm_query",
		label: "Recursive query",
		description: "Delegate a bounded task to a child Pi agent using ypi's canonical recursion runtime.",
		promptSnippet: "Delegate a bounded task to a child Pi agent with a fresh context window.",
		promptGuidelines: [
			"Use rlm_query for clear subtasks that benefit from an extra context window.",
			"Pass exact source text through the context parameter when the child must inspect specific data.",
			"Do not recurse past the active RLM_MAX_DEPTH limit.",
		],
		parameters: RlmQueryParams,
		executionMode: "parallel" as const,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await runRecursiveChild(runtime, {
				prompt: params.prompt,
				context: params.context,
				fork: params.fork,
				caller: "tool",
				signal,
				parent: {
					cwd: ctx.cwd,
					provider: ctx.model?.provider,
					model: ctx.model?.id,
					thinkingLevel: pi.getThinkingLevel(),
					sessionFile: ctx.sessionManager.getSessionFile() || undefined,
					sessionDir: ctx.sessionManager.getSessionFile() ? ctx.sessionManager.getSessionDir() : undefined,
				},
			});

			return {
				content: [{ type: "text" as const, text: result.text }],
				details: result.details,
			};
		},
	});

	pi.registerTool(tool);
	debug("__YPI_NATIVE_TOOL_REGISTERED__ rlm_query");
	if (process.env.YPI_PI_BIN && !canExecute(process.env.YPI_PI_BIN)) {
		debug(`__YPI_NATIVE_PI_BIN_NOT_EXECUTABLE__ ${process.env.YPI_PI_BIN}`);
	}
}
