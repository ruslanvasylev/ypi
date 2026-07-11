import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureEnvironment } from "../extensions/ypi/env.ts";
import { registerNativeRlmQueryTool } from "../extensions/ypi/native-tool.ts";
import { resolveRuntime } from "../extensions/ypi/runtime.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];

const projectRoot = path.resolve(import.meta.dir, "..");
const scratch = mkdtempSync(path.join(tmpdir(), "ypi_native_tool_test."));
const fakePi = path.join(scratch, "pi");
const logFile = path.join(scratch, "fake-pi.log");
const sessionDir = path.join(scratch, "sessions");
mkdirSync(sessionDir, { recursive: true });

let pass = 0;
let fail = 0;

function record(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		fail++;
		console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
	}
}

function assertContains(label: string, haystack: string, needle: string): void {
	record(haystack.includes(needle), label, `expected ${JSON.stringify(needle)} in ${JSON.stringify(haystack.slice(0, 500))}`);
}

function assertNotContains(label: string, haystack: string, needle: string): void {
	record(!haystack.includes(needle), label, `did not expect ${JSON.stringify(needle)} in ${JSON.stringify(haystack.slice(0, 500))}`);
}

function clearYpiEnv(): void {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("RLM_") || key.startsWith("YPI_") || key === "CONTEXT" || key === "PI_TRACE_FILE" || key === "SECRET_TOKEN") {
			delete process.env[key];
		}
	}
	process.env.TMPDIR = scratch;
	process.env.YPI_PI_BIN = fakePi;
	process.env.YPI_FAKE_PI_LOG = logFile;
	// The harness explicitly chooses no-jj read-only mode unless a case overrides it.
	process.env.RLM_JJ = "0";
}

function resetLog(): void {
	writeFileSync(logFile, "");
}

function readLog(): string {
	return existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
}

writeFileSync(fakePi, `#!/usr/bin/env bash
{
  echo "ARGS: $*"
  echo "RLM_DEPTH=$RLM_DEPTH"
  echo "RLM_MODEL=$RLM_MODEL"
  echo "RLM_PROVIDER=$RLM_PROVIDER"
  echo "RLM_THINKING_LEVEL=\${RLM_THINKING_LEVEL:-unset}"
  echo "RLM_CALL_COUNT=$RLM_CALL_COUNT"
  echo "RLM_SESSION_FILE=\${RLM_SESSION_FILE:-unset}"
  echo "RLM_SESSION_DIR=\${RLM_SESSION_DIR:-unset}"
  echo "RLM_CALL_COUNTER_FILE=\${RLM_CALL_COUNTER_FILE:-unset}"
  echo "RLM_COST_FILE=\${RLM_COST_FILE:-unset}"
  echo "SECRET_TOKEN=\${SECRET_TOKEN:-unset}"
  echo "CHILD_PID=$$"
} >> "$YPI_FAKE_PI_LOG"
if [ "\${YPI_FAKE_PI_MODE:-ok}" = "fail" ]; then
  echo "fake child failure" >&2
  exit 42
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "huge" ]; then
  head -c $((17 * 1024 * 1024)) /dev/zero | tr '\\0' X
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "json" ]; then
  printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"JSON_CHILD_OK"}}'
  printf '%s\\n' '{"type":"turn_end","message":{"usage":{"totalTokens":7,"cost":{"total":0.123}}},"toolResults":[]}'
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "json-huge-tail" ]; then
  printf '%s' '{"type":"tool_result","payload":"'
  head -c $((17 * 1024 * 1024)) /dev/zero | tr '\\0' X
  printf '%s\\n' '"}'
  printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"LATE_JSON_OK"}}'
  printf '%s\\n' '{"type":"turn_end","message":{"usage":{"totalTokens":11,"cost":{"total":0.456}}},"toolResults":[]}'
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "json-huge-turn-end" ]; then
  printf '%s' '{"type":"turn_end","message":{"usage":{"totalTokens":99,"cost":{"total":9.99}}},"toolResults":["'
  head -c $((17 * 1024 * 1024)) /dev/zero | tr '\\0' X
  printf '%s\\n' '"]}'
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "sleep" ]; then
  sleep 30
else
  echo "FAKE_CHILD_OK"
fi
`);
chmodSync(fakePi, 0o755);

// Do not let a parent ypi session's YPI_EXTENSION_ROOT redirect this harness
// away from the worktree under test.
process.env.YPI_EXTENSION_ROOT = projectRoot;
const runtime = resolveRuntime(new URL("../extensions/recursive.ts", import.meta.url).href);
let tool: Tool | undefined;
const pi = {
	registerTool(registered: Tool) {
		tool = registered;
	},
	getThinkingLevel() {
		return "xhigh";
	},
	getAllTools() {
		return [
			{ name: "read" },
			{ name: "bash" },
			{ name: "edit" },
			{ name: "write" },
			{ name: "rlm_query" },
			{ name: "installed_status" },
			{ name: "installed_context_pack" },
		];
	},
} as Pick<ExtensionAPI, "registerTool" | "getThinkingLevel" | "getAllTools"> as ExtensionAPI;

function context(): ExtensionContext {
	return {
		cwd: projectRoot,
		model: { provider: "test-provider", id: "test-root-model" },
		sessionManager: {
			getSessionFile: () => path.join(sessionDir, "parent.jsonl"),
			getSessionDir: () => sessionDir,
		},
	} as ExtensionContext;
}

async function invoke(prompt = "child prompt", signal?: AbortSignal): Promise<string> {
	if (!tool) throw new Error("native tool was not registered");
	const result = await tool.execute("test-call", { prompt }, signal, undefined, context());
	const text = result.content.find((item) => item.type === "text")?.text || "";
	return text;
}

async function expectThrow(label: string, expected: string, fn: () => Promise<unknown>): Promise<void> {
	try {
		await fn();
		record(false, label, "expected throw");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		record(message.includes(expected), label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(message)}`);
	}
}

async function run(): Promise<void> {
	console.log("");
	console.log("=== Native rlm_query Tool Harness ===");

	clearYpiEnv();
	ensureEnvironment(runtime, context());
	registerNativeRlmQueryTool(pi, runtime);
	record(Boolean(tool), "native tool registered");

	clearYpiEnv();
	process.env.RLM_DEPTH = "1";
	process.env.RLM_MAX_DEPTH = "1";
	ensureEnvironment(runtime, context());
	await expectThrow("N1: max depth throws", "Max depth exceeded", () => invoke());

	// N1b: a non-integer depth config fails closed instead of bypassing the limiter.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "abc";
	ensureEnvironment(runtime, context());
	await expectThrow("N1b: non-integer RLM_MAX_DEPTH fails closed", "Invalid recursion depth config", () => invoke());
	assertNotContains("N1b: malformed depth did not spawn child", readLog(), "ARGS:");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0junk";
	process.env.RLM_MAX_DEPTH = "2";
	ensureEnvironment(runtime, context());
	await expectThrow("N1c: integer-prefix RLM_DEPTH fails closed", "Invalid recursion depth config", () => invoke());
	assertNotContains("N1c: integer-prefix depth did not spawn child", readLog(), "ARGS:");

	// N2: RLM_MAX_CALLS=N permits exactly N calls; the (N+1)th is blocked before spawning.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_MAX_CALLS = "1";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	const n2First = await invoke();
	assertContains("N2: max calls allows the first call", n2First, "FAKE_CHILD_OK");
	resetLog();
	await expectThrow("N2: max calls throws on the second call", "Max calls exceeded", () => invoke());
	assertNotContains("N2: blocked second call did not spawn child", readLog(), "ARGS:");

	// N3: a depth>0 child that inherited a stale tree start time still hits the timeout guard.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "1";
	process.env.RLM_MAX_DEPTH = "3";
	process.env.RLM_TIMEOUT = "1";
	process.env.RLM_START_TIME = String(Math.floor(Date.now() / 1000) - 5);
	ensureEnvironment(runtime, context());
	await expectThrow("N3: expired timeout throws before spawn", "Timeout exceeded", () => invoke());
	assertNotContains("N3: expired timeout did not spawn child", readLog(), "ARGS:");

	// N12: a fresh depth-0 call re-anchors the budget, so a stale session start time does not
	// make a long-running root Pi immediately time out.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_TIMEOUT = "30";
	process.env.RLM_JSON = "0";
	process.env.RLM_START_TIME = String(Math.floor(Date.now() / 1000) - 600);
	ensureEnvironment(runtime, context());
	const n12 = await invoke();
	assertContains("N12: depth-0 re-anchors a stale timeout budget", n12, "FAKE_CHILD_OK");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.YPI_FAKE_PI_MODE = "fail";
	ensureEnvironment(runtime, context());
	await expectThrow("N4: nonzero child exit throws", "Child Pi exited with 42", () => invoke());

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JJ = "0";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	const readOnlyText = await invoke();
	assertContains("N5: child stdout returned", readOnlyText, "FAKE_CHILD_OK");
	assertContains("N5: no-jj child excludes built-in mutators", readLog(), "--exclude-tools bash,edit,write");
	assertNotContains("N5: no-jj child avoids a global tool allowlist", readLog(), "--tools ");

	// N5b: an oversized child stream is drained but retained only to the bounded
	// capture limit. This protects the parent from V8's maximum string length.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JJ = "0";
	process.env.RLM_UNSAFE_NO_JJ_WRITE = "1";
	process.env.RLM_JSON = "0";
	process.env.YPI_FAKE_PI_MODE = "huge";
	ensureEnvironment(runtime, context());
	const oversizedText = await invoke();
	assertContains("N5b: oversized stdout reports streaming capture bound", oversizedText, "Child stdout diagnostic capture exceeded 16777216 characters");
	record(oversizedText.length < 70 * 1024, "N5b: oversized stdout result stays near final tool-output cap", `length=${oversizedText.length}`);

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_SHARED_SESSIONS = "0";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	await invoke();
	assertContains("N6: shared sessions off uses no-session", readLog(), "--no-session");
	assertContains("N6: shared sessions off clears session env", readLog(), "RLM_SESSION_FILE=unset");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_CHILD_MODEL = "child-model";
	process.env.RLM_CHILD_PROVIDER = "child-provider";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	await invoke();
	assertContains("N7: root-to-child uses child model", readLog(), "--model child-model");
	assertContains("N7: root-to-child uses child provider", readLog(), "--provider child-provider");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "1";
	process.env.RLM_MAX_DEPTH = "3";
	process.env.RLM_PROVIDER = "openai";
	process.env.RLM_MODEL = "gpt-5.5:xhigh";
	process.env.RLM_THINKING_LEVEL = "xhigh";
	process.env.RLM_CHILD_MODELS = "gpt-5.5:high,gpt-5.5:medium";
	process.env.RLM_CHILD_THINKING_LEVELS = "high,medium";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context(), pi);
	await invoke();
	assertContains("N7b: second-depth child model selected", readLog(), "--model gpt-5.5:medium");
	assertContains("N7b: second-depth child thinking selected", readLog(), "--thinking medium");
	assertContains("N7b: child thinking env selected", readLog(), "RLM_THINKING_LEVEL=medium");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_PROVIDER = "stale-provider";
	process.env.RLM_MODEL = "stale-model";
	process.env.RLM_THINKING_LEVEL = "low";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context(), pi);
	await invoke();
	assertContains("N7c: stale provider refreshed from active root", readLog(), "--provider test-provider");
	assertContains("N7c: stale model refreshed from active root", readLog(), "--model test-root-model");
	assertContains("N7c: stale thinking refreshed from active root", readLog(), "--thinking xhigh");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	await invoke();
	assertNotContains("N8: ambient extension discovery is enabled by default", readLog(), "--no-extensions");
	assertNotContains("N8: skill discovery is enabled by default", readLog(), "--no-skills");
	assertContains("N8: ypi extension remains explicit", readLog(), `-e ${runtime.extensionPath}`);

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_CHILD_EXTENSIONS = "0";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	await invoke();
	assertContains("N8b: child extension override disables extensions", readLog(), "--no-extensions");
	assertContains("N8b: extension-isolated child keeps system prompt", readLog(), `--system-prompt ${runtime.systemPromptPath}`);
	assertNotContains("N8b: child extension override avoids explicit extension", readLog(), "-e ");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_CHILD_DISCOVERY = "0";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	await invoke();
	assertContains("N8c: child discovery override disables non-extension skill discovery", readLog(), "--no-skills");
	assertContains("N8c: child discovery override disables context files", readLog(), "--no-context-files");
	assertNotContains("N8c: child discovery override keeps extensions enabled", readLog(), "--no-extensions");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_CHILD_DISCOVERY = "0";
	process.env.RLM_CHILD_EXTENSIONS = "0";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	await invoke();
	assertContains("N8d: full child isolation disables extensions", readLog(), "--no-extensions");
	assertContains("N8d: full child isolation disables non-extension skills", readLog(), "--no-skills");
	assertContains("N8d: full child isolation keeps system prompt", readLog(), `--system-prompt ${runtime.systemPromptPath}`);
	assertNotContains("N8d: full child isolation avoids explicit ypi extension", readLog(), "-e ");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.SECRET_TOKEN = "must-not-leak";
	ensureEnvironment(runtime, context());
	await invoke();
	assertContains("N9: child env drops ambient secret", readLog(), "SECRET_TOKEN=unset");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_BUDGET = "1";
	process.env.YPI_FAKE_PI_MODE = "json";
	ensureEnvironment(runtime, context());
	const jsonText = await invoke();
	assertContains("N10: JSON child text parsed", jsonText, "JSON_CHILD_OK");
	const costFile = process.env.RLM_COST_FILE || "";
	assertContains("N10: JSON child cost recorded", existsSync(costFile) ? readFileSync(costFile, "utf8") : "", '"cost":0.123');

	// N10b: diagnostic capture may be bounded, but the incremental JSON decoder
	// must still see late answer and cost events after an oversized tool event.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_BUDGET = "1";
	process.env.YPI_FAKE_PI_MODE = "json-huge-tail";
	ensureEnvironment(runtime, context());
	const lateJsonText = await invoke();
	assertContains("N10b: late JSON answer survives oversized prior event", lateJsonText, "LATE_JSON_OK");
	const lateCostFile = process.env.RLM_COST_FILE || "";
	assertContains("N10b: late JSON cost survives oversized prior event", existsSync(lateCostFile) ? readFileSync(lateCostFile, "utf8") : "", '"cost":0.456');

	// N10c: if the oversized event itself could contain turn-end usage, a hard
	// budget must fail closed rather than record a misleading partial/zero cost.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_BUDGET = "20";
	process.env.YPI_FAKE_PI_MODE = "json-huge-turn-end";
	ensureEnvironment(runtime, context());
	await expectThrow("N10c: oversized cost-bearing event fails budget closed", "Cannot enforce RLM_BUDGET", () => invoke());
	const incompleteCostFile = process.env.RLM_COST_FILE || "";
	assertNotContains("N10c: incomplete cost is not recorded as authoritative", existsSync(incompleteCostFile) ? readFileSync(incompleteCostFile, "utf8") : "", '"cost":0');

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.RLM_SESSION_DIR = sessionDir;
	process.env.RLM_TRACE_ID = "parallel";
	ensureEnvironment(runtime, context());
	await Promise.all([invoke("first"), invoke("second")]);
	const log = readLog();
	assertContains("N11: first parallel call count appears", log, "RLM_CALL_COUNT=1");
	assertContains("N11: second parallel call count appears", log, "RLM_CALL_COUNT=2");
	assertContains("N11: first session file unique", log, "parallel_d1_c1.jsonl");
	assertContains("N11: second session file unique", log, "parallel_d1_c2.jsonl");

	// N13: a hostile RLM_TRACE_ID cannot escape the session directory via the child session filename.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.RLM_SESSION_DIR = sessionDir;
	process.env.RLM_TRACE_ID = "../../etc/evil";
	ensureEnvironment(runtime, context());
	await invoke("hostile");
	const traceLog = readLog();
	assertContains("N13: hostile trace id is sanitized in the session filename", traceLog, ".._.._etc_evil_d1_c1.jsonl");
	assertNotContains("N13: hostile trace id cannot traverse out of the session dir", traceLog, "etc/evil");

	// N13b: cancellation crosses the adapter boundary and terminates the detached
	// child process group instead of leaving paid or writable work orphaned.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.RLM_JJ = "0";
	process.env.RLM_UNSAFE_NO_JJ_WRITE = "1";
	process.env.YPI_FAKE_PI_MODE = "sleep";
	ensureEnvironment(runtime, context());
	const controller = new AbortController();
	const cancelStarted = Date.now();
	const cancelled = invoke("cancel child", controller.signal);
	setTimeout(() => controller.abort(), 100);
	await expectThrow("N13b: cancellation returns explicit error", "Child Pi cancelled", () => cancelled);
	record(Date.now() - cancelStarted < 5_000, "N13b: cancellation returns promptly");
	const childPid = Number(/CHILD_PID=(\d+)/.exec(readLog())?.[1] || 0);
	let childAlive = false;
	if (childPid > 0) {
		try { process.kill(childPid, 0); childAlive = true; } catch { /* expected */ }
	}
	record(!childAlive, "N13b: cancelled child process is gone", `pid=${childPid}`);

	// N14: convergence keeps the incumbent native implementation available as
	// an explicit one-release fallback; it is retained, not silently removed.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.RLM_JJ = "0";
	process.env.RLM_UNSAFE_NO_JJ_WRITE = "1";
	process.env.YPI_LEGACY_IMPL = "1";
	let legacyTool: Tool | undefined;
	const legacyPi = {
		...pi,
		registerTool(registered: Tool) {
			legacyTool = registered;
		},
	} as ExtensionAPI;
	ensureEnvironment(runtime, context(), legacyPi);
	registerNativeRlmQueryTool(legacyPi, runtime);
	if (!legacyTool) throw new Error("legacy native tool was not registered");
	const legacyResult = await legacyTool.execute("legacy-call", { prompt: "legacy fallback" }, undefined, undefined, context());
	const legacyText = legacyResult.content.find((item) => item.type === "text")?.text || "";
	assertContains("N14: legacy native fallback remains executable", legacyText, "FAKE_CHILD_OK");

	console.log("");
	console.log(`Results: ${pass} passed, ${fail} failed`);
	if (fail > 0) {
		process.exitCode = 1;
	}
}

try {
	await run();
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
