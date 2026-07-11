import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	allocateCallCount,
	appendCostSummary,
	appendIncompleteCostMarker,
	assertBudgetAvailable,
	assertTimeoutAvailable,
	assertWithinMaxCalls,
} from "./guardrails.ts";
import { currentDepth, maxDepth, nextDepth } from "./env.ts";
import {
	buildChildEnvironment,
	childExtensionsEnabled,
	READ_ONLY_EXCLUDED_BUILTINS,
	resolveChildRoute,
} from "./internal/child-config.ts";
import { formatCombinedChildOutput, normalizeChildOutput } from "./internal/child-output.ts";
import { runChildProcess } from "./internal/child-process.ts";
import { acquireChildResources } from "./internal/child-resources.ts";
import type { YpiRuntime } from "./runtime.ts";

export interface ParentRuntimeContext {
	cwd: string;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	sessionFile?: string;
	sessionDir?: string;
}

export interface RecursiveChildRequest {
	prompt: string;
	context?: string;
	contextPath?: string;
	fork?: boolean;
	caller: "tool" | "cli";
	parent: ParentRuntimeContext;
	// undefined uses the canonical extension; null intentionally selects the
	// standalone system-prompt path (CLI compatibility mode).
	extensionPath?: string | null;
	treeStartTimeSeconds?: number;
	onText?: (text: string) => boolean | void;
	onTextDrain?: () => Promise<void>;
	onAdmitted?: (callCount: number) => void;
	onChildSpawn?: (pid: number) => void;
	signal?: AbortSignal;
}

export interface RecursiveChildDetails {
	implementation: "canonical";
	depth: number;
	childDepth: number;
	maxDepth: number;
	callCount: number;
	caller: "tool" | "cli";
	exitCode: number;
	signal: NodeJS.Signals | null;
	jj: "jj" | "none" | "off";
	readOnly: boolean;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	textTruncated: boolean;
	jsonEventTruncated: boolean;
	jsonCostIncomplete: boolean;
	cancelled: boolean;
}

export interface RecursiveChildResult {
	text: string;
	stderr: string;
	warnings: string[];
	details: RecursiveChildDetails;
}

export class RecursiveChildError extends Error {
	readonly exitCode: number;
	readonly details?: RecursiveChildDetails;

	constructor(message: string, exitCode: number, details?: RecursiveChildDetails) {
		super(message);
		this.name = "RecursiveChildError";
		this.exitCode = exitCode;
		this.details = details;
	}
}

function nowTraceTime(): string {
	const d = new Date();
	return d.toTimeString().slice(0, 8) + `.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function trace(message: string): void {
	if (process.env.PI_TRACE_FILE) {
		writeFileSync(process.env.PI_TRACE_FILE, `${message}\n`, { flag: "a" });
	}
}

function timeoutOrThrow(): number | undefined {
	try {
		return assertTimeoutAvailable();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new RecursiveChildError(message, message.startsWith("Invalid ") ? 1 : 124);
	}
}

export async function runRecursiveChild(runtime: YpiRuntime, request: RecursiveChildRequest): Promise<RecursiveChildResult> {
	const depth = currentDepth();
	const childDepth = nextDepth();
	const limit = maxDepth();
	if (!Number.isInteger(depth) || depth < 0 || !Number.isInteger(limit) || limit < 0) {
		throw new RecursiveChildError(`Invalid recursion depth config: RLM_DEPTH=${process.env.RLM_DEPTH ?? ""} RLM_MAX_DEPTH=${process.env.RLM_MAX_DEPTH ?? ""} (must be non-negative integers)`, 1);
	}
	if (childDepth > limit) throw new RecursiveChildError(`Max depth exceeded at ${depth}/${limit}`, 1);
	if (depth === 0) process.env.RLM_START_TIME = String(request.treeStartTimeSeconds ?? Math.floor(Date.now() / 1000));

	const counterRemainingSeconds = timeoutOrThrow();
	const counterDeadlineMilliseconds = counterRemainingSeconds === undefined ? undefined : Date.now() + counterRemainingSeconds * 1000;
	assertWithinMaxCalls(0);
	const callCount = await allocateCallCount(counterDeadlineMilliseconds);
	assertWithinMaxCalls(callCount);
	assertBudgetAvailable();
	const setupRemainingSeconds = timeoutOrThrow();
	const extensionsEnabled = childExtensionsEnabled(childDepth);
	const fullResourceIsolation = !extensionsEnabled && process.env.RLM_CHILD_DISCOVERY === "0";
	const resources = acquireChildResources({
		prompt: request.prompt,
		context: request.context,
		contextPath: request.contextPath,
		fork: request.fork,
		cwd: request.parent.cwd,
		parentSessionFile: request.parent.sessionFile,
		parentSessionDir: request.parent.sessionDir,
		childDepth,
		callCount,
		systemPromptPath: runtime.systemPromptPath,
		rootPromptPath: process.env.RLM_ROOT_PROMPT_FILE,
		setupDeadlineMilliseconds: setupRemainingSeconds === undefined ? undefined : Date.now() + setupRemainingSeconds * 1000,
		fullResourceIsolation,
	});

	try {
		const { provider, model, thinkingLevel } = resolveChildRoute(request.parent, childDepth);
		const extensionPath = request.extensionPath === null ? "" : request.extensionPath || runtime.extensionPath;
		const env = buildChildEnvironment(process.env, {
			RLM_DEPTH: String(childDepth),
			RLM_MAX_DEPTH: String(limit),
			RLM_CALL_COUNT: String(callCount),
			RLM_PROVIDER: provider,
			RLM_MODEL: model,
			RLM_THINKING_LEVEL: thinkingLevel,
			RLM_SYSTEM_PROMPT: runtime.systemPromptPath,
			RLM_PROMPT_FILE: resources.promptFile,
			RLM_ROOT_PROMPT_FILE: process.env.RLM_ROOT_PROMPT_FILE || resources.promptFile,
			RLM_SESSION_DIR: process.env.RLM_SESSION_DIR || "",
			RLM_SESSION_FILE: resources.childSession || "",
			YPI_EXTENSION_ROOT: runtime.root,
			YPI_EXTENSION_PATH: extensionPath,
			YPI_RLM_QUERY_CALLER: request.caller,
		}, runtime, childDepth);
		if (resources.contextFile) env.CONTEXT = resources.contextFile;
		if (resources.isolatedPiRoot) {
			env.PI_CODING_AGENT_DIR = path.join(resources.isolatedPiRoot, "agent");
			// PI_PACKAGE_DIR identifies Pi's own shipped assets, not user package
			// state. Preserve it so the pinned executable retains its real version;
			// installed package config is isolated by PI_CODING_AGENT_DIR.
			env.PI_OFFLINE = "1";
		}

		const jsonMode = process.env.RLM_JSON !== "0";
		const args = jsonMode ? ["--mode", "json"] : ["-p"];
		if (provider) args.push("--provider", provider);
		if (model) args.push("--model", model);
		if (thinkingLevel) args.push("--thinking", thinkingLevel);
		if (resources.workspace.readOnly) args.push("--exclude-tools", READ_ONLY_EXCLUDED_BUILTINS.join(","));
		if (process.env.RLM_CHILD_DISCOVERY === "0") args.push("--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve");
		if (resources.childSession) args.push("--session", resources.childSession);
		else args.push("--no-session");
		// Pi cannot unregister an older ambient ypi copy. Load only the exact
		// canonical child extension by default; ambient extension discovery is an
		// explicit compatibility opt-in for callers that accept version conflicts.
		if (!extensionsEnabled || process.env.RLM_AMBIENT_EXTENSIONS !== "1") args.push("--no-extensions");
		if (extensionsEnabled && extensionPath && existsSync(extensionPath)) args.push("-e", extensionPath);
		else if (resources.standaloneSystemPromptFile) args.push("--system-prompt", resources.standaloneSystemPromptFile);

		const timeoutSeconds = timeoutOrThrow();
		request.onAdmitted?.(callCount);
		trace(`[${nowTraceTime()}] depth=${depth}→${childDepth} PID=${process.pid} call=${callCount} trace=${process.env.RLM_TRACE_ID || ""} caller=${request.caller} fork=${request.fork === true} jj=${resources.workspace.mode} prompt: ${request.prompt.slice(0, 120)}`);
		const started = Date.now();
		const processResult = await runChildProcess({
			args,
			env,
			cwd: resources.workspace.cwd,
			timeoutSeconds,
			signal: request.signal,
			jsonMode,
			stdinText: request.prompt,
			onText: request.onText,
			onTextDrain: request.onTextDrain,
			onSpawn: request.onChildSpawn,
		});
		const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
		const output = normalizeChildOutput(processResult);
		if (jsonMode && (!output.cost || processResult.cancelled || processResult.timedOut)) {
			processResult.jsonCostIncomplete = true;
		}
		if (output.cost) appendCostSummary(output.cost);
		if (processResult.jsonCostIncomplete) {
			appendIncompleteCostMarker("child ended without a complete final cost boundary");
		}
		trace(`[${new Date().toISOString()}] depth=${depth} child_depth=${childDepth} COMPLETED exit=${processResult.code} elapsed=${elapsed}s caller=${request.caller} call=${callCount} cost=${processResult.jsonCostIncomplete ? "incomplete" : output.cost?.cost ?? "untracked"} tokens=${processResult.jsonCostIncomplete ? "incomplete" : output.cost?.tokens ?? "untracked"} cancelled=${processResult.cancelled} timeout=${processResult.timedOut} truncated=${processResult.textTruncated || processResult.jsonEventTruncated}`);
		const details: RecursiveChildDetails = {
			implementation: "canonical",
			depth,
			childDepth,
			maxDepth: limit,
			callCount,
			caller: request.caller,
			exitCode: processResult.code,
			signal: processResult.signal,
			jj: resources.workspace.mode,
			readOnly: resources.workspace.readOnly,
			stdoutTruncated: processResult.stdoutTruncated,
			stderrTruncated: processResult.stderrTruncated,
			textTruncated: processResult.textTruncated,
			jsonEventTruncated: processResult.jsonEventTruncated,
			jsonCostIncomplete: processResult.jsonCostIncomplete,
			cancelled: processResult.cancelled,
		};
		if (processResult.code !== 0) {
			const reason = processResult.cancelled
				? "Child Pi cancelled"
				: processResult.timedOut
					? `Child Pi timed out after ${timeoutSeconds}s`
					: `Child Pi exited with ${processResult.code}`;
			const childOutput = formatCombinedChildOutput(output);
			throw new RecursiveChildError(`${reason}${childOutput ? `\n${childOutput}` : ""}`, processResult.code, details);
		}
		if (processResult.jsonCostIncomplete && process.env.RLM_BUDGET) {
			throw new RecursiveChildError("Cannot enforce RLM_BUDGET: an oversized cost-bearing or unclassified Pi JSON event was skipped", 1, details);
		}
		return { text: output.text, stderr: output.stderr, warnings: output.warnings, details };
	} finally {
		resources.cleanup();
	}
}

export function formatRecursiveResultForTool(result: RecursiveChildResult): string {
	return formatCombinedChildOutput({ text: result.text, stderr: result.stderr, warnings: result.warnings });
}
