import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { safeTraceId } from "../env.ts";

export interface AsyncJobInput {
	prompt: string;
	fork: boolean;
	notifyPid?: number;
	cwd: string;
	context?: string;
	contextPath?: string;
	extensionPath: string | null;
}

export interface AsyncJob {
	prompt: string;
	fork: boolean;
	notifyPid?: number;
	cwd: string;
	contextPath?: string;
	ownedContextPath?: string;
	outputPath: string;
	sentinelPath: string;
	jobPath: string;
	extensionPath: string | null;
}

function createOwnedContext(context: string): string {
	const contextDir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "ypi_async_context_"));
	const contextPath = path.join(contextDir, "context.txt");
	writeFileSync(contextPath, context, { mode: 0o600 });
	return contextPath;
}

export function createAsyncJob(input: AsyncJobInput): AsyncJob {
	const traceId = safeTraceId(process.env.RLM_TRACE_ID || randomBytes(4).toString("hex"));
	process.env.RLM_TRACE_ID = traceId;
	const id = `rlm_async_${traceId}_${randomBytes(4).toString("hex")}`;
	const root = process.env.TMPDIR || tmpdir();
	const ownedContextPath = input.context !== undefined ? createOwnedContext(input.context) : undefined;
	const jobPath = path.join(root, `${id}.job.json`);
	return {
		prompt: input.prompt,
		fork: input.fork,
		notifyPid: input.notifyPid,
		cwd: input.cwd,
		contextPath: ownedContextPath || input.contextPath,
		ownedContextPath,
		outputPath: path.join(root, `${id}.txt`),
		sentinelPath: path.join(root, `${id}.done`),
		jobPath,
		extensionPath: input.extensionPath,
	};
}

export function launchAsyncWorker(job: AsyncJob, cliPath: string): number {
	writeFileSync(job.jobPath, `${JSON.stringify(job)}\n`, { mode: 0o600 });
	const child = spawn(process.execPath, [cliPath, "--ypi-async-worker", job.jobPath], {
		cwd: job.cwd,
		env: process.env,
		stdio: "ignore",
		detached: process.platform !== "win32",
	});
	child.unref();
	return child.pid || 0;
}

export function readAsyncJob(jobPath: string): AsyncJob {
	return JSON.parse(readFileSync(jobPath, "utf8")) as AsyncJob;
}

function findPeerInbox(pid: number): string | undefined {
	try {
		for (const name of readdirSync("/tmp")) {
			if (!name.startsWith("pi_peer_")) continue;
			const directory = path.join("/tmp", name);
			try {
				const metadata = JSON.parse(readFileSync(path.join(directory, "meta.json"), "utf8"));
				if (Number(metadata.pid) === pid) return path.join(directory, "inbox.jsonl");
			} catch {
				// Ignore unrelated or concurrently removed peer directories.
			}
		}
	} catch {
		// /tmp peer discovery is optional.
	}
	return undefined;
}

function notifyPeer(job: AsyncJob): void {
	if (job.notifyPid === undefined) return;
	const inbox = findPeerInbox(job.notifyPid);
	if (!inbox) return;
	let result = "";
	try { result = readFileSync(job.outputPath, "utf8").slice(-50_000); } catch { /* no output */ }
	const message = {
		from_pid: process.pid,
		from_project: "rlm_query",
		message: `[rlm_query --async result]\n\n${result}`,
		timestamp: new Date().toISOString(),
		id: `async_${path.basename(job.outputPath, ".txt")}`,
	};
	writeFileSync(inbox, `${JSON.stringify(message)}\n`, { flag: "a" });
}

export function finishAsyncJob(job: AsyncJob, code: number, output: string): void {
	try {
		writeFileSync(job.outputPath, output);
		writeFileSync(job.sentinelPath, `${code}\n`);
		try { notifyPeer(job); } catch { /* notification is best-effort */ }
	} finally {
		rmSync(job.jobPath, { force: true });
		if (job.ownedContextPath) rmSync(path.dirname(job.ownedContextPath), { recursive: true, force: true });
	}
}
