import { spawn } from "node:child_process";
import type { CostSummary } from "../guardrails.ts";

export const MAX_TOOL_OUTPUT_CHARS = 60 * 1024;
export const MAX_CHILD_STREAM_CHARS = 16 * 1024 * 1024;

export interface ChildProcessResult {
	code: number;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	timedOut: boolean;
}

export interface NormalizedChildOutput {
	text: string;
	cost?: CostSummary;
}

interface BoundedCapture {
	append(chunk: string): void;
	text(): string;
	readonly truncated: boolean;
}

function createBoundedCapture(limit = MAX_CHILD_STREAM_CHARS): BoundedCapture {
	const chunks: string[] = [];
	let retained = 0;
	let wasTruncated = false;
	return {
		append(chunk: string) {
			const remaining = limit - retained;
			if (remaining <= 0) {
				wasTruncated = true;
				return;
			}
			if (chunk.length > remaining) {
				chunks.push(chunk.slice(0, remaining));
				retained += remaining;
				wasTruncated = true;
				return;
			}
			chunks.push(chunk);
			retained += chunk.length;
		},
		text: () => chunks.join(""),
		get truncated() { return wasTruncated; },
	};
}

function truncate(text: string): string {
	if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[Output truncated by ypi recursion runtime]`;
}

function parsePiJsonOutput(stdout: string): { text: string; cost: CostSummary } {
	let text = "";
	let cost = 0;
	let tokens = 0;
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") text += String(event.assistantMessageEvent.delta || "");
			if (event.type === "turn_end") {
				const usage = event.message?.usage || {};
				cost += Number(usage.cost?.total || 0);
				tokens += Number(usage.totalTokens || 0);
			}
		} catch {
			// Ignore non-JSON chatter from extensions or wrappers.
		}
	}
	return { text, cost: { cost, tokens } };
}

export function normalizeChildOutput(result: ChildProcessResult, jsonMode: boolean): NormalizedChildOutput {
	const parsed = jsonMode ? parsePiJsonOutput(result.stdout) : undefined;
	const stdout = parsed ? parsed.text : result.stdout;
	const streamWarnings = [
		result.stdoutTruncated ? `Child stdout capture exceeded ${MAX_CHILD_STREAM_CHARS} characters; remainder discarded` : "",
		result.stderrTruncated ? `Child stderr capture exceeded ${MAX_CHILD_STREAM_CHARS} characters; remainder discarded` : "",
	].filter(Boolean);
	const warningPrefix = streamWarnings.length > 0 ? `[${streamWarnings.join("; ")}]\n\n` : "";
	const combinedOutput = result.stderr.trim() ? `${stdout.trim()}\n\n[stderr]\n${result.stderr.trim()}` : stdout.trim();
	return { text: truncate(`${warningPrefix}${combinedOutput}`), cost: parsed?.cost };
}

export function runChildProcess(args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutSeconds: number | undefined, signal?: AbortSignal): Promise<ChildProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.env.YPI_PI_BIN || "pi", args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		const stdout = createBoundedCapture();
		const stderr = createBoundedCapture();
		let timedOut = false;
		let killTimer: NodeJS.Timeout | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => stdout.append(chunk));
		child.stderr.on("data", (chunk) => stderr.append(chunk));

		const killChild = (reason: "abort" | "timeout") => {
			if (reason === "timeout") timedOut = true;
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
			signal?.removeEventListener("abort", abortHandler);
			if (killTimer) clearTimeout(killTimer);
			if (timeoutTimer) clearTimeout(timeoutTimer);
		};

		child.on("error", (error) => { cleanup(); reject(error); });
		child.on("close", (code, childSignal) => {
			cleanup();
			resolve({
				code: timedOut ? 124 : code ?? (childSignal ? 128 : 1),
				signal: childSignal,
				stdout: stdout.text(),
				stderr: stderr.text(),
				stdoutTruncated: stdout.truncated,
				stderrTruncated: stderr.truncated,
				timedOut,
			});
		});
		if (timeoutSeconds !== undefined) timeoutTimer = setTimeout(() => killChild("timeout"), timeoutSeconds * 1000);
		if (signal?.aborted) abortHandler();
		else signal?.addEventListener("abort", abortHandler, { once: true });
	});
}
