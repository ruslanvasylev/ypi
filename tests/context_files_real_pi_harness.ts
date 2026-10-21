// Real pinned Pi proof that the assembled system prompt carries an exact
// duplicate context file once, for a ypi root and a ypi review child.
//
// A probe extension records the provider payload in before_provider_request and
// aborts the run, so the loopback endpoint is never contacted and no model call
// occurs. A control run without ypi proves the fixture really duplicates.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createContextFileFixture,
	deduplicatedOrder,
	fixtureContextFiles,
	parseRenderedContextFiles,
	piLoadedOrder,
} from "./helpers/context_files_fixture.ts";
import type { ContextFileFixture, RenderedContextFile } from "./helpers/context_files_fixture.ts";

interface PayloadMessage {
	role: string;
	content: string | Array<{ type?: string; text?: string }>;
}

interface Scenario {
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	expected: (fixture: ContextFileFixture) => RenderedContextFile[];
	/** Debug marker the run must print to stderr. */
	stderrMarker?: (fixture: ContextFileFixture) => string;
}

const projectRoot = path.resolve(import.meta.dir, "..");
const piPackageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
// The launchers resolve node_modules/.bin/pi, which is Pi's bundled CLI.
const piCli = path.join(piPackageRoot, "dist", "bundle", "cli.js");
const PROVIDER = "ypi-probe";
const MODEL = "probe";

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

function systemText(payloadLine: string): string {
	const payload = JSON.parse(payloadLine) as { messages?: PayloadMessage[] };
	return (payload.messages || [])
		.filter(({ role }) => role === "system" || role === "developer")
		.map(({ content }) => typeof content === "string" ? content : content.map((part) => part.text || "").join(""))
		.join("\n");
}

function writeProbeAgent(agentDir: string): void {
	// Loopback discard port, synthetic key: the probe aborts before any request.
	writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [PROVIDER]: {
		baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "synthetic-not-a-secret",
		models: [{ id: MODEL, name: MODEL, contextWindow: 200000, maxTokens: 1024 }],
	} } }));
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
}

function writeProbe(probePath: string, reportPath: string): void {
	writeFileSync(probePath, `import { appendFileSync } from "node:fs";
export default function (pi: any) {
	pi.on("before_provider_request", (event: any, ctx: any) => {
		appendFileSync(${JSON.stringify(reportPath)}, JSON.stringify(event.payload) + "\\n");
		ctx.abort();
	});
}
`);
}

const nodeBin = process.env.YPI_NODE_BIN || "node";
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "ypi-context-files-real-pi-")));
chmodSync(scratch, 0o700);
try {
	const fixture = createContextFileFixture(path.join(scratch, "fixture"));
	writeProbeAgent(fixture.agentDir);
	const home = path.join(scratch, "home");
	mkdirSync(home, { mode: 0o700 });

	const scenarios: Scenario[] = [
		{
			name: "control (Pi without ypi)",
			command: nodeBin,
			args: [piCli, "--no-extensions", "--provider", PROVIDER, "--model", MODEL, "--no-session", "-p", "probe"],
			env: {},
			expected: piLoadedOrder,
		},
		{
			name: "ypi root",
			command: path.join(projectRoot, "ypi"),
			args: ["--provider", PROVIDER, "--model", MODEL, "--no-session", "-p", "probe"],
			env: { RLM_SHARED_SESSIONS: "0", YPI_EXTENSION_DEBUG: "1" },
			expected: deduplicatedOrder,
			stderrMarker: ({ contents }) => `__YPI_CONTEXT_FILES_DEDUPLICATED__ removed=2 bytes=${2 * Buffer.byteLength(contents.shared)}`,
		},
		{
			name: "ypi review child",
			command: path.join(projectRoot, "rlm_query"),
			args: ["probe"],
			env: { RLM_DEPTH: "0", RLM_SHARED_SESSIONS: "0", RLM_TIMEOUT: "60", RLM_PROVIDER: PROVIDER, RLM_MODEL: MODEL },
			expected: deduplicatedOrder,
		},
	];

	console.log("\n--- Context-file deduplication (real pinned Pi, no model call) ---");
	scenarios.forEach((scenario, index) => {
		const scenarioDir = path.join(scratch, `scenario-${index}`);
		mkdirSync(scenarioDir, { mode: 0o700 });
		const reportPath = path.join(scenarioDir, "payload.jsonl");
		const probePath = path.join(scenarioDir, "probe.ts");
		const wrapperPath = path.join(scenarioDir, "pi");
		writeProbe(probePath, reportPath);
		writeFileSync(wrapperPath, `#!/bin/bash\nexec ${JSON.stringify(nodeBin)} ${JSON.stringify(piCli)} "$@" -e ${JSON.stringify(probePath)}\n`, { mode: 0o700 });
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value === undefined) continue;
			if (/^(RLM_|YPI_|PI_|GIT_)/.test(key) || key === "CONTEXT" || key === "HONCHO_ENABLED") continue;
			env[key] = value;
		}
		Object.assign(env, {
			HOME: home, TMPDIR: scratch, PI_CODING_AGENT_DIR: fixture.agentDir, PI_OFFLINE: "1",
			HONCHO_ENABLED: "false", YPI_PI_BIN: wrapperPath, ...scenario.env,
		});
		// The control loads only the probe; the launchers append it through the wrapper.
		const args = scenario.command === nodeBin ? [...scenario.args, "-e", probePath] : scenario.args;
		const result = spawnSync(scenario.command, args, { cwd: fixture.cwd, env, encoding: "utf8", input: "", timeout: 90_000 });
		if (!existsSync(reportPath)) {
			record(false, `${scenario.name}: provider payload captured`, `status=${result.status} stderr=${(result.stderr || "").slice(-800)}`);
			return;
		}
		const prompt = systemText(readFileSync(reportPath, "utf8").split("\n")[0]);
		const rendered = fixtureContextFiles(fixture, parseRenderedContextFiles(prompt));
		const expected = scenario.expected(fixture);
		record(
			JSON.stringify(rendered) === JSON.stringify(expected),
			`${scenario.name}: provider prompt carries ${expected.length} fixture context files in Pi order`,
			`actual=${JSON.stringify(rendered.map(({ path: filePath }) => path.relative(scratch, filePath)))}`,
		);
		const sharedCount = rendered.filter(({ content }) => content === fixture.contents.shared).length;
		const expectedShared = expected.filter(({ content }) => content === fixture.contents.shared).length;
		record(sharedCount === expectedShared, `${scenario.name}: shared rules appear ${expectedShared} time(s)`, `actual=${sharedCount}`);
		if (scenario.stderrMarker) {
			const marker = scenario.stderrMarker(fixture);
			record((result.stderr || "").includes(marker), `${scenario.name}: debug reports ${marker}`, (result.stderr || "").slice(-400));
		}
	});
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nCONTEXT_FILES_REAL_PI ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
