import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface RootPromptLease {
	capture(prompt: string): string | undefined;
	cleanup(): void;
}

export function createRootPromptLease(): RootPromptLease {
	let directory: string | undefined;
	let promptPath: string | undefined;
	return {
		capture(prompt: string) {
			if (process.env.RLM_DEPTH !== "0") return process.env.RLM_ROOT_PROMPT_FILE;
			if (!directory) {
				directory = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "ypi_root_prompt_"));
				promptPath = path.join(directory, "prompt.txt");
			}
			writeFileSync(promptPath!, prompt, { mode: 0o600 });
			process.env.RLM_ROOT_PROMPT_FILE = promptPath!;
			return promptPath;
		},
		cleanup() {
			if (promptPath && process.env.RLM_ROOT_PROMPT_FILE === promptPath) delete process.env.RLM_ROOT_PROMPT_FILE;
			if (directory) rmSync(directory, { recursive: true, force: true });
			directory = undefined;
			promptPath = undefined;
		},
	};
}
