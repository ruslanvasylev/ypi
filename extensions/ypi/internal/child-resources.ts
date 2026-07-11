import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { safeTraceId, sharedSessionsEnabled } from "../env.ts";
import { renderActiveTaskFilesSection } from "./task-files.ts";
import { acquireWorkspace, type ChildMode, type WorkspaceLease } from "./workspace-policy.ts";

export interface ChildResourceInput {
	prompt: string;
	context?: string;
	contextPath?: string;
	fork?: boolean;
	cwd: string;
	parentSessionFile?: string;
	parentSessionDir?: string;
	childDepth: number;
	callCount: number;
	systemPromptPath?: string;
	rootPromptPath?: string;
	setupDeadlineMilliseconds?: number;
	fullResourceIsolation?: boolean;
	mode: ChildMode;
}

export interface ChildResourceLease {
	promptFile: string;
	contextFile?: string;
	childSession?: string;
	standaloneSystemPromptFile?: string;
	isolatedPiRoot?: string;
	workspace: WorkspaceLease;
	cleanup(): void;
}

function createContextFile(input: ChildResourceInput): string | undefined {
	if (input.context !== undefined) {
		const contextPath = path.join(mkdtempSync(path.join(tmpdir(), "ypi_ctx_")), "context.txt");
		writeFileSync(contextPath, input.context);
		return contextPath;
	}

	const inheritedPath = input.contextPath || process.env.CONTEXT;
	if (inheritedPath && existsSync(inheritedPath)) {
		const contextPath = path.join(mkdtempSync(path.join(tmpdir(), "ypi_ctx_")), "context.txt");
		copyFileSync(inheritedPath, contextPath);
		return contextPath;
	}
	return undefined;
}

function createPromptFile(prompt: string): string {
	const promptPath = path.join(mkdtempSync(path.join(tmpdir(), "ypi_prompt_")), "prompt.txt");
	writeFileSync(promptPath, prompt);
	return promptPath;
}

function createStandaloneSystemPrompt(input: ChildResourceInput, promptFile: string, contextFile?: string): string | undefined {
	if (!input.systemPromptPath || !existsSync(input.systemPromptPath)) return undefined;
	const outputPath = path.join(mkdtempSync(path.join(tmpdir(), "ypi_system_")), "system-prompt.md");
	const section = renderActiveTaskFilesSection({
		contextPath: contextFile,
		promptPath: promptFile,
		rootPromptPath: input.rootPromptPath || promptFile,
	});
	writeFileSync(outputPath, `${readFileSync(input.systemPromptPath, "utf8")}${section}`);
	return outputPath;
}

function childSessionFile(input: ChildResourceInput): string | undefined {
	if (!sharedSessionsEnabled()) return undefined;
	const sessionDir = process.env.RLM_SESSION_DIR || (input.parentSessionFile ? input.parentSessionDir : "");
	if (!sessionDir) return undefined;
	mkdirSync(sessionDir, { recursive: true });
	return path.join(sessionDir, `${safeTraceId(process.env.RLM_TRACE_ID || "ypi")}_d${input.childDepth}_c${input.callCount}.jsonl`);
}

function copyForkSession(input: ChildResourceInput, childSession: string | undefined): void {
	const parentSession = input.parentSessionFile || process.env.RLM_SESSION_FILE;
	if (input.fork && childSession && parentSession && existsSync(parentSession)) {
		copyFileSync(parentSession, childSession);
	}
}

function removeArtifact(filePath: string | undefined): void {
	if (filePath) rmSync(path.dirname(filePath), { recursive: true, force: true });
}

export function acquireChildResources(input: ChildResourceInput): ChildResourceLease {
	let promptFile: string | undefined;
	let contextFile: string | undefined;
	let standaloneSystemPromptFile: string | undefined;
	let isolatedPiRoot: string | undefined;
	let workspace: WorkspaceLease | undefined;
	try {
		promptFile = createPromptFile(input.prompt);
		contextFile = createContextFile(input);
		standaloneSystemPromptFile = createStandaloneSystemPrompt(input, promptFile, contextFile);
		if (input.fullResourceIsolation) {
			isolatedPiRoot = mkdtempSync(path.join(tmpdir(), "ypi_isolated_pi_"));
			mkdirSync(path.join(isolatedPiRoot, "agent"), { recursive: true, mode: 0o700 });
		}
		const childSession = childSessionFile(input);
		copyForkSession(input, childSession);
		if (input.setupDeadlineMilliseconds !== undefined && Date.now() >= input.setupDeadlineMilliseconds) {
			const error = new Error("RLM_TIMEOUT expired during recursive resource setup") as Error & { exitCode: number };
			error.exitCode = 124;
			throw error;
		}
		workspace = acquireWorkspace({
			cwd: input.cwd,
			childDepth: input.childDepth,
			mode: input.mode,
			setupDeadlineMilliseconds: input.setupDeadlineMilliseconds,
		});
		return {
			promptFile,
			contextFile,
			childSession,
			standaloneSystemPromptFile,
			isolatedPiRoot,
			workspace,
			cleanup() {
				workspace?.cleanup();
				removeArtifact(promptFile);
				removeArtifact(contextFile);
				removeArtifact(standaloneSystemPromptFile);
				if (isolatedPiRoot) rmSync(isolatedPiRoot, { recursive: true, force: true });
			},
		};
	} catch (error) {
		workspace?.cleanup();
		removeArtifact(promptFile);
		removeArtifact(contextFile);
		removeArtifact(standaloneSystemPromptFile);
		if (isolatedPiRoot) rmSync(isolatedPiRoot, { recursive: true, force: true });
		throw error;
	}
}
