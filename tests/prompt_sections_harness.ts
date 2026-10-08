import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AgentSession, ExtensionRunner, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import recursiveExtension from "../extensions/recursive.ts";

// Exercise the pinned Pi renderer, hook chain and provider projection, rather
// than duplicating how Pi composes sections or handles forced prompts.
const packageRoot = path.dirname(path.dirname(import.meta.resolve("@earendil-works/pi-coding-agent").replace("file://", "")));
const { buildSystemPromptSections } = await import(pathToFileURL(path.join(packageRoot, "dist/core/system-prompt.js")).href);
const scratch = mkdtempSync(path.join(tmpdir(), "ypi-prompt-sections-"));
chmodSync(scratch, 0o700);
const originalEnvironment = { ...process.env };
const baseline = process.env.YPI_PROMPT_PROBE_BASELINE === "1";
const anchor = readFileSync(new URL("../SYSTEM_PROMPT.md", import.meta.url), "utf8");
let shutdown: (() => Promise<void>) | undefined;

try {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("RLM_") || key.startsWith("YPI_") || key === "CONTEXT" || key === "PI_TRACE_FILE") delete process.env[key];
	}
	process.env.RLM_DEPTH = "0";
	process.env.RLM_SHARED_SESSIONS = "0";
	process.env.TMPDIR = scratch;
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const pi = {
		on(name: string, handler: (...args: any[]) => any) {
			handlers.set(name, [...(handlers.get(name) || []), handler]);
		},
		registerTool() {},
		getThinkingLevel: () => "medium",
		getAllTools: () => [{ name: "read" }, { name: "rlm_query" }],
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: process.cwd(), hasUI: false,
		model: { provider: "test", id: "test" },
		sessionManager: { getSessionFile: () => undefined, getSessionDir: () => scratch },
	} as unknown as ExtensionContext;
	recursiveExtension(pi);
	shutdown = async () => {
		for (const handler of handlers.get("session_shutdown") || []) await handler({ type: "session_shutdown" }, ctx);
	};
	const extension = { path: "ypi", handlers };
	function runner(extra: any[] = []) {
		const result = new ExtensionRunner([extension, ...extra] as any, {} as any, process.cwd(), ctx.sessionManager, {} as any);
		result.createContext = () => ctx;
		return result;
	}
	const options = { cwd: process.cwd(), selectedTools: ["read"], sections: {} };
	const plain = runner();
	const first = await plain.emitBeforeAgentStart("FIRST ROOT TURN", undefined, options);
	assert.equal(first.systemPromptOptions.forceSystemPrompt !== undefined, baseline, "append must not force the prompt");
	assert.ok((first.systemPromptOptions.forceSystemPrompt || first.systemPromptOptions.sections.ypi || "").includes(anchor), "ypi instructions are delivered");
	const promptPath = process.env.RLM_ROOT_PROMPT_FILE;
	const firstGeneration = process.env.YPI_TREE_GENERATION;
	const second = await plain.emitBeforeAgentStart("SECOND ROOT TURN", undefined, options);
	assert.equal(process.env.RLM_ROOT_PROMPT_FILE, promptPath, "root task-file path is stable");
	assert.equal(readFileSync(promptPath!, "utf8"), "SECOND ROOT TURN", "root charter contents refresh");
	assert.notEqual(process.env.YPI_TREE_GENERATION, firstGeneration, "tree generation rotates each root turn");
	const session = Object.assign(Object.create(AgentSession.prototype), {
		_runSystemPromptOptions: first.systemPromptOptions,
		_toolRegistry: new Map([["read", { name: "read" }]]),
		_toolDefinitions: new Map(),
		_getToolExposure: () => "direct",
		_isActivatable: () => true,
		agent: { state: { tools: [] }, transformContext: undefined },
	});
	const prepare = (AgentSession.prototype as any)._preparePromptAndToolLoadout;
	const initial = { role: "system", content: "", sections: buildSystemPromptSections(first.systemPromptOptions), toolsAdded: [{ name: "read" }], timestamp: 0 };
	const patch = prepare.call(session, second.systemPromptOptions, [initial]);
	assert.equal(patch?.sections?.ypi, undefined, "stable ypi section emits no patch on later turns");
	const messages = [initial, { role: "user", content: "test", timestamp: 1 }, { role: "system", content: "", toolsAdded: [{ name: "later_tool" }], timestamp: 2 }];
	(AgentSession.prototype as any)._installAgentForcedPromptProjection.call(session);
	const projected = await session.agent.transformContext(messages);
	assert.ok(getSystemMessageText(projected[0]).includes(anchor), "ypi text reaches provider projection");
	assert.equal(projected.filter((message: any) => message.role === "system").length, baseline ? 1 : 2, "later tool declaration remains later without a forced prompt");
	if (!baseline) {
		assert.deepEqual(projected[0].toolsAdded.map((tool: any) => tool.name), ["read"]);
		assert.deepEqual(projected[2].toolsAdded.map((tool: any) => tool.name), ["later_tool"]);
	}
	const forcing = (name: string) => ({ path: name, handlers: new Map([["before_agent_start", [(event: any) => ({ systemPrompt: `${event.systemPrompt}\n${name}` })]]]) });
	const mixed = await runner([forcing("honcho-fixture"), forcing("ap-fixture")]).emitBeforeAgentStart("MIXED ROOT", undefined, options);
	assert.ok(mixed.systemPromptOptions.forceSystemPrompt?.includes(anchor), "later forcing hooks preserve ypi instructions");
	assert.ok(mixed.systemPromptOptions.forceSystemPrompt?.endsWith("ap-fixture"), "forcing chain remains sequential");
	process.env.YPI_EXTENSION_PROMPT_MODE = "replace";
	const replaced = await plain.emitBeforeAgentStart("REPLACE ROOT", undefined, options);
	assert.ok(replaced.systemPromptOptions.forceSystemPrompt?.startsWith(anchor), "replace retains exact ypi head");
	assert.ok(!replaced.systemPromptOptions.forceSystemPrompt?.includes("You are an expert coding assistant"), "replace omits Pi base prompt");
	// Probe #10267 through the real run/next-turn lifecycle without a model call.
	// This diagnostic must be checked before enabling userless notification turns.
	Object.assign(session, {
		_baseSystemPromptOptions: { ...first.systemPromptOptions, sections: {}, forceSystemPrompt: undefined },
		_runSystemPromptOptions: first.systemPromptOptions,
		_pendingToolNames: new Set(),
		_recordSelection() {},
		_handlePostAgentRun: async () => false,
		_runBeforeSettleBoundary: async () => false,
		_flushPendingBashMessages() {},
		_flushPendingCustomMessages() {},
		_emitAgentSettled: async () => {},
		getActiveToolNames: () => ["read"],
		_compactBeforeNextAssistantResponse: async (context: any) => context,
	});
	(AgentSession.prototype as any)._installAgentNextTurnRefresh.call(session);
	let carriesYpi = false;
	session.agent.prompt = async () => {
		await session.agent.prepareNextTurnWithContext({ context: { messages: [initial] } });
		carriesYpi = Boolean(session._runSystemPromptOptions?.sections.ypi);
	};
	await (AgentSession.prototype as any)._runAgentPrompt.call(session, []);
	assert.ok(carriesYpi, "user-started run retains the ypi section");
	await (AgentSession.prototype as any)._runAgentPrompt.call(session, []);
	console.log(JSON.stringify({ userlessPromptCanary: carriesYpi ? "SUPPORTED" : "UNSUPPORTED", issue: 10267, notificationTurnsEnabledByYpi: false }));
	console.log(JSON.stringify({ promptSections: "PASS", variant: baseline ? "baseline" : "sections", appendForced: baseline, laterToolHoisted: baseline, stableSection: true, mixedHooksPreserveYpi: true, replaceUnchanged: true }));
} finally {
	await shutdown?.();
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, originalEnvironment);
	rmSync(scratch, { recursive: true, force: true });
}
