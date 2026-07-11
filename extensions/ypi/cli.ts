import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureEnvironment } from "./env.ts";
import { createAsyncJob, finishAsyncJob, launchAsyncWorker, markAsyncJobAdmitted, readAsyncJob, waitForAsyncAdmission } from "./internal/cli-async.ts";
import { resolveContextSource, type ContextSource } from "./internal/cli-input.ts";
import { formatRecursiveResultForTool, RecursiveChildError, runRecursiveChild } from "./runtime-core.ts";
import { resolveRuntime, type YpiRuntime } from "./runtime.ts";

interface CliFlags {
	fork: boolean;
	async: boolean;
	notifyPid?: number;
	prompt: string;
}

interface CliExecutionOptions {
	cwd?: string;
	extensionPath?: string | null;
	treeStartTimeSeconds?: number;
	onText?: (text: string) => void;
	onAdmitted?: (callCount: number) => void;
	signal?: AbortSignal;
}

const modulePath = fileURLToPath(import.meta.url);
const moduleExtensionPath = path.basename(modulePath) === "rlm_query.mjs" && path.basename(path.dirname(modulePath)) === "dist"
	? path.join(path.dirname(modulePath), "..", "extensions", "recursive.ts")
	: fileURLToPath(new URL("../recursive.ts", import.meta.url));
const runtimeFromModule = resolveRuntime(pathToFileURL(moduleExtensionPath).href);

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

function cliErrorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const firstLine = message.split("\n", 1)[0] || "Recursive child failed";
	return `✗ ${firstLine}\n  Why: the canonical recursion runtime rejected the request or the child failed\n  Fix: inspect the remaining error text, configuration, and child output\n${message}`;
}

function errorExitCode(error: unknown): number {
	if (error instanceof RecursiveChildError) return error.exitCode;
	if (typeof error === "object" && error !== null && "exitCode" in error && typeof error.exitCode === "number") return error.exitCode;
	return 1;
}

async function executeRequest(runtime: YpiRuntime, flags: Pick<CliFlags, "prompt" | "fork">, source: ContextSource, options: CliExecutionOptions = {}) {
	return runRecursiveChild(runtime, {
		prompt: flags.prompt,
		fork: flags.fork,
		caller: "cli",
		context: source.context,
		contextPath: source.contextPath,
		extensionPath: options.extensionPath === undefined ? configuredExtensionPath() : options.extensionPath,
		treeStartTimeSeconds: options.treeStartTimeSeconds,
		onText: options.onText,
		onAdmitted: options.onAdmitted,
		signal: options.signal,
		parent: parentContext(options.cwd),
	});
}

async function runWorker(jobPath: string): Promise<void> {
	const job = readAsyncJob(jobPath);
	const runtime = activeRuntime();
	ensureEnvironment(runtime);
	if (job.parentSessionSnapshot) process.env.RLM_SESSION_FILE = job.parentSessionSnapshot;
	let code = 0;
	let output = "";
	try {
		const result = await executeRequest(runtime, { prompt: job.prompt, fork: job.fork }, { contextPath: job.contextPath }, {
			cwd: job.cwd,
			extensionPath: job.extensionPath,
			treeStartTimeSeconds: job.treeStartTimeSeconds,
			onAdmitted: () => markAsyncJobAdmitted(job),
		});
		output = formatRecursiveResultForTool(result);
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

	const invocationStartedAt = Math.floor(Date.now() / 1000);
	const runtime = activeRuntime();
	ensureEnvironment(runtime);
	const extensionPath = configuredExtensionPath();
	if (process.env.RLM_DEPTH === "0") process.env.RLM_START_TIME = String(invocationStartedAt);
	const flags = parseFlags(args);
	const source = await resolveContextSource();

	if (flags.async) {
		try {
			const job = createAsyncJob({
				prompt: flags.prompt,
				fork: flags.fork,
				notifyPid: flags.notifyPid,
				cwd: process.cwd(),
				context: source.context,
				contextPath: source.contextPath,
				extensionPath,
				treeStartTimeSeconds: invocationStartedAt,
			});
			const pid = launchAsyncWorker(job, fileURLToPath(import.meta.url));
			await waitForAsyncAdmission(job);
			process.stdout.write(`${JSON.stringify({
				job_id: path.basename(path.dirname(job.jobPath)),
				output: job.outputPath,
				sentinel: job.sentinelPath,
				pid,
			})}\n`);
			return 0;
		} catch (error) {
			console.error(cliErrorText(error));
			return errorExitCode(error);
		} finally {
			source.cleanup?.();
		}
	}

	const controller = new AbortController();
	const abort = () => controller.abort();
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	let lastTextCharacter = "";
	try {
		const result = await executeRequest(runtime, flags, source, {
			cwd: process.cwd(),
			extensionPath,
			treeStartTimeSeconds: invocationStartedAt,
			signal: controller.signal,
			onText(text) {
				process.stdout.write(text);
				lastTextCharacter = text.at(-1) || lastTextCharacter;
			},
		});
		if (lastTextCharacter && lastTextCharacter !== "\n") process.stdout.write("\n");
		for (const warning of result.warnings) console.error(`[${warning}]`);
		if (result.stderr) console.error(result.stderr);
		return 0;
	} catch (error) {
		console.error(cliErrorText(error));
		return errorExitCode(error);
	} finally {
		process.removeListener("SIGINT", abort);
		process.removeListener("SIGTERM", abort);
		source.cleanup?.();
	}
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	process.exitCode = await main();
}
