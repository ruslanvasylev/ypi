export interface ActiveTaskFiles {
	contextPath?: string;
	promptPath?: string;
	rootPromptPath?: string;
}

function markdownPath(filePath: string): string {
	return filePath.replaceAll("`", "\\`").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
}

export function renderActiveTaskFilesSection(files: ActiveTaskFiles): string {
	if (!files.contextPath && !files.promptPath && !files.rootPromptPath) return "";
	const rows = [
		files.contextPath ? `- External task context: \`${markdownPath(files.contextPath)}\`` : "",
		files.promptPath ? `- Current delegated charter: \`${markdownPath(files.promptPath)}\`` : "",
		files.rootPromptPath ? `- Root delegation charter: \`${markdownPath(files.rootPromptPath)}\`` : "",
	].filter(Boolean).join("\n");
	return `\n\n## Active Recursive Task Files\n\n${rows}\n\nThe external task context is the primary evidence surface for a context-grounded\nquestion. Inspect it before using persistent memory, browser, provider, or other\nretrieval tools. Do not call Honcho or unrelated retrieval when the requested\nanswer is present in this task file. Use persistent memory only when the prompt\nasks for it or the task context is absent or explicitly insufficient.\n`;
}
