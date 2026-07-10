import path from "node:path";
import { fileURLToPath } from "node:url";

export interface YpiRuntime {
	extensionPath: string;
	extensionDir: string;
	root: string;
	systemPromptPath: string;
	rlmQueryPath: string;
	runtimeCorePath: string;
	runtimeInternalDir: string;
	cliAdapterPath: string;
	legacyRlmQueryPath: string;
}

export function resolveRuntime(importMetaUrl: string): YpiRuntime {
	const extensionPath = fileURLToPath(importMetaUrl);
	const extensionDir = path.dirname(extensionPath);
	const defaultRoot = path.resolve(extensionDir, "..");
	const root = path.resolve(process.env.YPI_EXTENSION_ROOT || defaultRoot);

	return {
		extensionPath,
		extensionDir,
		root,
		systemPromptPath: path.join(root, "SYSTEM_PROMPT.md"),
		rlmQueryPath: path.join(root, "rlm_query"),
		runtimeCorePath: path.join(root, "extensions", "ypi", "runtime-core.ts"),
		runtimeInternalDir: path.join(root, "extensions", "ypi", "internal"),
		cliAdapterPath: path.join(root, "extensions", "ypi", "cli.ts"),
		legacyRlmQueryPath: path.join(root, "rlm_query.legacy"),
	};
}

export function debug(message: string): void {
	if (process.env.YPI_EXTENSION_DEBUG === "1") {
		console.error(message);
	}
}
