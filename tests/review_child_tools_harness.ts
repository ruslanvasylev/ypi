// Real pinned Pi proof of the review-child tool surface.
//
// The canonical `rlm_query` launcher assembles the exact child argv and
// environment. A wrapper forwards both to the pinned Pi in RPC mode with stdin
// closed, so no model call occurs, and adds one probe extension that records
// the active tool set and runs the read-only search tools in the child's
// environment.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ToolExecution {
	ok: boolean;
	text: string;
}

interface ProbeReport {
	active: string[];
	executions: Record<string, ToolExecution>;
}

interface Scenario {
	name: string;
	env: Record<string, string>;
	expectedActive: string[];
}

const projectRoot = path.resolve(import.meta.dir, "..");
const piPackageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const piCli = path.join(piPackageRoot, "dist", "cli.js");
const pinnedPiVersion = readFileSync(path.join(projectRoot, ".pi-version"), "utf8").trim();
const FD_MARKER = "parent-pi-managed-fd-marker";
const GREP_NEEDLE = "ypi-review-child-needle";
const SEARCH_TOOLS = ["read", "grep", "find", "ls"];
const MUTATING_TOOLS = ["bash", "edit", "write"];

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

function commandPath(command: string): string | undefined {
	const result = spawnSync("bash", ["-c", `command -v ${command}`], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content, { mode: 0o700 });
	chmodSync(filePath, 0o700);
}

function sameMembers(actual: string[], expected: string[]): boolean {
	return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

const nodeBin = process.env.YPI_NODE_BIN || commandPath("node");
if (!nodeBin) throw new Error("review child tool harness requires Node.js for the pinned Pi CLI");
const piVersion = spawnSync(nodeBin, [piCli, "--version"], { encoding: "utf8" }).stdout.trim();
record(piVersion === pinnedPiVersion, `real Pi matches pin (${piVersion})`, `expected ${pinnedPiVersion}`);

const scratch = mkdtempSync(path.join(tmpdir(), "ypi-review-child-tools-"));
chmodSync(scratch, 0o700);
try {
	const home = path.join(scratch, "home");
	const workspace = path.join(scratch, "workspace");
	const parentAgent = path.join(scratch, "parent-agent");
	const parentBin = path.join(parentAgent, "bin");
	const ambientExtensions = path.join(parentAgent, "extensions");
	for (const directory of [home, workspace, parentAgent, parentBin, ambientExtensions]) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
	}
	writeFileSync(path.join(workspace, "needle.txt"), `${GREP_NEEDLE}\n`);
	writeFileSync(path.join(workspace, FD_MARKER), "");

	// Pi resolves fd from <agent>/bin before PATH. The fixture stands in for a
	// Pi-managed download that exists only in the parent's agent directory.
	writeExecutable(path.join(parentBin, "fd"), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fd 0.0.0-ypi-fixture"; exit 0; fi
for arg do last="$arg"; done
printf '%s\\n' "$last/${FD_MARKER}"
`);

	// Ambient discovery source. Default and isolated children must not load it;
	// ambient review children keep its plain tool and drop its MCP-named tool.
	writeFileSync(path.join(ambientExtensions, "ambient-fixture.ts"), `export default function (pi: any) {
	for (const name of ["ambient_fixture", "mcp__fixture__mutate"]) {
		pi.registerTool({
			name,
			label: name,
			description: "ypi review-child tool-surface fixture",
			parameters: { type: "object", properties: {} },
			async execute() {
				return { content: [{ type: "text", text: name }], details: undefined };
			},
		});
	}
}
`);

	const runScenario = (scenario: Scenario): ProbeReport | undefined => {
		const scenarioDir = path.join(scratch, scenario.name);
		mkdirSync(scenarioDir, { mode: 0o700 });
		const reportPath = path.join(scenarioDir, "report.json");
		const argvPath = path.join(scenarioDir, "argv.txt");
		const probePath = path.join(scenarioDir, "probe.ts");
		const wrapperPath = path.join(scenarioDir, "pi");
		writeFileSync(probePath, `import { writeFileSync } from "node:fs";
export default function (pi: any) {
	pi.on("session_start", async () => {
		const report: any = { active: pi.getActiveTools(), executions: {} };
		const tools = await import(${JSON.stringify(path.join(piPackageRoot, "dist", "index.js"))});
		const calls: Array<[string, any, any]> = [
			["find", tools.createFindTool, { pattern: ${JSON.stringify(FD_MARKER)} }],
			["grep", tools.createGrepTool, { pattern: ${JSON.stringify(GREP_NEEDLE)} }],
			["ls", tools.createLsTool, {}],
		];
		for (const [name, create, params] of calls) {
			try {
				const result = await create(process.cwd()).execute("probe-" + name, params, undefined, undefined);
				report.executions[name] = { ok: true, text: result.content.map((item: any) => item.text || "").join("\\n") };
			} catch (error: any) {
				report.executions[name] = { ok: false, text: String(error?.message || error) };
			}
		}
		writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(report));
	});
}
`);
		writeExecutable(wrapperPath, `#!/bin/bash
args=()
while [ $# -gt 0 ]; do
	case "$1" in
		--mode) args+=(--mode rpc); shift 2 ;;
		-p) args+=(--mode rpc); shift ;;
		*) args+=("$1"); shift ;;
	esac
done
printf '%s\\n' "\${args[@]}" > ${JSON.stringify(argvPath)}
exec ${JSON.stringify(nodeBin)} ${JSON.stringify(piCli)} "\${args[@]}" -e ${JSON.stringify(probePath)} < /dev/null
`);
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value === undefined) continue;
			if (/^(RLM_|YPI_|PI_|GIT_)/.test(key) || key === "CONTEXT" || key === "HONCHO_ENABLED") continue;
			env[key] = value;
		}
		Object.assign(env, {
			HOME: home,
			TMPDIR: scratch,
			PI_CODING_AGENT_DIR: parentAgent,
			YPI_PI_BIN: wrapperPath,
			RLM_DEPTH: "0",
			RLM_MAX_DEPTH: "3",
			RLM_TIMEOUT: "60",
			RLM_SHARED_SESSIONS: "0",
			...scenario.env,
		});
		const result = spawnSync(path.join(projectRoot, "rlm_query"), ["Report the available tools."], {
			cwd: workspace,
			env,
			encoding: "utf8",
			input: "",
			timeout: 90_000,
		});
		if (!existsSync(reportPath)) {
			record(false, `${scenario.name}: real Pi child reported its tools`, `status=${result.status} stderr=${(result.stderr || "").slice(-800)}`);
			return undefined;
		}
		const report = JSON.parse(readFileSync(reportPath, "utf8")) as ProbeReport;
		const argv = existsSync(argvPath) ? readFileSync(argvPath, "utf8").trim().split("\n").join(" ") : "";
		record(
			sameMembers(report.active, scenario.expectedActive),
			`${scenario.name}: active tools are exactly ${[...scenario.expectedActive].sort().join(", ")}`,
			`active=${JSON.stringify(report.active)} argv=${argv}`,
		);
		record(
			!report.active.some((name) => MUTATING_TOOLS.includes(name) || name.startsWith("mcp__")),
			`${scenario.name}: no mutating, process-spawning, or MCP tool is active`,
			JSON.stringify(report.active),
		);
		return report;
	};

	console.log("\n--- Review child tool surface (real pinned Pi, no model call) ---");
	const fdOnPath = Boolean(commandPath("fd") || commandPath("fdfind"));
	const rgOnPath = Boolean(commandPath("rg"));
	const scenarios: Scenario[] = [
		{ name: "default", env: {}, expectedActive: [...SEARCH_TOOLS, "rlm_query"] },
		{
			name: "full-isolation",
			env: { RLM_CHILD_EXTENSIONS: "0", RLM_CHILD_DISCOVERY: "0" },
			expectedActive: [...SEARCH_TOOLS],
		},
		{
			name: "ambient",
			env: { RLM_AMBIENT_EXTENSIONS: "1" },
			expectedActive: [...SEARCH_TOOLS, "rlm_query", "ambient_fixture"],
		},
	];
	for (const scenario of scenarios) {
		const report = runScenario(scenario);
		if (!report) continue;
		const find = report.executions.find;
		record(
			find?.ok === true && find.text.includes(FD_MARKER),
			`${scenario.name}: find resolves fd and returns results${fdOnPath ? "" : " through the parent's Pi-managed binary"}`,
			JSON.stringify(find),
		);
		const ls = report.executions.ls;
		record(ls?.ok === true && ls.text.includes("needle.txt"), `${scenario.name}: ls lists the workspace`, JSON.stringify(ls));
		const grep = report.executions.grep;
		if (rgOnPath) {
			record(grep?.ok === true && grep.text.includes("needle.txt"), `${scenario.name}: grep resolves rg and returns matches`, JSON.stringify(grep));
		} else {
			console.log(`  - ${scenario.name}: grep execution not asserted (no rg on PATH; offline isolation cannot download it)`);
		}
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nREVIEW_CHILD_TOOLS ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
