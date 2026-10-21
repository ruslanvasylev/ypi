import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

/** One context file exactly as Pi loaded it into the prompt options. */
export type ContextFile = NormalizedBuildSystemPromptOptions["contextFiles"][number];

export interface RemovedContextFile {
	path: string;
	/** The retained occurrence of the identical text. */
	keptPath: string;
	bytes: number;
}

export interface ContextFileDeduplication {
	kept: ContextFile[];
	removed: RemovedContextFile[];
}

/**
 * Remove context files whose loaded text is identical to another entry.
 *
 * Pi deduplicates only literal paths, so a symlinked, hard-linked, or copied
 * AGENTS.md is rendered again for each directory that names it. Pi orders the
 * list outermost first and the working directory last, and its upward walk
 * keeps the occurrence nearest the working directory. The last occurrence is
 * kept, so each distinct file keeps its position relative to the retained
 * text. Comparing the loaded text needs no filesystem access and never drops a
 * file whose content differs by even one byte.
 */
export function deduplicateContextFiles(files: readonly ContextFile[]): ContextFileDeduplication {
	const nearestIndex = new Map<string, number>();
	files.forEach(({ content }, index) => nearestIndex.set(content, index));
	const kept: ContextFile[] = [];
	const removed: RemovedContextFile[] = [];
	files.forEach((file, index) => {
		const keptIndex = nearestIndex.get(file.content) ?? index;
		if (keptIndex === index) kept.push(file);
		else removed.push({ path: file.path, keptPath: files[keptIndex].path, bytes: Buffer.byteLength(file.content) });
	});
	return { kept, removed };
}

/**
 * Deduplicate Pi's mutable before_agent_start prompt options in place, so Pi
 * renders, records, and sends the reduced list. Returns what was removed.
 */
export function deduplicatePromptContextFiles(options: Partial<Pick<NormalizedBuildSystemPromptOptions, "contextFiles">>): RemovedContextFile[] {
	const files = options.contextFiles;
	if (!Array.isArray(files) || files.length < 2) return [];
	const { kept, removed } = deduplicateContextFiles(files);
	if (removed.length > 0) files.splice(0, files.length, ...kept);
	return removed;
}
