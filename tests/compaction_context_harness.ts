import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { CompactionEntry, ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { projectCompactionFileHistory, registerCompactionContextProjection } from "../extensions/ypi/internal/compaction-context.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "ypi-compaction-é-"));
let passed = 0;
function check(name: string, run: () => void): void {
	run();
	passed++;
	console.log(`  PASS ${name}`);
}

const narrative = `## Goal\nFinish the requested work.\n## Constraints\nPreserve dirty work; do not publish.\n`
	+ `## Progress\nCompleted gate A; gate B is still blocked.\n## Next Steps\nVerify B.\n`
	+ `## Critical Context\nActive path /repo/équipe/任务.ts; proof /repo/proof.json at commit abc123.\n`
	+ `An example inside prose must survive: <read-files>example.ts</read-files>`;
const readFiles = Array.from({ length: 335 }, (_, i) => `/repo/history/équipe/任务-${i}/previous-investigation.ts`);
const modifiedFiles = Array.from({ length: 167 }, (_, i) => `/repo/history/commit-${i}/completed-implementation.ts`);
const appendix = `\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>`
	+ `\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`;

try {
	const session = SessionManager.create(scratch, scratch);
	const firstId = session.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() });
	session.appendMessage({
		role: "assistant", api: "openai-responses", provider: "openai", model: "fixture",
		content: [{ type: "text", text: "fixture response" }], stopReason: "stop", timestamp: Date.now(),
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	const compactionId = session.appendCompaction(narrative + appendix, firstId, 180000, { readFiles, modifiedFiles }, false);
	const entry = session.getEntry(compactionId) as CompactionEntry;
	const sessionFile = session.getSessionFile()!;
	const diskBefore = readFileSync(sessionFile, "utf8");
	const messages = session.buildSessionContext().messages;
	const originalMessages = structuredClone(messages);
	const project = () => projectCompactionFileHistory(messages, session.getBranch(), sessionFile);
	const projected = project();
	const summary = projected.find((message) => message.role === "compactionSummary")!;
	assert.equal(summary.role, "compactionSummary");
	if (summary.role !== "compactionSummary") throw new Error("missing summary");

	check("only the exact cumulative appendix is replaced; all narrative survives", () => {
		assert(summary.summary.startsWith(narrative + "\n\n<file-history>"));
		assert(summary.summary.includes(JSON.stringify(sessionFile)));
		assert(summary.summary.includes(JSON.stringify(compactionId)));
		assert(summary.summary.includes("335 read, 167 modified"));
		assert(summary.summary.includes("details.readFiles and details.modifiedFiles"));
		assert(Buffer.byteLength(summary.summary) < Buffer.byteLength(narrative + appendix) / 10);
	});
	check("original messages and persisted summary/details remain byte-for-byte unchanged", () => {
		assert.deepEqual(messages, originalMessages);
		assert.equal(readFileSync(sessionFile, "utf8"), diskBefore);
		const saved = diskBefore.split("\n").filter(Boolean).map((line) => JSON.parse(line))
			.find((record) => record.id === compactionId);
		assert.equal(saved.summary, narrative + appendix);
		assert.deepEqual(saved.details, { readFiles, modifiedFiles });
		assert.equal(summary.tokensBefore, entry.tokensBefore);
		assert.equal(summary.timestamp, Date.parse(entry.timestamp));
		assert.deepEqual(projected.filter((message) => message.role !== "compactionSummary"),
			messages.filter((message) => message.role !== "compactionSummary"));
	});
	check("repeated projection is stable and idempotent", () => {
		assert.deepEqual(project(), projected);
		assert.deepEqual(projectCompactionFileHistory(projected, session.getBranch(), sessionFile), projected);
	});
	check("resuming the actual persisted session yields the same reference", () => {
		const resumed = SessionManager.open(sessionFile);
		assert.deepEqual(projectCompactionFileHistory(resumed.buildSessionContext().messages, resumed.getBranch(), sessionFile), projected);
	});
	check("unknown/custom formats, malformed metadata and ambiguous matches pass through", () => {
		const variants: CompactionEntry[] = [
			{ ...entry, fromHook: true },
			{ ...entry, id: "" },
			{ ...entry, details: undefined },
			{ ...entry, details: [] },
			{ ...entry, details: { readFiles: [42], modifiedFiles } },
			{ ...entry, details: { readFiles, modifiedFiles: "wrong" } },
			{ ...entry, details: { readFiles: [], modifiedFiles: [] } },
			{ ...entry, details: { readFiles: [...readFiles].reverse(), modifiedFiles } },
			{ ...entry, timestamp: new Date(Date.parse(entry.timestamp) + 1).toISOString() },
			{ ...entry, tokensBefore: entry.tokensBefore + 1 },
			{ ...entry, summary: entry.summary + "additional content" },
		];
		for (const variant of variants) assert.deepEqual(projectCompactionFileHistory(messages, [variant], sessionFile), messages);
		assert.deepEqual(projectCompactionFileHistory(messages, [entry, entry], sessionFile), messages);
		assert.deepEqual(projectCompactionFileHistory(messages, [], sessionFile), messages);
		assert.equal(projectCompactionFileHistory(messages, [entry], "relative.jsonl"), messages);
	});
	check("small inventories are kept when a pointer would increase the payload", () => {
		const small = { ...entry, summary: `${narrative}\n\n<read-files>\na.ts\n</read-files>`,
			details: { readFiles: ["a.ts"], modifiedFiles: [] } };
		const smallMessage = { ...summary, summary: small.summary };
		assert.equal(projectCompactionFileHistory([smallMessage], [small], sessionFile)[0], smallMessage);
	});
	check("read-only and modified-only inventories project without changing Unicode prose", () => {
		for (const [tag, details] of [
			["read-files", { readFiles, modifiedFiles: [] }],
			["modified-files", { readFiles: [], modifiedFiles }],
		] as const) {
			const paths = tag === "read-files" ? details.readFiles : details.modifiedFiles;
			const source = `${narrative}\n\n<${tag}>\n${paths.join("\n")}\n</${tag}>`;
			const variant = { ...entry, summary: source, details };
			const result = projectCompactionFileHistory([{ ...summary, summary: source }], [variant], sessionFile)[0];
			assert(result.role === "compactionSummary" && result.summary.startsWith(narrative + "\n\n<file-history>"));
		}
	});
	check("active-branch matching excludes abandoned checkpoints and switches references", () => {
		session.branch(firstId);
		assert.deepEqual(projectCompactionFileHistory(messages, session.getBranch(), sessionFile), messages);
		const siblingId = session.appendCompaction(`Sibling goal\n${narrative}${appendix}`, firstId, 180001, { readFiles, modifiedFiles }, false);
		const sibling = projectCompactionFileHistory(session.buildSessionContext().messages, session.getBranch(), sessionFile)
			.find((message) => message.role === "compactionSummary");
		assert(sibling?.role === "compactionSummary");
		assert(sibling.summary.includes(JSON.stringify(siblingId)));
		assert(!sibling.summary.includes(JSON.stringify(compactionId)));
	});

	type Handler = (event: ContextEvent, ctx: ExtensionContext) => { messages: ContextEvent["messages"] } | undefined;
	let handler: Handler | undefined;
	let activeTools = ["read", "bash"];
	registerCompactionContextProjection({ getActiveTools: () => activeTools, on: (name: string, fn: Handler) => {
		assert.equal(name, "context");
		handler = fn;
	} } as unknown as ExtensionAPI);
	const invoke = handler!;
	const event: ContextEvent = { type: "context", messages: session.buildSessionContext().messages };
	const context = { sessionManager: session } as unknown as ExtensionContext;
	check("registered context hook projects real persisted Pi messages", () => {
		const result = invoke(event, context);
		assert(result?.messages.some((message) => message.role === "compactionSummary" && message.summary.includes("<file-history>")));
	});
	check("toolsets without JSONL query access retain the complete inline inventory", () => {
		activeTools = ["read", "grep", "find", "ls"];
		assert.equal(invoke(event, context), undefined);
		activeTools = ["read", "bash"];
	});
	check("missing/in-memory session and unavailable transcript keep full messages", () => {
		assert.equal(invoke(event, { sessionManager: { getSessionFile: () => undefined } } as unknown as ExtensionContext), undefined);
		assert.equal(invoke(event, { sessionManager: {
			getSessionFile: () => scratch, getBranch: () => session.getBranch(),
		} } as unknown as ExtensionContext), undefined);
		unlinkSync(sessionFile);
		assert.equal(invoke(event, context), undefined);
	});
	console.log(`COMPACTION_CONTEXT_PROJECTION=${Buffer.byteLength(narrative + appendix)}->${Buffer.byteLength(summary.summary)} bytes`);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log(`Results: ${passed} passed, 0 failed`);
