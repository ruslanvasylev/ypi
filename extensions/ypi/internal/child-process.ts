import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { CostSummary } from "../guardrails.ts";
import {
	createBoundedCapture,
	createJsonDecoder,
	MAX_CHILD_STREAM_CHARS,
	MAX_TOOL_OUTPUT_CHARS,
	type ChildOutputSnapshot,
} from "./child-output.ts";

export interface ChildProcessOptions {
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
	timeoutSeconds?: number;
	signal?: AbortSignal;
	jsonMode: boolean;
	onText?: (text: string) => boolean | void;
	onTextDrain?: () => Promise<void>;
	onSpawn?: (pid: number) => void;
}

export interface ChildProcessResult extends ChildOutputSnapshot {
	code: number;
	signal: NodeJS.Signals | null;
	cost?: CostSummary;
	timedOut: boolean;
	cancelled: boolean;
}

function signalledExitCode(signal: NodeJS.Signals | null): number {
	if (!signal) return 1;
	return 128 + (osConstants.signals[signal] || 0);
}

export function runChildProcess(options: ChildProcessOptions): Promise<ChildProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.env.YPI_PI_BIN || "pi", options.args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		if (child.pid) options.onSpawn?.(child.pid);
		let stdoutCharacters = 0;
		const rawStderr = createBoundedCapture(MAX_TOOL_OUTPUT_CHARS);
		const plainText = createBoundedCapture(MAX_TOOL_OUTPUT_CHARS);
		const jsonDecoder = createJsonDecoder(options.onText);
		let timedOut = false;
		let cancelled = false;
		let terminating = false;
		let killTimer: NodeJS.Timeout | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		let flowPaused = false;
		const applyBackpressure = (keepFlowing: boolean | void) => {
			if (keepFlowing !== false || flowPaused) return;
			flowPaused = true;
			child.stdout.pause();
			(options.onTextDrain?.() || Promise.resolve()).finally(() => {
				flowPaused = false;
				if (!child.stdout.destroyed) child.stdout.resume();
			});
		};
		child.stdout.on("data", (chunk: string) => {
			stdoutCharacters += chunk.length;
			if (options.jsonMode) applyBackpressure(jsonDecoder.append(chunk));
			else {
				const accepted = plainText.append(chunk);
				if (accepted) applyBackpressure(options.onText?.(accepted));
			}
		});
		child.stderr.on("data", (chunk: string) => rawStderr.append(chunk));

		const killChild = (reason: "abort" | "timeout") => {
			if (terminating) return;
			terminating = true;
			if (reason === "timeout") timedOut = true;
			else cancelled = true;
			if (!child.pid) {
				child.kill("SIGTERM");
				return;
			}
			const target = process.platform === "win32" ? child.pid : -child.pid;
			try { process.kill(target, "SIGTERM"); } catch { child.kill("SIGTERM"); }
			killTimer = setTimeout(() => {
				try { process.kill(target, "SIGKILL"); } catch { child.kill("SIGKILL"); }
			}, 1500);
		};
		const abortHandler = () => killChild("abort");
		const cleanup = () => {
			options.signal?.removeEventListener("abort", abortHandler);
			if (killTimer) clearTimeout(killTimer);
			if (timeoutTimer) clearTimeout(timeoutTimer);
		};

		child.on("error", (error) => { cleanup(); reject(error); });
		child.on("close", (code, childSignal) => {
			cleanup();
			jsonDecoder.finish();
			const json = jsonDecoder.result();
			resolve({
				code: timedOut ? 124 : cancelled ? 130 : code ?? signalledExitCode(childSignal),
				signal: childSignal,
				stderr: rawStderr.text(),
				text: options.jsonMode ? json.text : plainText.text(),
				cost: options.jsonMode ? json.cost : undefined,
				stdoutTruncated: stdoutCharacters > MAX_CHILD_STREAM_CHARS,
				stderrTruncated: rawStderr.truncated,
				textTruncated: options.jsonMode ? json.textTruncated : plainText.truncated,
				jsonEventTruncated: options.jsonMode ? json.jsonEventTruncated : false,
				jsonCostIncomplete: options.jsonMode ? json.jsonCostIncomplete : false,
				timedOut,
				cancelled,
			});
		});
		if (options.timeoutSeconds !== undefined) timeoutTimer = setTimeout(() => killChild("timeout"), options.timeoutSeconds * 1000);
		if (options.signal?.aborted) abortHandler();
		else options.signal?.addEventListener("abort", abortHandler, { once: true });
	});
}
