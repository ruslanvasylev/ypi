/**
 * ypi recursive Pi extension.
 *
 * Load directly with:
 *   pi -e ./extensions/recursive.ts
 *
 * The extension is the canonical integration point. The ypi launcher and the
 * shell-compatible rlm_query command are convenience layers around this path.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureEnvironment, shouldExposeRecursion } from "./ypi/env.ts";
import { registerNativeRlmQueryTool } from "./ypi/native-tool.ts";
import { routingCatalogSnapshot, selectRootDefault } from "./ypi/internal/model-routing.ts";
import { createRootPromptLease } from "./ypi/internal/root-prompt.ts";
import { registerRootImplementerBatchPolicy } from "./ypi/internal/root-batch-policy.ts";
import { registerImplementWriteScope } from "./ypi/internal/write-scope.ts";
import { registerCompactionContextProjection } from "./ypi/internal/compaction-context.ts";
import {
	beginRootTreeCoordinator,
	terminateRootTreeCoordinator,
} from "./ypi/internal/tree-coordinator.ts";
import { buildYpiPrompt } from "./ypi/prompt.ts";
import { debug, resolveRuntime } from "./ypi/runtime.ts";
import { updateStatus } from "./ypi/status.ts";

const runtime = resolveRuntime(import.meta.url);
const ACTIVE_EXTENSION = Symbol.for("ypi.active-recursive-extension.v1");

interface ActiveExtensionRecord {
	extensionPath: string;
	token: object;
}

function projectRoutingCatalog(ctx: ExtensionContext) {
	if ((process.env.RLM_DEPTH || "0") !== "0") return undefined;
	const scoped = ctx.scopedModels?.length > 0 ? new Set(ctx.scopedModels.map(({ model }) => `${model.provider}/${model.id}`)) : undefined;
	const available = ctx.modelRegistry?.getAvailable?.().filter((model) => !scoped || scoped.has(`${model.provider}/${model.id}`));
	if (available) process.env.YPI_MODEL_CATALOG = routingCatalogSnapshot(available);
	else delete process.env.YPI_MODEL_CATALOG;
	return available;
}

export default function (pi: ExtensionAPI) {
	const registry = globalThis as typeof globalThis & { [ACTIVE_EXTENSION]?: ActiveExtensionRecord };
	if (registry[ACTIVE_EXTENSION]) {
		debug(`__YPI_DUPLICATE_EXTENSION_SKIPPED__ active=${registry[ACTIVE_EXTENSION].extensionPath} skipped=${runtime.extensionPath}`);
		return;
	}
	const token = {};
	registry[ACTIVE_EXTENSION] = { extensionPath: runtime.extensionPath, token };
	const rootPrompt = createRootPromptLease();
	ensureEnvironment(runtime);
	registerRootImplementerBatchPolicy(pi);
	registerImplementWriteScope(pi);
	registerCompactionContextProjection(pi);
	if (shouldExposeRecursion()) {
		registerNativeRlmQueryTool(pi, runtime);
	}
	debug(`__YPI_EXTENSION_LOADED__ root=${runtime.root}`);

	let automaticRootRouting = false;
	let rootRouteFailure: string | undefined;
	const explicitRoutingProvider = () => process.env.YPI_MODEL_ROUTING_PROVIDER !== undefined;
	const reportRootRouteFailure = (ctx: ExtensionContext) => {
		const message = `ypi automatic root routing blocked: ${rootRouteFailure}`;
		if (ctx.hasUI) ctx.ui.notify(message, "error");
		else console.error(message);
	};
	const applyAutomaticRootRoute = async (ctx: ExtensionContext) => {
		try {
			const available = projectRoutingCatalog(ctx);
			const selected = selectRootDefault(available || []);
			if (!selected && explicitRoutingProvider()) throw new Error("selected provider model is unavailable in the routing catalog");
			if (selected) {
				const model = available?.find((candidate) => candidate.provider === selected.provider && candidate.id === selected.model);
				if (!model || !await pi.setModel(model)) {
					if (explicitRoutingProvider()) throw new Error("selected provider model could not be activated");
					return undefined;
				}
				if (process.env.YPI_ROOT_EXPLICIT_THINKING !== "1") pi.setThinkingLevel(selected.thinkingLevel as Parameters<typeof pi.setThinkingLevel>[0]);
				debug(`__YPI_ROOT_ROUTE__ ${selected.provider}/${selected.model}:${pi.getThinkingLevel()} policy=${selected.policyRevision}`);
			}
			rootRouteFailure = undefined;
			return selected;
		} catch (error) {
			if (!explicitRoutingProvider()) throw error;
			rootRouteFailure = error instanceof Error ? error.message : "selected provider route is unavailable";
			reportRootRouteFailure(ctx);
			return undefined;
		}
	};
	const projectSelectedRootRoute = (selected: ReturnType<typeof selectRootDefault>) => {
		if (!selected) return;
		// ctx.model is an event snapshot; setModel changes the live session.
		process.env.RLM_PROVIDER = selected.provider;
		process.env.RLM_MODEL = selected.model;
		process.env.RLM_THINKING_LEVEL = pi.getThinkingLevel();
	};

	pi.on("session_start", async (event, ctx) => {
		const newSession = event.reason === "startup" && (ctx.sessionManager.getEntries?.() || []).every((entry) => entry.type === "model_change" || entry.type === "thinking_level_change");
		automaticRootRouting = (process.env.RLM_DEPTH || "0") === "0" && process.env.YPI_ROOT_AUTO_ROUTE === "1" && newSession;
		rootRouteFailure = undefined;
		if (!automaticRootRouting) projectRoutingCatalog(ctx);
		const selected = automaticRootRouting ? await applyAutomaticRootRoute(ctx) : undefined;
		ensureEnvironment(runtime, ctx, pi);
		projectSelectedRootRoute(selected);
		updateStatus(ctx);
	});

	// Pi contains hook exceptions. Explicit routing failures must consume input,
	// rather than allowing the session's ambient model to generate a response.
	pi.on("input", async (_event, ctx) => {
		if (!automaticRootRouting || !rootRouteFailure || !explicitRoutingProvider()) return { action: "continue" };
		const selected = await applyAutomaticRootRoute(ctx);
		if (rootRouteFailure) return { action: "handled" };
		ensureEnvironment(runtime, ctx, pi);
		projectSelectedRootRoute(selected);
		return { action: "continue" };
	});

	// Extension custom messages with triggerTurn bypass input. agent_start is
	// awaited while the run has an abort signal, before any provider request.
	pi.on("agent_start", (_event, ctx) => {
		if (automaticRootRouting && rootRouteFailure && explicitRoutingProvider()) {
			ctx.abort();
			reportRootRouteFailure(ctx);
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		// Pi 1.2+ also fires this for idle extension messages with triggerTurn
		// (messageType "custom"); older Pi fires it only for user prompts. Only a
		// user prompt replaces the root charter and recursion tree; custom runs
		// keep both, but still receive ypi's prompt section below.
		const userTurn = event.messageType !== "custom";
		if (userTurn) rootPrompt.capture(event.prompt);
		projectRoutingCatalog(ctx);
		ensureEnvironment(runtime, ctx, pi);
		updateStatus(ctx);
		if (userTurn && (process.env.RLM_DEPTH || "0") === "0") {
			beginRootTreeCoordinator("root-turn-replaced");
		}
		debug("__YPI_EXTENSION_PROMPT_PATCHED__");
		const ypiPrompt = buildYpiPrompt(runtime);
		if (process.env.YPI_EXTENSION_PROMPT_MODE === "replace") {
			return { systemPrompt: ypiPrompt };
		}
		event.systemPromptOptions.sections.ypi = ypiPrompt;
	});

	// Pi creates the transcript at the first user message, after our pre-agent
	// refresh. Re-assert exact active-file permissions at the first tool and
	// turn_end boundaries, so it is private before operator tools run.
	pi.on("tool_execution_start", (_event, ctx) => {
		ensureEnvironment(runtime, ctx, pi);
		updateStatus(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		ensureEnvironment(runtime, ctx, pi);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		await terminateRootTreeCoordinator("root-session-shutdown");
		rootPrompt.cleanup();
		if (registry[ACTIVE_EXTENSION]?.token === token) delete registry[ACTIVE_EXTENSION];
	});
}
