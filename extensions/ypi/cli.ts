import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureEnvironment, safeTraceId } from "./env.ts";
import { RecursiveChildError, runRecursiveChild } from "./runtime-core.ts";
import { resolveRuntime, type YpiRuntime } from "./runtime.ts";

interface CliFlags {
	fork: boolean;
	async: boolean;
	notifyPid?: number;
	prompt: string;
}

interface ContextSource {
	context?: string;
	contextPath?: string;
}

interface AsyncJob {
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

const runtimeFromModule = resolveRuntime(new URL("../recursive.ts", import.meta.url).href);

function activeRuntime(): YpiRuntime {
	return {
		...runtimeFromModule,
		systemPromptPath: process.env.RLM_SYSTEM_PROMPT || runtimeFromModule.systemPromptPath,
	};
}

function usage(): never {
	console.error('Usage: rlm_query [--fork] [--async] [--notify PID] "your prompt here"');
	process.exit(1);
}

function parseFlags(args: string[]): CliFlags {
	let fork = false;
	let async = false;
	let notifyPid: number | undefined;
	let index = 0;
	flagLoop: while (args[index]?.startsWith("--")) {
		switch (args[index]) {
			case "--fork":
				fork = true;
				index++;
				break;
			case "--async":
				async = true;
				index++;
				break;
			case "--notify": {
				const raw = args[index + 1];
				if (!raw || !/^\d+$/.test(raw)) usage();
				notifyPid = Number(raw);
				index += 2;
				break;
			}
			default:
				// Preserve the historical parser: an unknown --token becomes the prompt.
				break flagLoop;
		}
	}
	const prompt = args[index];
	if (!prompt) usage();
	if (notifyPid !== undefined && !async) {
		console.error("✗ --notify requires --async");
		process.exit(1);
	}
	return { fork, async, notifyPid, prompt };
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function resolveContextSource(): Promise<ContextSource> {
	const explicitStdin = Boolean(process.env.RLM_STDIN);
	const shouldReadStdin = explicitStdin || !process.stdin.isTTY;
	if (shouldReadStdin) {
		const context = await readStdin();
		if (context.length > 0 || explicitStdin) return { context };
	}
	if (process.env.CONTEXT && existsSync(process.env.CONTEXT)) {
		return { contextPath: process.env.CONTEXT };
	}
	return {};
}

function removeStaleArtifacts(): void {
	if (process.env.RLM_DEPTH !== "0") return;
	const root = process.env.TMPDIR || tmpdir();
	const cutoff = Date.now() - 120 * 60 * 1000;
	try {
		for (const name of readdirSync(root)) {
			if (!name.startsWith("rlm_") && !name.startsWith("ypi_ws_")) continue;
			const candidate = path.join(root, name);
			try {
				if (statSync(candidate).mtimeMs < cutoff) rmSync(candidate, { recursive: true, force: true });
			} catch {
				// A concurrent process may remove or update the candidate.
			}
		}
	} catch {
		// Reaping is best-effort and must never block a recursive call.
	}
}

function parentContext(cwd = process.cwd()) {
	return {
		cwd,
		provider: process.env.RLM_PROVIDER,
		model: process.env.RLM_MODEL,
		thinkingLevel: process.env.RLM_THINKING_LEVEL,
		sessionFile: process.env.RLM_SESSION_FILE || undefined,
		sessionDir: process.env.RLM_SESSION_DIR || undefined,
	};
}

function configuredExtensionPath(): string | null {
	const configured = process.env.YPI_EXTENSION_PATH;
	return configured && existsSync(configured) ? configured : null;
}

function writeTextOutput(text: string): void {
	if (!text) return;
	process.stdout.write(text);
	if (!text.endsWith("\n")) process.stdout.write("\n");
}

function cliErrorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const firstLine = message.split("\n", 1)[0] || "Recursive child failed";
	return `✗ ${firstLine}\n  Why: the canonical recursion runtime rejected the request or the child failed\n  Fix: inspect the remaining error text, configuration, and child output\n${message}`;
}

function errorExitCode(error: unknown): number {
	return error instanceof RecursiveChildError ? error.exitCode : 1;
}

function createOwnedContext(context: string): string {
	const contextDir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "ypi_async_context_"));
	const contextPath = path.join(contextDir, "context.txt");
	writeFileSync(contextPath, context, { mode: 0o600 });
	return contextPath;
}

function createAsyncJob(flags: CliFlags, source: ContextSource, extensionPath: string | null): AsyncJob {
	const traceId = safeTraceId(process.env.RLM_TRACE_ID || randomBytes(4).toString("hex"));
	process.env.RLM_TRACE_ID = traceId;
	const id = `rlm_async_${traceId}_${randomBytes(4).toString("hex")}`;
	const root = process.env.TMPDIR || tmpdir();
	const ownedContextPath = source.context !== undefined ? createOwnedContext(source.context) : undefined;
	const jobPath = path.join(root, `${id}.job.json`);
	return {
		prompt: flags.prompt,
		fork: flags.fork,
		notifyPid: flags.notifyPid,
		cwd: process.cwd(),
		contextPath: ownedContextPath || source.contextPath,
		ownedContextPath,
		outputPath: path.join(root, `${id}.txt`),
		sentinelPath: path.join(root, `${id}.done`),
		jobPath,
		extensionPath,
	};
}

function launchAsyncWorker(job: AsyncJob): number {
	writeFileSync(job.jobPath, `${JSON.stringify(job)}\n`, { mode: 0o600 });
	const cliPath = fileURLToPath(import.meta.url);
	const child = spawn(process.execPath, [cliPath, "--ypi-async-worker", job.jobPath], {
		cwd: job.cwd,
		env: process.env,
		stdio: "ignore",
		detached: process.platform !== "win32",
	});
	child.unref();
	return child.pid || 0;
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

function cleanupAsyncJob(job: AsyncJob): void {
	rmSync(job.jobPath, { force: true });
	if (job.ownedContextPath) rmSync(path.dirname(job.ownedContextPath), { recursive: true, force: true });
}

async function executeRequest(runtime: YpiRuntime, flags: Pick<CliFlags, "prompt" | "fork">, source: ContextSource, cwd = process.cwd(), extensionPath: string | null = configuredExtensionPath()) {
	return runRecursiveChild(runtime, {
		prompt: flags.prompt,
		fork: flags.fork,
		caller: "cli",
		context: source.context,
		contextPath: source.contextPath,
		extensionPath,
		parent: parentContext(cwd),
	});
}

async function runWorker(jobPath: string): Promise<void> {
	const job = JSON.parse(readFileSync(jobPath, "utf8")) as AsyncJob;
	const runtime = activeRuntime();
	ensureEnvironment(runtime);
	let code = 0;
	try {
		const result = await executeRequest(runtime, { prompt: job.prompt, fork: job.fork }, { contextPath: job.contextPath }, job.cwd, job.extensionPath);
		writeFileSync(job.outputPath, result.text);
	} catch (error) {
		code = errorExitCode(error);
		writeFileSync(job.outputPath, `${cliErrorText(error)}\n`);
	} finally {
		try { writeFileSync(job.sentinelPath, `${code}\n`); } catch { /* caller sees missing sentinel */ }
		try { notifyPeer(job); } catch { /* notification is best-effort */ }
		cleanupAsyncJob(job);
	}
}

export async function main(args = process.argv.slice(2)): Promise<number> {
	if (args[0] === "--ypi-async-worker") {
		if (!args[1]) usage();
		await runWorker(args[1]);
		return 0;
	}

	const runtime = activeRuntime();
	const extensionPath = configuredExtensionPath();
	ensureEnvironment(runtime);
	removeStaleArtifacts();
	const flags = parseFlags(args);
	const source = await resolveContextSource();

	if (flags.async) {
		const job = createAsyncJob(flags, source, extensionPath);
		const pid = launchAsyncWorker(job);
		process.stdout.write(`${JSON.stringify({
			job_id: path.basename(job.outputPath, ".txt"),
			output: job.outputPath,
			sentinel: job.sentinelPath,
			pid,
		})}\n`);
		return 0;
	}

	try {
		const result = await executeRequest(runtime, flags, source, process.cwd(), extensionPath);
		writeTextOutput(result.text);
		return 0;
	} catch (error) {
		console.error(cliErrorText(error));
		return errorExitCode(error);
	}
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	process.exitCode = await main();
}
