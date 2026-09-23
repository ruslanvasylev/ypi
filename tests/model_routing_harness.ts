import { strict as assert } from "node:assert";
import { createJsonDecoder } from "../extensions/ypi/internal/child-output.ts";
import { catalogFromEnvironment, resolveRoute, routingCatalogSnapshot, selectRootDefault, type RouteModel } from "../extensions/ypi/internal/model-routing.ts";

const catalog: RouteModel[] = [
	{ provider: "openai-codex", id: "gpt-6.9-sol", reasoning: true, input: ["text"] },
	{ provider: "openai-codex", id: "gpt-6.10-sol", reasoning: true, input: ["text"] },
	{ provider: "openai-codex", id: "gpt-6.11-sol", reasoning: false, input: ["text"] },
	{ provider: "openai-codex", id: "gpt-6.12-sol", reasoning: true, input: ["text"], thinkingLevelMap: { medium: null } },
	{ provider: "openai-codex", id: "gpt-6-sol", reasoning: true, input: ["text"] },
	{ provider: "openai-codex", id: "gpt-6-luna", reasoning: true, input: ["text"] },
	{ provider: "openai-codex", id: "gpt-6-astra", reasoning: true, input: ["text"], thinkingLevelMap: { max: null } },
];
const prior = { ...process.env };
try {
	for (const key of Object.keys(process.env)) if (key.startsWith("RLM_") || key.startsWith("YPI_")) delete process.env[key];
	process.env.YPI_MODEL_CATALOG = routingCatalogSnapshot(catalog);
	assert.deepEqual(catalogFromEnvironment(), catalog);
	assert.equal(selectRootDefault(catalog)?.model, "gpt-6.10-sol");
	const parent = { provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "xhigh" };
	const [worker, explorer, reviewer] = await Promise.all([
		Promise.resolve(resolveRoute(parent, 1)),
		Promise.resolve(resolveRoute(parent, 1, { profile: "explorer" })),
		Promise.resolve(resolveRoute(parent, 1, { profile: "reviewer" })),
	]);
	assert.deepEqual([worker.model, worker.thinkingLevel], ["gpt-6.10-sol", "medium"]);
	assert.deepEqual([explorer.model, explorer.thinkingLevel], ["gpt-6-luna", "medium"]);
	assert.deepEqual([reviewer.model, reviewer.thinkingLevel], ["gpt-6-astra", "high"]);
	assert.equal(resolveRoute(parent, 1, { profile: "inherit" }).thinkingLevel, "xhigh");
	process.env.RLM_CHILD_MODEL = "gpt-6-luna";
	process.env.RLM_CHILD_THINKING_LEVEL = "low";
	assert.deepEqual([resolveRoute(parent, 1).model, resolveRoute(parent, 1).thinkingLevel], ["gpt-6-luna", "low"]);
	assert.deepEqual([resolveRoute(parent, 1, { profile: "reviewer" }).model, resolveRoute(parent, 1, { profile: "reviewer" }).thinkingLevel], ["gpt-6-astra", "high"]);
	assert.equal(resolveRoute(parent, 1, { provider: "openai-codex", model: "gpt-6-sol", thinkingLevel: "medium" }).model, "gpt-6-sol");
	assert.equal(resolveRoute(parent, 1, { profile: "inherit" }).model, "gpt-6-astra");
	const first = resolveRoute(parent, 1, { escalation: { previousAttempt: "c1", issue: "proof omitted a case", kind: "correctness", stage: 1 } });
	const second = resolveRoute(parent, 1, { escalation: { previousAttempt: "c2", issue: "proof still fails", kind: "reasoning", stage: 2 } });
	assert.deepEqual([first.model, first.thinkingLevel], ["gpt-6.12-sol", "high"]);
	assert.deepEqual([second.model, second.thinkingLevel], ["gpt-6-astra", "high"]);
	delete process.env.RLM_CHILD_MODEL;
	delete process.env.RLM_CHILD_THINKING_LEVEL;
	assert.equal(resolveRoute(parent, 1).thinkingLevel, "medium");
	assert.throws(() => resolveRoute(parent, 1, { profile: "inherit", thinkingLevel: "high" }), /cannot combine/);
	assert.throws(() => resolveRoute(parent, 1, { provider: "openai-codex" }), /provider and model together/);
	assert.throws(() => resolveRoute(parent, 1, { profile: "reviewer", provider: "openai-codex", model: "gpt-6-sol" }), /Choose a ypi profile/);
	assert.throws(() => resolveRoute(parent, 1, { profile: "explorer", escalation: { previousAttempt: "c1", issue: "case", kind: "reasoning", stage: 1 } }), /selects its own profile/);
	assert.throws(() => resolveRoute(parent, 1, { provider: "openai-codex", model: "gpt-99-sol" }), /unavailable/);
	assert.throws(() => resolveRoute(parent, 1, { profile: "reviewer", thinkingLevel: "max", justification: "still unresolved" }), /justified stage-2/);
	assert.throws(() => resolveRoute(parent, 1, { thinkingLevel: "xhigh" }), /justified stage-2/);
	assert.equal(resolveRoute(parent, 1, { thinkingLevel: "xhigh", userChosenHighEffort: true }).thinkingLevel, "xhigh");
	assert.equal(resolveRoute(parent, 1, { thinkingLevel: "xhigh", justification: "proof still fails", escalation: { previousAttempt: "c2", issue: "proof still fails", kind: "correctness", stage: 2 } }).model, "gpt-6-astra");
	assert.throws(() => resolveRoute(parent, 1, { escalation: { previousAttempt: "", issue: "", kind: "reasoning", stage: 1 } }), /previous attempt/);
	process.env.RLM_AMBIENT_EXTENSIONS = "1";
	assert.deepEqual(resolveRoute(parent, 1), worker);
	process.env.RLM_AMBIENT_EXTENSIONS = "0";
	assert.deepEqual(resolveRoute(parent, 1), worker);
	const decoder = createJsonDecoder();
	decoder.append(`${JSON.stringify({ type: "turn_end", message: { provider: "openai-codex", model: "gpt-6-sol", usage: { input: 1, output: 1 } } })}\n`);
	decoder.finish();
	assert.deepEqual(decoder.result().actualModel, { provider: "openai-codex", model: "gpt-6-sol" });
	delete process.env.YPI_MODEL_CATALOG;
	assert.equal(resolveRoute(parent, 1).model, parent.model);
	assert.throws(() => resolveRoute(parent, 1, { profile: "explorer" }), /needs Pi's authenticated model catalog/);
	console.log("MODEL_ROUTING=PASS");
} finally {
	for (const key of Object.keys(process.env)) if (key.startsWith("RLM_") || key.startsWith("YPI_")) delete process.env[key];
	Object.assign(process.env, prior);
}
