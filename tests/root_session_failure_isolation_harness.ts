import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import recursiveExtension from "../extensions/recursive.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "ypi-root-failure-isolation-"));
chmodSync(scratch, 0o700);
let pass = 0;
let fail = 0;

function record(ok: boolean, label: string): void {
	if (ok) {
		pass++;
		console.log(`  PASS ${label}`);
	} else {
		fail++;
		console.error(`  FAIL ${label}`);
	}
}

const savedEnvironment = { ...process.env };
try {
	console.log("\n=== Root session hardening failure isolation ===");
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("RLM_") || key.startsWith("YPI_") || key === "PI_TRACE_FILE") {
			delete process.env[key];
		}
	}
	process.env.RLM_DEPTH = "0";
	process.env.RLM_SHARED_SESSIONS = "1";
	process.env.TMPDIR = scratch;

	const realSessionDir = path.join(scratch, "real-sessions");
	const aliasedSessionDir = path.join(scratch, "aliased-sessions");
	mkdirSync(realSessionDir, { mode: 0o700 });
	symlinkSync(realSessionDir, aliasedSessionDir, "dir");
	const unsafeTarget = path.join(scratch, "unsafe-target.jsonl");
	writeFileSync(unsafeTarget, "{}\n", { mode: 0o600 });
	const aliasedSessionFile = path.join(aliasedSessionDir, "active.jsonl");
	symlinkSync(unsafeTarget, aliasedSessionFile);

	const notifications: string[] = [];
	const statuses: string[] = [];
	const handlers = new Map<string, (...args: any[]) => any>();
	const context = {
		hasUI: true,
		model: { provider: "failure-provider", id: "failure-model" },
		sessionManager: {
			getSessionFile: () => aliasedSessionFile,
			getSessionDir: () => aliasedSessionDir,
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, value: string) => statuses.push(value),
			setTitle: () => undefined,
			theme: { fg: (_color: string, value: string) => value },
		},
	} as unknown as ExtensionContext;
	const pi = {
		registerTool: () => undefined,
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		getThinkingLevel: () => "high",
		getAllTools: () => [{ name: "read" }, { name: "rlm_query" }],
	} as unknown as ExtensionAPI;

	recursiveExtension(pi);
	handlers.get("session_start")?.({ type: "session_start" }, context);
	record(!process.env.RLM_SESSION_FILE && !process.env.YPI_ROOT_SESSION_FILE_IDENTITY, "unsafe root path is removed from analytics projection");
	record(notifications.length === 1 && notifications[0].includes("telemetry disabled"), "hardening failure emits one bounded warning");
	record(statuses.at(-1)?.includes("session telemetry") === true, "hardening failure remains visible in status");

	const first = handlers.get("before_agent_start")?.({
		type: "before_agent_start",
		prompt: "FIRST ROOT TURN",
		systemPrompt: "base prompt",
		systemPromptOptions: { cwd: process.cwd() },
	}, context);
	const firstGeneration = process.env.YPI_TREE_GENERATION;
	const second = handlers.get("before_agent_start")?.({
		type: "before_agent_start",
		prompt: "SECOND ROOT TURN",
		systemPrompt: "base prompt",
		systemPromptOptions: { cwd: process.cwd() },
	}, context);
	const secondGeneration = process.env.YPI_TREE_GENERATION;
	record(first?.systemPrompt !== "base prompt" && second?.systemPrompt !== "base prompt", "system prompt patch survives repeated hardening failures");
	record(Boolean(firstGeneration && secondGeneration && firstGeneration !== secondGeneration), "root generation rotates despite repeated hardening failures");
	record(process.env.RLM_MODEL === "failure-model" && process.env.RLM_THINKING_LEVEL === "high", "model and thinking refresh survive hardening failure");
	record(notifications.length === 1, "repeated identical hardening failures are notification-deduplicated");

	unlinkSync(aliasedSessionFile);
	writeFileSync(aliasedSessionFile, "{}\n", { mode: 0o664 });
	handlers.get("turn_end")?.({ type: "turn_end" }, context);
	const canonicalSessionFile = path.join(realpathSync.native(realSessionDir), "active.jsonl");
	record(process.env.RLM_SESSION_FILE === canonicalSessionFile, "recovered session projects its canonical pathname");
	record(process.env.RLM_SESSION_DIR === realpathSync.native(realSessionDir), "recovered session directory is canonical");
	record(Boolean(process.env.YPI_ROOT_SESSION_FILE_IDENTITY) && (lstatSync(canonicalSessionFile).mode & 0o777) === 0o600, "valid replacement recovers hardened root analytics");
	record(statuses.at(-1)?.includes("session telemetry") === false, "successful recovery clears the warning status");

	await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "test" }, context);
} finally {
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, savedEnvironment);
	rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
