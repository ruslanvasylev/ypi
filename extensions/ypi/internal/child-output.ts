import type { CostSummary } from "../guardrails.ts";

export const MAX_TOOL_OUTPUT_CHARS = 60 * 1024;
export const MAX_CHILD_STREAM_CHARS = 16 * 1024 * 1024;
const MAX_JSON_EVENT_CHARS = 1024 * 1024;

export interface ChildOutputSnapshot {
	stderr: string;
	text: string;
	cost?: CostSummary;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	textTruncated: boolean;
	jsonEventTruncated: boolean;
	jsonCostIncomplete: boolean;
}

export interface NormalizedChildOutput {
	text: string;
	stderr: string;
	warnings: string[];
	cost?: CostSummary;
}

export interface BoundedCapture {
	append(chunk: string): string;
	text(): string;
	readonly truncated: boolean;
}

export interface JsonStreamDecoder {
	append(chunk: string): boolean;
	finish(): void;
	result(): { text: string; cost?: CostSummary; textTruncated: boolean; jsonEventTruncated: boolean; jsonCostIncomplete: boolean };
}

export function createBoundedCapture(limit: number): BoundedCapture {
	const chunks: string[] = [];
	let retained = 0;
	let wasTruncated = false;
	return {
		append(chunk: string) {
			const remaining = limit - retained;
			if (remaining <= 0) {
				wasTruncated = true;
				return "";
			}
			const accepted = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
			chunks.push(accepted);
			retained += accepted.length;
			if (accepted.length < chunk.length) wasTruncated = true;
			return accepted;
		},
		text: () => chunks.join(""),
		get truncated() { return wasTruncated; },
	};
}

function truncate(text: string): string {
	if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[Output truncated by ypi recursion runtime]`;
}

export function createJsonDecoder(onText?: (text: string) => boolean | void): JsonStreamDecoder {
	const text = createBoundedCapture(MAX_TOOL_OUTPUT_CHARS);
	let pending = "";
	let droppingOversizedLine = false;
	let jsonEventTruncated = false;
	let jsonCostIncomplete = false;
	let cost = 0;
	let tokens = 0;
	let sawTurnEnd = false;

	const classifyOversizedLine = (prefix: string) => {
		const eventType = /"type"\s*:\s*"([^"]+)"/.exec(prefix)?.[1];
		if (!eventType || eventType === "turn_end") jsonCostIncomplete = true;
	};

	const processLine = (line: string): boolean => {
		if (!line.trim()) return true;
		let keepFlowing = true;
		try {
			const event = JSON.parse(line);
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				const delta = String(event.assistantMessageEvent.delta || "");
				text.append(delta);
				if (delta && onText?.(delta) === false) keepFlowing = false;
			}
			if (event.type === "turn_end") {
				sawTurnEnd = true;
				const usage = event.message?.usage || {};
				cost += Number(usage.cost?.total || 0);
				tokens += Number(usage.totalTokens || 0);
			}
		} catch {
			// Ignore non-JSON chatter from extensions or wrappers.
		}
		return keepFlowing;
	};

	return {
		append(chunk: string) {
			let rest = chunk;
			let keepFlowing = true;
			while (rest.length > 0) {
				if (droppingOversizedLine) {
					const newline = rest.indexOf("\n");
					if (newline < 0) return keepFlowing;
					rest = rest.slice(newline + 1);
					droppingOversizedLine = false;
					continue;
				}

				const newline = rest.indexOf("\n");
				if (newline < 0) {
					if (pending.length + rest.length > MAX_JSON_EVENT_CHARS) {
						classifyOversizedLine(pending + rest.slice(0, Math.max(0, MAX_JSON_EVENT_CHARS - pending.length)));
						pending = "";
						droppingOversizedLine = true;
						jsonEventTruncated = true;
					} else {
						pending += rest;
					}
					return keepFlowing;
				}

				if (pending.length + newline > MAX_JSON_EVENT_CHARS) {
					classifyOversizedLine(pending + rest.slice(0, Math.max(0, MAX_JSON_EVENT_CHARS - pending.length)));
					jsonEventTruncated = true;
				} else if (!processLine(pending + rest.slice(0, newline))) {
					keepFlowing = false;
				}
				pending = "";
				rest = rest.slice(newline + 1);
			}
			return keepFlowing;
		},
		finish() {
			if (!droppingOversizedLine && pending) processLine(pending);
			pending = "";
		},
		result() {
			return {
				text: text.text(),
				cost: sawTurnEnd ? { cost, tokens } : undefined,
				textTruncated: text.truncated,
				jsonEventTruncated,
				jsonCostIncomplete,
			};
		},
	};
}

export function normalizeChildOutput(result: ChildOutputSnapshot): NormalizedChildOutput {
	const warnings = [
		result.stdoutTruncated ? `Child stdout stream exceeded ${MAX_CHILD_STREAM_CHARS} characters; raw diagnostics were not retained` : "",
		result.stderrTruncated ? `Child stderr exceeded ${MAX_TOOL_OUTPUT_CHARS} characters; remainder discarded` : "",
		result.textTruncated ? `Child answer exceeded ${MAX_TOOL_OUTPUT_CHARS} characters; remainder discarded` : "",
		result.jsonEventTruncated ? `Oversized Pi JSON event exceeded ${MAX_JSON_EVENT_CHARS} characters and was skipped` : "",
		result.jsonCostIncomplete ? "Cost accounting is incomplete because an oversized turn_end or unclassified Pi JSON event was skipped" : "",
	].filter(Boolean);
	return {
		text: result.text,
		stderr: truncate(result.stderr.trim()),
		warnings,
		cost: result.cost,
	};
}

export function formatCombinedChildOutput(output: NormalizedChildOutput): string {
	const warningPrefix = output.warnings.length > 0 ? `[${output.warnings.join("; ")}]\n\n` : "";
	const combined = output.stderr ? `${output.text.trim()}\n\n[stderr]\n${output.stderr}` : output.text.trim();
	return truncate(`${warningPrefix}${combined}`);
}
