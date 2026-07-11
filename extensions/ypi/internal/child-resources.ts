import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { safeTraceId, sharedSessionsEnabled } from "../env.ts";
import { renderActiveTaskFilesSection } from "./task-files.ts";

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
}

export interface WorkspaceLease {
	cwd: string;
	mode: "jj" | "none" | "off";
	readOnly: boolean;
	cleanup(): void;
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

function unavailableWorkspace(cwd: string, reason: string): WorkspaceLease {
	if (process.env.RLM_UNSAFE_NO_JJ_WRITE === "1") {
		return { cwd, mode: "none", readOnly: false, cleanup() {} };
	}
	throw new Error(`jj workspace isolation unavailable (${reason}). Choose explicitly: set RLM_JJ=0 for read-only children, initialize colocated jj with 'jj git init --colocate', or set RLM_UNSAFE_NO_JJ_WRITE=1 to permit writes in the current checkout.`);
}

function remainingSetupMilliseconds(input: ChildResourceInput, cleanup = false): number | undefined {
	if (input.setupDeadlineMilliseconds === undefined) return cleanup ? 1_000 : undefined;
	const remaining = input.setupDeadlineMilliseconds - Date.now();
	if (remaining <= 0 && !cleanup) {
		const error = new Error("RLM_TIMEOUT expired during recursive workspace setup") as Error & { exitCode: number };
		error.exitCode = 124;
		throw error;
	}
	return Math.max(1, cleanup ? Math.min(1_000, remaining) : remaining);
}

function assertSpawnWithinDeadline(result: ReturnType<typeof spawnSync>, operation: string): void {
	if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
		const error = new Error(`RLM_TIMEOUT expired during ${operation}`) as Error & { exitCode: number };
		error.exitCode = 124;
		throw error;
	}
}

function createWorkspace(input: ChildResourceInput): WorkspaceLease {
	const { cwd, childDepth: depth } = input;
	if (process.env.RLM_JJ === "0") {
		return { cwd, mode: "off", readOnly: process.env.RLM_UNSAFE_NO_JJ_WRITE !== "1", cleanup() {} };
	}

	const root = spawnSync("jj", ["root"], { cwd, stdio: "ignore", timeout: remainingSetupMilliseconds(input) });
	assertSpawnWithinDeadline(root, "jj root");
	if (root.status !== 0) {
		return unavailableWorkspace(cwd, (root.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? "jj is not installed or not on PATH" : "the current checkout is not a jj workspace");
	}

	const workspacePath = mkdtempSync(path.join(tmpdir(), `ypi_ws_d${depth}_`));
	const workspaceSuffix = path.basename(workspacePath).replace(/^ypi_ws_/, "");
	const name = `ypi-d${depth}-${process.pid}-${workspaceSuffix}`;
	const add = spawnSync("jj", ["workspace", "add", "--name", name, workspacePath], { cwd, stdio: "ignore", timeout: remainingSetupMilliseconds(input) });
	try {
		assertSpawnWithinDeadline(add, "jj workspace add");
	} catch (error) {
		rmSync(workspacePath, { recursive: true, force: true });
		throw error;
	}
	if (add.status !== 0) {
		rmSync(workspacePath, { recursive: true, force: true });
		return unavailableWorkspace(cwd, "jj workspace add failed");
	}

	return {
		cwd: workspacePath,
		mode: "jj",
		readOnly: false,
		cleanup() {
			spawnSync("jj", ["workspace", "forget", name], { cwd: workspacePath, stdio: "ignore", timeout: remainingSetupMilliseconds(input, true) });
			rmSync(workspacePath, { recursive: true, force: true });
		},
	};
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
		if (input.setupDeadlineMilliseconds !== undefined && Date.now() >= input.setupDeadlineMilliseconds) remainingSetupMilliseconds(input);
		workspace = createWorkspace(input);
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
