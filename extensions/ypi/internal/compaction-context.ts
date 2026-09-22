import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { ContextEvent, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

/** Project Pi's redundant file inventory without changing its stored checkpoint. */
export function projectCompactionFileHistory(
	messages: ContextEvent["messages"],
	branch: SessionEntry[],
	sessionFile: string,
): ContextEvent["messages"] {
	if (!path.isAbsolute(sessionFile)) return messages;
	return messages.map((message) => {
		if (message.role !== "compactionSummary") return message;
		const matches = branch.filter((entry) => entry.type === "compaction"
			&& entry.summary === message.summary
			&& Date.parse(entry.timestamp) === message.timestamp
			&& entry.tokensBefore === message.tokensBefore);
		if (matches.length !== 1) return message;
		const entry = matches[0];
		if (entry.type !== "compaction" || entry.fromHook || typeof entry.id !== "string" || !entry.id) return message;
		const details = entry.details;
		if (!details || typeof details !== "object" || Array.isArray(details)) return message;
		const { readFiles, modifiedFiles } = details as Record<string, unknown>;
		if (!Array.isArray(readFiles) || !Array.isArray(modifiedFiles)
			|| ![...readFiles, ...modifiedFiles].every((file) => typeof file === "string" && file.length > 0)) {
			return message;
		}
		// Match the complete suffix emitted by Pi's formatFileOperations. Prose
		// containing similar tags, unknown formats and custom summaries stay intact.
		const sections: string[] = [];
		if (readFiles.length) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
		if (modifiedFiles.length) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
		if (!sections.length) return message;
		const appendix = `\n\n${sections.join("\n\n")}`;
		if (!message.summary.endsWith(appendix)) return message;
		const reference = `\n\n<file-history>\nCumulative file inventory: ${readFiles.length} read, ${modifiedFiles.length} modified. `
			+ `The complete exact paths remain in session JSONL ${JSON.stringify(sessionFile)}, `
			+ `compaction entry ${JSON.stringify(entry.id)}, fields details.readFiles and details.modifiedFiles.\n</file-history>`;
		if (Buffer.byteLength(reference) >= Buffer.byteLength(appendix)) return message;
		return { ...message, summary: message.summary.slice(0, -appendix.length) + reference };
	});
}

export function registerCompactionContextProjection(pi: ExtensionAPI): void {
	pi.on("context", (event, ctx) => {
		if (!event.messages.some((message) => message.role === "compactionSummary")) return;
		// Pi's line-based read tool cannot select fields near the end of a large
		// JSONL entry. Keep paths inline when the caller cannot query that record.
		if (!pi.getActiveTools().includes("bash")) return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		try {
			// In-memory sessions and missing/unreadable transcripts keep the full
			// inventory because a retrieval pointer would not be useful there.
			accessSync(sessionFile, constants.R_OK);
			if (!statSync(sessionFile).isFile()) return;
			return { messages: projectCompactionFileHistory(event.messages, ctx.sessionManager.getBranch(), sessionFile) };
		} catch {
			return;
		}
	});
}
