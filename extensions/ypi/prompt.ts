import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { shellHelperEnabled } from "./env.ts";
import type { YpiRuntime } from "./runtime.ts";
import { debug } from "./runtime.ts";

const MINIMAL_SYSTEM_PROMPT = `# ypi Minimal Recursive Mode

You are Pi with a native \`rlm_query\` tool.

- Use the native \`rlm_query\` tool to delegate clear, bounded subtasks to child Pi agents.
- For independent subtasks, issue multiple native \`rlm_query\` tool calls in the same assistant turn so Pi can run them in parallel.
- Each child receives a fresh context window and can call \`rlm_query\` again until \`RLM_MAX_DEPTH\`.
- \`jj\` workspace isolation is required by default. Set \`RLM_JJ=0\` explicitly for read-only no-jj children or use the explicitly unsafe current-checkout write override.
- The shell command named \`rlm_query\` is optional compatibility glue. Do not require it for minimal recursion.
`;

function runtimeImplementationSection(runtime: YpiRuntime): string {
	if (!shellHelperEnabled(runtime)) {
		debug("__YPI_EXTENSION_NO_SHELL_HELPER__");
		return "";
	}

	const rlmQuery = readFileSync(runtime.rlmQueryPath, "utf8");
	const runtimeCore = readFileSync(runtime.runtimeCorePath, "utf8");
	const internalRuntime = readdirSync(runtime.runtimeInternalDir)
		.filter((name) => name.endsWith(".ts"))
		.sort()
		.map((name) => `// ${name}\n${readFileSync(`${runtime.runtimeInternalDir}/${name}`, "utf8")}`)
		.join("\n\n");
	const cliAdapter = readFileSync(runtime.cliAdapterPath, "utf8");
	return `

## SECTION 6 - Canonical rlm_query Runtime Implementation

The shell command is a thin launcher. Child planning, guardrails, resources,
process execution, result handling, and cleanup belong to the shared TypeScript
runtime below. The CLI adapter adds stdin, async jobs, and notification; the Pi
adapter calls the same runtime directly.

### Launcher

\`\`\`bash
${rlmQuery}
\`\`\`

### Canonical runtime core

\`\`\`typescript
${runtimeCore}
\`\`\`

### Internal runtime owners

\`\`\`typescript
${internalRuntime}
\`\`\`

### CLI adapter

\`\`\`typescript
${cliAdapter}
\`\`\`
`;
}

function markdownPath(filePath: string): string {
	return filePath.replaceAll("`", "\\`").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
}

function activeTaskFilesSection(): string {
	const contextPath = process.env.CONTEXT;
	const promptPath = process.env.RLM_PROMPT_FILE;
	const rootPromptPath = process.env.RLM_ROOT_PROMPT_FILE;
	if (!contextPath && !promptPath && !rootPromptPath) return "";
	const rows = [
		contextPath ? `- External task context: \`${markdownPath(contextPath)}\`` : "",
		promptPath ? `- Current delegated charter: \`${markdownPath(promptPath)}\`` : "",
		rootPromptPath ? `- Root delegation charter: \`${markdownPath(rootPromptPath)}\`` : "",
	].filter(Boolean).join("\n");
	return `\n\n## Active Recursive Task Files\n\n${rows}\n\nThe external task context is the primary evidence surface for a context-grounded\nquestion. Inspect it before using persistent memory, browser, provider, or other\nretrieval tools. Do not call Honcho or unrelated retrieval when the requested\nanswer is present in this task file. Use persistent memory only when the prompt\nasks for it or the task context is absent or explicitly insufficient.\n`;
}

export function buildYpiPrompt(runtime: YpiRuntime): string {
	let systemPrompt: string;
	if (existsSync(runtime.systemPromptPath)) {
		systemPrompt = readFileSync(runtime.systemPromptPath, "utf8");
	} else {
		debug("__YPI_EXTENSION_MINIMAL_PROMPT__");
		systemPrompt = MINIMAL_SYSTEM_PROMPT;
	}

	return `${systemPrompt}${activeTaskFilesSection()}${runtimeImplementationSection(runtime)}`;
}

export function patchSystemPrompt(runtime: YpiRuntime, event: BeforeAgentStartEvent): string {
	const ypiPrompt = buildYpiPrompt(runtime);
	const mode = process.env.YPI_EXTENSION_PROMPT_MODE || "append";

	if (mode === "replace") {
		return ypiPrompt;
	}

	return `${event.systemPrompt}

${ypiPrompt}`;
}
