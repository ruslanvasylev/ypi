import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { safeTraceId, sharedSessionsEnabled } from "../env.ts";

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

function createWorkspace(cwd: string, depth: number): WorkspaceLease {
	if (process.env.RLM_JJ === "0") {
		return { cwd, mode: "off", readOnly: process.env.RLM_UNSAFE_NO_JJ_WRITE !== "1", cleanup() {} };
	}

	const root = spawnSync("jj", ["root"], { cwd, stdio: "ignore" });
	if (root.status !== 0) {
		return { cwd, mode: "none", readOnly: process.env.RLM_UNSAFE_NO_JJ_WRITE !== "1", cleanup() {} };
	}

	const workspacePath = mkdtempSync(path.join(tmpdir(), `ypi_ws_d${depth}_`));
	const workspaceSuffix = path.basename(workspacePath).replace(/^ypi_ws_/, "");
	const name = `ypi-d${depth}-${process.pid}-${workspaceSuffix}`;
	const add = spawnSync("jj", ["workspace", "add", "--name", name, workspacePath], { cwd, stdio: "ignore" });
	if (add.status !== 0) {
		rmSync(workspacePath, { recursive: true, force: true });
		return { cwd, mode: "none", readOnly: process.env.RLM_UNSAFE_NO_JJ_WRITE !== "1", cleanup() {} };
	}

	return {
		cwd: workspacePath,
		mode: "jj",
		readOnly: false,
		cleanup() {
			spawnSync("jj", ["workspace", "forget", name], { cwd: workspacePath, stdio: "ignore" });
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
	let workspace: WorkspaceLease | undefined;
	try {
		promptFile = createPromptFile(input.prompt);
		contextFile = createContextFile(input);
		const childSession = childSessionFile(input);
		copyForkSession(input, childSession);
		workspace = createWorkspace(input.cwd, input.childDepth);
		return {
			promptFile,
			contextFile,
			childSession,
			workspace,
			cleanup() {
				workspace?.cleanup();
				removeArtifact(promptFile);
				removeArtifact(contextFile);
			},
		};
	} catch (error) {
		workspace?.cleanup();
		removeArtifact(promptFile);
		removeArtifact(contextFile);
		throw error;
	}
}
