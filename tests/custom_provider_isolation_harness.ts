import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireChildResources } from "../extensions/ypi/internal/child-resources.ts";

const fixture = mkdtempSync(path.join(tmpdir(), "ypi_custom_provider_"));
const parent = path.join(fixture, "parent");
mkdirSync(parent);
const previous = { ...process.env };
process.env.HOME = fixture;
process.env.PI_CODING_AGENT_DIR = "~/parent";
process.env.RLM_SHARED_SESSIONS = "0";
process.env.RLM_REQUIRE_TRANSCRIPTS = "0";
const selected = {
	baseUrl: "http://127.0.0.1:1/v1",
	api: "openai-completions",
	apiKey: "synthetic-not-a-secret",
	headers: { "X-Test": "selected" },
	models: [{ id: "ypi-isolated-alias", name: "Isolated alias", contextWindow: 8192, maxTokens: 1024 }],
	modelOverrides: { "ypi-isolated-alias": { name: "Projected override" } },
};
const configPath = path.join(parent, "models.json");
function configure(value: unknown): void { writeFileSync(configPath, JSON.stringify(value)); }
function acquire(provider: string | undefined = "codex-lb") {
	return acquireChildResources({ prompt: "fixture", cwd: fixture, childDepth: 1, callCount: 1,
		fullResourceIsolation: true, selectedProvider: provider, mode: "review" });
}
function checkProjection(provider: string, value: unknown, realPi = false): void {
	configure({ providers: { other: "unselected-invalid-provider", [provider]: value }, ambient: "excluded" });
	const lease = acquire(provider);
	const isolated = lease.isolatedPiRoot!;
	const agent = path.join(isolated, "agent");
	try {
		assert.deepEqual(JSON.parse(readFileSync(path.join(agent, "models.json"), "utf8")), { providers: { [provider]: value } });
		assert.deepEqual(readdirSync(agent).sort(), ["auth.json", "models-store.json", "models.json"]);
		for (const directory of [isolated, agent]) assert.equal(statSync(directory).mode & 0o777, 0o700);
		for (const file of readdirSync(agent)) assert.equal(statSync(path.join(agent, file)).mode & 0o777, 0o600);
		assert.deepEqual(JSON.parse(readFileSync(path.join(agent, "auth.json"), "utf8")), { [provider]: { type: "api_key", key: "fixture-key" } });
		if (realPi) {
			const child = spawnSync("pi", ["--list-models", "ypi-isolated-alias"], {
				cwd: fixture, encoding: "utf8", timeout: 60_000,
				env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" },
			});
			assert.equal(child.status, 0, `offline Pi list-models failed: ${child.stderr}`);
			assert.match(child.stdout, /codex-lb/);
			assert.match(child.stdout, /ypi-isolated-alias/);
		}
	} finally {
		assert.deepEqual(lease.cleanup(), []);
		assert.equal(existsSync(isolated), false);
	}
}
try {
	// No actual workstation credentials/configuration are accessed by this harness.
	writeFileSync(path.join(parent, "auth.json"), JSON.stringify({
		"codex-lb": { type: "api_key", key: "fixture-key" }, other: { type: "api_key", key: "ambient-secret" },
	}));
	writeFileSync(path.join(parent, "settings.json"), '{"extensions":["ambient"]}');
	mkdirSync(path.join(parent, "extensions"));
	checkProjection("codex-lb", selected, true);
	for (const provider of ["__proto__", "constructor", "toString"]) {
		writeFileSync(path.join(parent, "auth.json"), JSON.stringify({ [provider]: { type: "api_key", key: "fixture-key" } }));
		checkProjection(provider, selected);
	}
	for (const config of [undefined, { providers: { other: selected } }, { providers: {} }]) {
		if (config === undefined) rmSync(configPath, { force: true }); else configure(config);
		const lease = acquire();
		const isolated = lease.isolatedPiRoot!;
		assert.equal(existsSync(path.join(isolated, "agent", "models.json")), false);
		assert.deepEqual(lease.cleanup(), []);
		assert.equal(existsSync(isolated), false);
	}
	configure({ providers: { constructor: selected } });
	const inherited = acquire("toString");
	assert.equal(existsSync(path.join(inherited.isolatedPiRoot!, "agent", "models.json")), false);
	assert.deepEqual(inherited.cleanup(), []);
	for (const bad of [null, [], "sensitive-marker", {}, { providers: [] }, { providers: null },
		{ providers: { "codex-lb": null } }, { providers: { "codex-lb": [] } },
		{ providers: { "codex-lb": { models: {} } } }, { providers: { "codex-lb": { models: [null] } } },
		{ providers: { "codex-lb": { modelOverrides: [] } } },
		{ providers: { "codex-lb": { modelOverrides: { example: "sensitive-marker" } } } },
		{ providers: { "codex-lb": { headers: { Authorization: 1 }, apiKey: "sensitive-marker" } } }]) {
		configure(bad);
		assert.throws(() => acquire(), (error: unknown) => error instanceof Error
			&& error.message === "Full child isolation could not project selected provider configuration: parent models.json is invalid");
	}
	writeFileSync(configPath, '{"sensitive-marker');
	assert.throws(() => acquire(), /parent models.json is invalid$/);
	// No provider means builtin behavior; malformed ambient config is never read.
	const builtin = acquire("");
	assert.equal(existsSync(path.join(builtin.isolatedPiRoot!, "agent", "models.json")), false);
	assert.deepEqual(builtin.cleanup(), []);
	// Explicit configured directories and tilde-only resolution use the same owner.
	process.env.PI_CODING_AGENT_DIR = parent;
	writeFileSync(path.join(parent, "auth.json"), '{"codex-lb":{"type":"api_key","key":"fixture-key"}}');
	checkProjection("codex-lb", selected);
	process.env.HOME = parent;
	process.env.PI_CODING_AGENT_DIR = "~";
	checkProjection("codex-lb", selected);
	const defaultHome = path.join(fixture, "default-home");
	const defaultAgent = path.join(defaultHome, ".pi", "agent");
	mkdirSync(defaultAgent, { recursive: true });
	writeFileSync(path.join(defaultAgent, "models.json"), JSON.stringify({ providers: { "codex-lb": selected } }));
	process.env.HOME = defaultHome;
	delete process.env.PI_CODING_AGENT_DIR;
	const defaultLease = acquire();
	assert.deepEqual(JSON.parse(readFileSync(path.join(defaultLease.isolatedPiRoot!, "agent", "models.json"), "utf8")), { providers: { "codex-lb": selected } });
	assert.deepEqual(defaultLease.cleanup(), []);
	console.log("CUSTOM_PROVIDER_ISOLATION PASS: selected-only projection, private modes, malformed input, prototype keys, offline Pi alias, cleanup");
} finally {
	for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
	Object.assign(process.env, previous);
	rmSync(fixture, { recursive: true, force: true });
}
