// Deterministic proof that ypi removes only exact duplicate Pi context files.
//
// Pure cases pin the keep-nearest rule. The fixture tree then goes through the
// pinned Pi loader, the real recursive extension in Pi's before_agent_start
// runner, and Pi's own section renderer, without a Pi process or model call.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ExtensionRunner, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import recursiveExtension from "../extensions/recursive.ts";
import { deduplicateContextFiles, deduplicatePromptContextFiles } from "../extensions/ypi/internal/context-files.ts";
import type { ContextFile } from "../extensions/ypi/internal/context-files.ts";
import {
	createContextFileFixture,
	deduplicatedOrder,
	fixtureContextFiles,
	parseRenderedContextFiles,
	piLoadedOrder,
} from "./helpers/context_files_fixture.ts";

type Handler = (...args: never[]) => unknown;

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const { buildSystemPromptSections } = await import(pathToFileURL(path.join(packageRoot, "dist/core/system-prompt.js")).href);
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "ypi-context-files-")));
chmodSync(scratch, 0o700);
const originalEnvironment = { ...process.env };
let passed = 0;
let shutdown: (() => Promise<void>) | undefined;

function check(name: string, run: () => void): void {
	run();
	passed++;
	console.log(`  PASS ${name}`);
}

const file = (filePath: string, content: string): ContextFile => ({ path: filePath, content });

try {
	check("empty and single lists are unchanged", () => {
		assert.deepEqual(deduplicateContextFiles([]), { kept: [], removed: [] });
		const only = [file("/a/AGENTS.md", "rules\n")];
		assert.deepEqual(deduplicateContextFiles(only), { kept: only, removed: [] });
	});
	check("distinct files keep their exact order", () => {
		const files = [file("/AGENTS.md", "a\n"), file("/x/AGENTS.md", "b\n"), file("/x/y/CLAUDE.md", "c\n")];
		assert.deepEqual(deduplicateContextFiles(files).kept, files);
	});
	check("exact duplicates keep the occurrence nearest the working directory", () => {
		const files = [file("/repo/AGENTS.md", "shared\n"), file("/repo/mid/AGENTS.md", "mid\n"), file("/repo/mid/pkg/AGENTS.md", "shared\n")];
		const result = deduplicateContextFiles(files);
		assert.deepEqual(result.kept.map(({ path: filePath }) => filePath), ["/repo/mid/AGENTS.md", "/repo/mid/pkg/AGENTS.md"]);
		assert.deepEqual(result.removed, [{ path: "/repo/AGENTS.md", keptPath: "/repo/mid/pkg/AGENTS.md", bytes: 7 }]);
	});
	check("near duplicates and whitespace-only differences stay", () => {
		const files = [file("/a/AGENTS.md", "rules"), file("/a/b/AGENTS.md", "rules\n"), file("/a/b/c/AGENTS.md", "rules \n"), file("/a/b/c/d/AGENTS.md", "Rules\n")];
		assert.deepEqual(deduplicateContextFiles(files), { kept: files, removed: [] });
	});
	check("interleaved duplicate groups resolve independently", () => {
		const files = [file("/1", "A"), file("/2", "B"), file("/3", "A"), file("/4", "C"), file("/5", "B")];
		assert.deepEqual(deduplicateContextFiles(files).kept.map(({ path: filePath }) => filePath), ["/3", "/4", "/5"]);
	});
	check("byte accounting uses UTF-8 length", () => {
		const removed = deduplicateContextFiles([file("/a", "é任务\n"), file("/b", "é任务\n")]).removed;
		assert.deepEqual(removed, [{ path: "/a", keptPath: "/b", bytes: Buffer.byteLength("é任务\n") }]);
	});
	check("the pure function never mutates its input", () => {
		const files = [file("/a", "same"), file("/b", "same")];
		const snapshot = structuredClone(files);
		deduplicateContextFiles(files);
		assert.deepEqual(files, snapshot);
	});
	check("prompt options are rewritten in place and tolerate absent lists", () => {
		const contextFiles = [file("/a", "same"), file("/b", "other"), file("/c", "same")];
		const options = { contextFiles };
		assert.equal(deduplicatePromptContextFiles(options).length, 1);
		assert.equal(options.contextFiles, contextFiles, "Pi's mutable array is edited in place");
		assert.deepEqual(contextFiles.map(({ path: filePath }) => filePath), ["/b", "/c"]);
		assert.deepEqual(deduplicatePromptContextFiles({}), [], "an absent list is left alone");
	});

	const fixture = createContextFileFixture(scratch);
	const loaded = loadProjectContextFiles({ cwd: fixture.cwd, agentDir: fixture.agentDir });
	check("pinned Pi loads the symlink and the copy as separate context files", () => {
		assert.deepEqual(fixtureContextFiles(fixture, loaded), piLoadedOrder(fixture));
	});

	// Real recursive extension in Pi's own before_agent_start runner.
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("RLM_") || key.startsWith("YPI_") || key === "CONTEXT" || key === "PI_TRACE_FILE") delete process.env[key];
	}
	Object.assign(process.env, { RLM_DEPTH: "0", RLM_SHARED_SESSIONS: "0", TMPDIR: scratch });
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); },
		registerTool() {},
		getThinkingLevel: () => "medium",
		getAllTools: () => [{ name: "read" }, { name: "rlm_query" }],
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: fixture.cwd, hasUI: false,
		model: { provider: "test", id: "test" },
		sessionManager: { getSessionFile: () => undefined, getSessionDir: () => scratch },
	} as unknown as ExtensionContext;
	recursiveExtension(pi);
	shutdown = async () => {
		for (const handler of handlers.get("session_shutdown") || []) await (handler as (event: unknown, context: unknown) => unknown)({ type: "session_shutdown" }, ctx);
	};
	let observedPrompt = "";
	const observer = { path: "observer", handlers: new Map([["before_agent_start", [(event: BeforeAgentStartEvent) => { observedPrompt = event.systemPrompt; }]]]) };
	const runner = new ExtensionRunner([{ path: "ypi", handlers }, observer] as never, {} as never, fixture.cwd, ctx.sessionManager, {} as never);
	runner.createContext = () => ctx;
	const options = { cwd: fixture.cwd, selectedTools: ["read"], sections: {}, contextFiles: loaded };
	const trigger = { messageType: "custom", message: { role: "custom", customType: "fixture", content: "probe", display: false, timestamp: 1 } };
	const result = await runner.emitBeforeAgentStart(trigger as never, options);

	check("ypi removes the symlinked and copied duplicates from the run options", () => {
		assert.deepEqual(fixtureContextFiles(fixture, result.systemPromptOptions.contextFiles), deduplicatedOrder(fixture));
		assert.equal(loaded.length, result.systemPromptOptions.contextFiles.length + 2, "only the two exact duplicates are removed");
		assert.deepEqual(fixtureContextFiles(fixture, loaded), piLoadedOrder(fixture), "Pi's base prompt options are not mutated");
		assert.ok(result.systemPromptOptions.sections.ypi, "ypi still adds its prompt section");
	});
	check("Pi renders the shared file once, and every distinct file stays", () => {
		const sections = buildSystemPromptSections(result.systemPromptOptions) as Record<string, string>;
		for (const prompt of [observedPrompt, Object.values(sections).join("\n\n")]) {
			const rendered = fixtureContextFiles(fixture, parseRenderedContextFiles(prompt));
			assert.deepEqual(rendered, deduplicatedOrder(fixture));
			assert.equal(rendered.filter(({ content }) => content === fixture.contents.shared).length, 1);
		}
	});
	console.log(JSON.stringify({ contextFiles: "PASS", checks: passed }));
} finally {
	await shutdown?.();
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, originalEnvironment);
	rmSync(scratch, { recursive: true, force: true });
}
