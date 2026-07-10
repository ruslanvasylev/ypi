import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureEnvironment } from "./env.ts";
import { createAsyncJob, finishAsyncJob, launchAsyncWorker, readAsyncJob } from "./internal/cli-async.ts";
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
	const job = readAsyncJob(jobPath);
	const runtime = activeRuntime();
	ensureEnvironment(runtime);
	let code = 0;
	let output = "";
	try {
		const result = await executeRequest(runtime, { prompt: job.prompt, fork: job.fork }, { contextPath: job.contextPath }, job.cwd, job.extensionPath);
		output = result.text;
	} catch (error) {
		code = errorExitCode(error);
		output = `${cliErrorText(error)}\n`;
	}
	finishAsyncJob(job, code, output);
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
		const job = createAsyncJob({
			prompt: flags.prompt,
			fork: flags.fork,
			notifyPid: flags.notifyPid,
			cwd: process.cwd(),
			context: source.context,
			contextPath: source.contextPath,
			extensionPath,
		});
		const pid = launchAsyncWorker(job, fileURLToPath(import.meta.url));
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
