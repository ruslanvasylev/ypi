import { existsSync, writeFileSync } from "node:fs";
import {
	allocateCallCount,
	appendCostSummary,
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
import { runChildProcess, normalizeChildOutput } from "./internal/child-process.ts";
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
	signal?: AbortSignal;
}

export interface RecursiveChildDetails {
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
}

export interface RecursiveChildResult {
	text: string;
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

export async function runRecursiveChild(runtime: YpiRuntime, request: RecursiveChildRequest): Promise<RecursiveChildResult> {
	const depth = currentDepth();
	const childDepth = nextDepth();
	const limit = maxDepth();
	if (!Number.isInteger(depth) || depth < 0 || !Number.isInteger(limit) || limit < 0) {
		throw new RecursiveChildError(`Invalid recursion depth config: RLM_DEPTH=${process.env.RLM_DEPTH ?? ""} RLM_MAX_DEPTH=${process.env.RLM_MAX_DEPTH ?? ""} (must be non-negative integers)`, 1);
	}
	if (childDepth > limit) throw new RecursiveChildError(`Max depth exceeded at ${depth}/${limit}`, 1);
	if (depth === 0) process.env.RLM_START_TIME = String(Math.floor(Date.now() / 1000));

	const callCount = await allocateCallCount();
	assertWithinMaxCalls(callCount);
	assertBudgetAvailable();
	const timeoutSeconds = assertTimeoutAvailable();
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
	});

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
		RLM_SESSION_DIR: process.env.RLM_SESSION_DIR || "",
		RLM_SESSION_FILE: resources.childSession || "",
		YPI_EXTENSION_ROOT: runtime.root,
		YPI_EXTENSION_PATH: extensionPath,
		YPI_RLM_QUERY_CALLER: request.caller,
	}, runtime, childDepth);
	if (resources.contextFile) env.CONTEXT = resources.contextFile;

	const jsonMode = process.env.RLM_JSON !== "0";
	const args = jsonMode ? ["--mode", "json"] : ["-p"];
	if (provider) args.push("--provider", provider);
	if (model) args.push("--model", model);
	if (thinkingLevel) args.push("--thinking", thinkingLevel);
	if (resources.workspace.readOnly) args.push("--exclude-tools", READ_ONLY_EXCLUDED_BUILTINS.join(","));
	if (process.env.RLM_CHILD_DISCOVERY === "0") args.push("--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve");
	if (resources.childSession) args.push("--session", resources.childSession);
	else args.push("--no-session");
	if (!childExtensionsEnabled(childDepth)) args.push("--no-extensions");
	if (childExtensionsEnabled(childDepth) && extensionPath && existsSync(extensionPath)) args.push("-e", extensionPath);
	else if (existsSync(runtime.systemPromptPath)) args.push("--system-prompt", runtime.systemPromptPath);
	args.push(request.prompt);

	trace(`[${nowTraceTime()}] depth=${depth}→${childDepth} PID=${process.pid} call=${callCount} trace=${process.env.RLM_TRACE_ID || ""} caller=${request.caller} fork=${request.fork === true} jj=${resources.workspace.mode} prompt: ${request.prompt.slice(0, 120)}`);

	try {
		const started = Date.now();
		const processResult = await runChildProcess(args, env, resources.workspace.cwd, timeoutSeconds, request.signal);
		const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
		trace(`[${new Date().toISOString()}] depth=${depth} COMPLETED exit=${processResult.code} elapsed=${elapsed}s caller=${request.caller}`);
		const output = normalizeChildOutput(processResult, jsonMode);
		if (output.cost) appendCostSummary(output.cost);
		const details: RecursiveChildDetails = {
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
		};
		if (processResult.code !== 0) {
			const reason = processResult.timedOut ? `Child Pi timed out after ${timeoutSeconds}s` : `Child Pi exited with ${processResult.code}`;
			throw new RecursiveChildError(`${reason}${output.text ? `\n${output.text}` : ""}`, processResult.code, details);
		}
		return { text: output.text, details };
	} finally {
		resources.cleanup();
	}
}
