// Shared context-file tree for the deterministic and real-Pi deduplication
// harnesses. Pi walks from the working directory up to the filesystem root and
// renders the files outermost first, so this tree places one shared file at
// three depths (original, relative symlink, byte-identical copy) between
// distinct files that must survive.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ContextFileFixture {
	/** Pi agent directory holding the distinct global context file. */
	agentDir: string;
	/** Working directory for Pi; the nearest context file lives here. */
	cwd: string;
	paths: {
		global: string;
		shared: string;
		middle: string;
		symlink: string;
		copy: string;
		nearDuplicate: string;
	};
	contents: {
		global: string;
		shared: string;
		middle: string;
		nearDuplicate: string;
	};
}

export interface RenderedContextFile {
	path: string;
	content: string;
}

const SHARED = "# Shared rules\n\nypi-context-fixture: shared rules apply to the whole tree.\n";

export function createContextFileFixture(root: string): ContextFileFixture {
	const agentDir = path.join(root, "agent");
	const tree = path.join(root, "tree");
	const middle = path.join(tree, "middle");
	const linked = path.join(middle, "linked");
	const copied = path.join(linked, "copied");
	const cwd = path.join(copied, "near");
	for (const directory of [agentDir, cwd]) mkdirSync(directory, { recursive: true, mode: 0o700 });
	const contents = {
		global: "ypi-context-fixture: global user rules.\n",
		shared: SHARED,
		middle: "ypi-context-fixture: middle directory rules.\n",
		// One extra line: a near duplicate is distinct project text and must stay.
		nearDuplicate: `${SHARED}ypi-context-fixture: near duplicate differs by one line.\n`,
	};
	const paths = {
		global: path.join(agentDir, "AGENTS.md"),
		shared: path.join(tree, "AGENTS.md"),
		middle: path.join(middle, "AGENTS.md"),
		symlink: path.join(linked, "AGENTS.md"),
		copy: path.join(copied, "CLAUDE.md"),
		nearDuplicate: path.join(cwd, "AGENTS.md"),
	};
	writeFileSync(paths.global, contents.global);
	writeFileSync(paths.shared, contents.shared);
	writeFileSync(paths.middle, contents.middle);
	// Relative, as in a monorepo package that links the repository rules.
	symlinkSync("../../AGENTS.md", paths.symlink);
	writeFileSync(paths.copy, contents.shared);
	writeFileSync(paths.nearDuplicate, contents.nearDuplicate);
	return { agentDir, cwd, paths, contents };
}

/** Parse Pi's rendered `<project_instructions>` blocks from a system prompt. */
export function parseRenderedContextFiles(systemPrompt: string): RenderedContextFile[] {
	const blocks = systemPrompt.matchAll(/<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>/g);
	return [...blocks].map(([, filePath, content]) => ({ path: filePath, content }));
}

/** The rendered files that belong to the fixture, in prompt order. */
export function fixtureContextFiles(fixture: ContextFileFixture, rendered: RenderedContextFile[]): RenderedContextFile[] {
	const owned = new Set(Object.values(fixture.paths));
	return rendered.filter((file) => owned.has(file.path));
}

/** Expected prompt order before deduplication: global, then outermost to nearest. */
export function piLoadedOrder(fixture: ContextFileFixture): RenderedContextFile[] {
	const { paths, contents } = fixture;
	return [
		{ path: paths.global, content: contents.global },
		{ path: paths.shared, content: contents.shared },
		{ path: paths.middle, content: contents.middle },
		{ path: paths.symlink, content: contents.shared },
		{ path: paths.copy, content: contents.shared },
		{ path: paths.nearDuplicate, content: contents.nearDuplicate },
	];
}

/** Expected order after ypi keeps only the nearest exact duplicate. */
export function deduplicatedOrder(fixture: ContextFileFixture): RenderedContextFile[] {
	const { paths, contents } = fixture;
	return [
		{ path: paths.global, content: contents.global },
		{ path: paths.middle, content: contents.middle },
		{ path: paths.copy, content: contents.shared },
		{ path: paths.nearDuplicate, content: contents.nearDuplicate },
	];
}
