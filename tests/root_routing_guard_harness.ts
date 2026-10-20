import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import recursiveExtension from "../extensions/recursive.ts";

const saved = { ...process.env };
const scratch = mkdtempSync(path.join(tmpdir(), "ypi-root-route-guard-"));
const good = { provider: "fixture-pool", id: "gpt-6.1-sol", reasoning: true };
let requests = 0;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { requests++; return new Response("unexpected native request", { status: 500 }); } });
try {
	for (const scenario of ["missing-provider", "missing-catalog", "set-model-false", "set-model-throws", "success", "explicit-root", "restored", "unset-override"]) {
		for (const key of Object.keys(process.env)) if (key.startsWith("RLM_") || key.startsWith("YPI_") || key === "PI_TRACE_FILE") delete process.env[key];
		process.env.HOME = scratch;
		process.env.PI_CODING_AGENT_DIR = scratch;
		process.env.RLM_SHARED_SESSIONS = "0";
		process.env.RLM_DEPTH = "0";
		process.env.TMPDIR = scratch;
		process.env.YPI_ROOT_AUTO_ROUTE = scenario === "explicit-root" ? "0" : "1";
		if (scenario !== "unset-override") process.env.YPI_MODEL_ROUTING_PROVIDER = "fixture-pool";
		let available: typeof good[] | undefined = scenario === "missing-catalog" ? undefined : scenario === "missing-provider" ? [] : [good];
		let activate = scenario !== "set-model-false";
		let throws = scenario === "set-model-throws";
		let modelSelections = 0;
		let aborted = 0;
		const errors: string[] = [];
		const handlers = new Map<string, Array<(...args: any[]) => any>>();
		const context = {
			cwd: scratch, hasUI: true, scopedModels: [], model: { provider: "ambient-native", id: "ambient" },
			modelRegistry: { getAvailable: () => available },
			sessionManager: { getEntries: () => scenario === "restored" ? [{ type: "message" }] : [], getSessionFile: () => undefined, getSessionDir: () => scratch },
			ui: { notify: (message: string) => errors.push(message), setStatus() {}, setTitle() {}, theme: { fg: (_: string, text: string) => text } },
			abort: () => { aborted++; },
		} as unknown as ExtensionContext;
		const pi = {
			on(event: string, handler: (...args: any[]) => any) { handlers.set(event, [...(handlers.get(event) || []), handler]); },
			registerTool() {}, getAllTools: () => [{ name: "read" }],
			getThinkingLevel: () => "medium", setThinkingLevel() {},
			async setModel() { modelSelections++; if (throws) throw new Error("fixture model activation failure"); return activate; },
		} as unknown as ExtensionAPI;
		const emit = async (event: string, data: object) => {
			let result: any;
			for (const handler of handlers.get(event) || []) { const value = await handler({ type: event, ...data }, context); if (value !== undefined) result = value; }
			return result;
		};
		recursiveExtension(pi);
		try {
			await emit("session_start", { reason: "startup" });
			const blocked = ["missing-provider", "missing-catalog", "set-model-false", "set-model-throws"].includes(scenario);
			for (const source of ["interactive", "rpc", "extension"]) {
				const input = await emit("input", { text: "do not generate", source });
				assert.equal(input.action, blocked ? "handled" : "continue", `${scenario}/${source}`);
			}
			if (blocked) {
				assert(errors.some((message) => message.includes("automatic root routing blocked")), `${scenario} visible error`);
				// Real pinned agent loop plus real native provider adapter: custom
				// extension messages bypass input, but abort at agent_start prevents HTTP.
				const model: Model<"openai-completions"> = { ...good, provider: "ambient-native", api: "openai-completions", name: "fixture native", baseUrl: `http://127.0.0.1:${server.port}/v1`, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
				const agent = new Agent({ initialState: { model }, streamFn: streamSimple, getApiKey: () => "synthetic" });
				context.abort = () => { aborted++; agent.abort(); };
				agent.subscribe(async (event) => { if (event.type === "agent_start") await emit("agent_start", {}); });
				await agent.prompt({ role: "user", content: [{ type: "text", text: "extension-triggered fixture" }], timestamp: Date.now() });
				assert(aborted > 0, `${scenario}: extension bypass aborted`);
				assert.equal(requests, 0, `${scenario}: no native HTTP traffic`);
				assert.equal(agent.state.messages.at(-1)?.role, "assistant");
				assert.equal((agent.state.messages.at(-1) as any).stopReason, "aborted");
				available = [good]; activate = true; throws = false;
				assert.equal((await emit("input", { text: "recovered", source: "interactive" })).action, "continue");
				assert.equal(process.env.RLM_PROVIDER, "fixture-pool");
				const prior = modelSelections;
				assert.equal((await emit("input", { text: "normal", source: "interactive" })).action, "continue");
				assert.equal(modelSelections, prior, "successful route does not reselect every prompt");
				const priorAborts = aborted;
				await emit("agent_start", {});
				assert.equal(aborted, priorAborts, "recovered route permits generation");
			} else {
				await emit("agent_start", {});
				assert.equal(aborted, 0);
				assert.deepEqual(errors, []);
				if (["explicit-root", "restored", "unset-override"].includes(scenario)) assert.equal(modelSelections, 0);
			}
			console.log(`PASS root routing guard ${scenario}`);
		} finally { await emit("session_shutdown", { reason: "test" }); }
	}
	console.log("ROOT_ROUTING_GUARD PASS: input consumed, extension bypass aborted, zero native requests, recovery and explicit routes preserved");
} finally {
	server.stop(true);
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, saved);
	rmSync(scratch, { recursive: true, force: true });
}
