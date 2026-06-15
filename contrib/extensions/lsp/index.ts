/**
 * LSP Extension for Pi
 *
 * Provides code intelligence via Language Server Protocol:
 * - diagnostics: Get errors/warnings for files
 * - references: Find all references to a symbol
 * - definition: Go to definition
 * - rename: Smart rename across codebase
 * - actions: List/apply code actions and refactorings
 * - hover: Get type info and documentation
 * - symbols: List symbols in a file
 * - workspace_symbols: Search symbols across workspace
 *
 * Rust-analyzer specific (when detected):
 * - flycheck: Run clippy/check
 * - expand_macro: Expand macro at cursor
 * - ssr: Structural search-replace
 * - runnables: List tests/binaries
 * - related_tests: Find tests for a function
 * - reload_workspace: Reload Cargo.toml
 *
 * Auto-detects available language servers based on project markers
 * and installed binaries. Configurable via ~/.pi/lsp.json or .pi/lsp.json.
 *
 * Ported from oh-my-pi's @oh-my-pi/lsp plugin (MIT, can1357)
 * to Pi's native extension API (pi.registerTool).
 */

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	CodeActionKind,
	CodeActionRequest,
	createMessageConnection,
	DefinitionRequest,
	DidChangeTextDocumentNotification,
	DidOpenTextDocumentNotification,
	DidSaveTextDocumentNotification,
	DocumentSymbolRequest,
	ExecuteCommandRequest,
	HoverRequest,
	InitializedNotification,
	InitializeRequest,
	PublishDiagnosticsNotification,
	ReferencesRequest,
	RenameRequest,
	StreamMessageReader,
	StreamMessageWriter,
	WorkspaceSymbolRequest,
} from "vscode-languageserver-protocol/node";

import { getActiveServerNames, getServerForFile, isServerActive, type LSPServerConfig, loadConfig } from "./config.js";

// ============================================================================
// Types
// ============================================================================

type MessageConnection = ReturnType<typeof createMessageConnection>;

interface Diagnostic {
	range: Range;
	severity?: number;
	code?: string | number;
	source?: string;
	message: string;
}

interface Position {
	line: number;
	character: number;
}

interface Range {
	start: Position;
	end: Position;
}

interface Location {
	uri: string;
	range: Range;
}

interface TextEdit {
	range: Range;
	newText: string;
}

interface WorkspaceEdit {
	changes?: Record<string, TextEdit[]>;
	documentChanges?: Array<{
		textDocument?: { uri: string; version?: number };
		edits?: Array<TextEdit | { range: Range; newText: string }>;
		kind?: string;
		uri?: string;
		oldUri?: string;
		newUri?: string;
	}>;
}

interface CodeAction {
	title: string;
	kind?: string;
	isPreferred?: boolean;
	edit?: WorkspaceEdit;
	command?: { command: string; arguments?: unknown[] };
}

interface DocumentSymbol {
	name: string;
	kind: number;
	range: Range;
	children?: DocumentSymbol[];
}

interface SymbolInformation {
	name: string;
	kind: number;
	location: Location;
}

interface ServerCapabilities {
	renameProvider?: boolean | { prepareProvider?: boolean };
	codeActionProvider?: boolean | { resolveProvider?: boolean };
	[key: string]: unknown;
}

interface LSPClient {
	name: string;
	config: LSPServerConfig;
	process: cp.ChildProcess;
	connection: MessageConnection;
	capabilities: ServerCapabilities;
	diagnostics: Map<string, Diagnostic[]>;
	openFiles: Map<string, { version: number; languageId: string }>;
	ready: boolean;
}

interface FilePosition {
	file: string;
	line: number;
	character: number;
}

// ============================================================================
// Helpers
// ============================================================================

const LANGUAGE_MAP: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescriptreact",
	".js": "javascript",
	".jsx": "javascriptreact",
	".go": "go",
	".rs": "rust",
	".py": "python",
	".c": "c",
	".cpp": "cpp",
	".h": "c",
	".hpp": "cpp",
	".java": "java",
	".rb": "ruby",
	".lua": "lua",
	".sh": "shellscript",
	".zig": "zig",
};

const detectLanguageId = (filePath: string): string =>
	LANGUAGE_MAP[path.extname(filePath).toLowerCase()] || "plaintext";

const fileToUri = (filePath: string): string => `file://${path.resolve(filePath)}`;

const uriToFile = (uri: string): string => {
	if (!uri.startsWith("file://")) return uri;
	return decodeURIComponent(uri.slice(7));
};

const severityToString = (severity: number | undefined): string => {
	switch (severity) {
		case 1:
			return "error";
		case 2:
			return "warning";
		case 3:
			return "info";
		case 4:
			return "hint";
		default:
			return "unknown";
	}
};

const formatDiagnostic = (d: Diagnostic, filePath: string): string => {
	const severity = severityToString(d.severity);
	const line = d.range.start.line + 1;
	const col = d.range.start.character + 1;
	const source = d.source ? `[${d.source}] ` : "";
	const code = d.code ? ` (${d.code})` : "";
	return `${filePath}:${line}:${col} [${severity}] ${source}${d.message}${code}`;
};

const formatLocation = (loc: Location, cwd: string): string => {
	const file = path.relative(cwd, uriToFile(loc.uri));
	return `${file}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
};

const formatWorkspaceEdit = (edit: WorkspaceEdit, cwd: string): string[] => {
	const results: string[] = [];
	if (edit.changes) {
		for (const [uri, textEdits] of Object.entries(edit.changes)) {
			const file = path.relative(cwd, uriToFile(uri));
			for (const te of textEdits) {
				const range = `${te.range.start.line + 1}:${te.range.start.character + 1}`;
				const preview = te.newText.length > 50 ? `${te.newText.slice(0, 50)}...` : te.newText;
				results.push(`${file}:${range} → "${preview.replace(/\n/g, "\\n")}"`);
			}
		}
	}
	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("textDocument" in change && change.textDocument && "edits" in change && change.edits) {
				const file = path.relative(cwd, uriToFile(change.textDocument.uri));
				results.push(`${file}: ${change.edits.length} edit(s)`);
			} else if ("kind" in change && change.kind) {
				if (change.kind === "create" && change.uri) results.push(`CREATE: ${uriToFile(change.uri)}`);
				else if (change.kind === "rename" && change.oldUri && change.newUri)
					results.push(`RENAME: ${uriToFile(change.oldUri)} → ${uriToFile(change.newUri)}`);
				else if (change.kind === "delete" && change.uri) results.push(`DELETE: ${uriToFile(change.uri)}`);
			}
		}
	}
	return results;
};

const formatSymbol = (sym: DocumentSymbol | SymbolInformation, filePath: string, indent = 0): string[] => {
	const results: string[] = [];
	const prefix = "  ".repeat(indent);
	if ("location" in sym) {
		results.push(`${prefix}${sym.name} @ ${filePath}:${sym.location.range.start.line + 1}`);
	} else {
		results.push(`${prefix}${sym.name} @ line ${sym.range.start.line + 1}`);
		if (sym.children) {
			for (const child of sym.children) results.push(...formatSymbol(child, filePath, indent + 1));
		}
	}
	return results;
};

const findFilesWithExtension = (dir: string, ext: string, maxDepth: number): string[] => {
	const results: string[] = [];
	const search = (currentDir: string, depth: number) => {
		if (depth > maxDepth || results.length > 0) return;
		try {
			const entries = fs.readdirSync(currentDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				const fullPath = path.join(currentDir, entry.name);
				if (entry.isFile() && entry.name.endsWith(ext)) {
					results.push(fullPath);
					return;
				} else if (
					entry.isDirectory() &&
					!["node_modules", "target", "dist", "build", ".git"].includes(entry.name)
				) {
					search(fullPath, depth + 1);
				}
			}
		} catch {
			/* ignore */
		}
	};
	search(dir, 0);
	return results;
};

// ============================================================================
// Apply Edits
// ============================================================================

const applyTextEdits = (filePath: string, edits: TextEdit[]): void => {
	const content = fs.readFileSync(filePath, "utf-8");
	const lines = content.split("\n");

	const sortedEdits = [...edits].sort((a, b) => {
		if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
		return b.range.start.character - a.range.start.character;
	});

	for (const edit of sortedEdits) {
		const { start, end } = edit.range;
		if (start.line === end.line) {
			const line = lines[start.line] || "";
			lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character);
		} else {
			const startLine = lines[start.line] || "";
			const endLine = lines[end.line] || "";
			const newContent = startLine.slice(0, start.character) + edit.newText + endLine.slice(end.character);
			lines.splice(start.line, end.line - start.line + 1, ...newContent.split("\n"));
		}
	}

	fs.writeFileSync(filePath, lines.join("\n"));
};

const applyWorkspaceEdit = (edit: WorkspaceEdit): string[] => {
	const applied: string[] = [];
	if (edit.changes) {
		for (const [uri, textEdits] of Object.entries(edit.changes)) {
			const filePath = uriToFile(uri);
			applyTextEdits(filePath, textEdits);
			applied.push(`Applied ${textEdits.length} edit(s) to ${filePath}`);
		}
	}
	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("textDocument" in change && change.textDocument && "edits" in change && change.edits) {
				const filePath = uriToFile(change.textDocument.uri);
				const textEdits = change.edits.filter((e): e is TextEdit => "range" in e && "newText" in e);
				applyTextEdits(filePath, textEdits);
				applied.push(`Applied ${textEdits.length} edit(s) to ${filePath}`);
			} else if ("kind" in change && change.kind) {
				if (change.kind === "create" && change.uri) {
					const filePath = uriToFile(change.uri);
					fs.mkdirSync(path.dirname(filePath), { recursive: true });
					fs.writeFileSync(filePath, "");
					applied.push(`Created ${filePath}`);
				} else if (change.kind === "rename" && change.oldUri && change.newUri) {
					const oldPath = uriToFile(change.oldUri);
					const newPath = uriToFile(change.newUri);
					fs.mkdirSync(path.dirname(newPath), { recursive: true });
					fs.renameSync(oldPath, newPath);
					applied.push(`Renamed ${oldPath} → ${newPath}`);
				} else if (change.kind === "delete" && change.uri) {
					const filePath = uriToFile(change.uri);
					fs.rmSync(filePath, { recursive: true });
					applied.push(`Deleted ${filePath}`);
				}
			}
		}
	}
	return applied;
};

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function lspExtension(pi: ExtensionAPI) {
	// Skip registration in recursive children — LSP is expensive and children
	// do focused subtasks that don't need code intelligence.
	const depth = parseInt(process.env.RLM_DEPTH || "0", 10);
	if (depth > 0) return;
	let cwd = process.cwd();
	let config = loadConfig(cwd);
	let activeServers = getActiveServerNames(config);
	const clients = new Map<string, LSPClient>();

	// Re-detect on session start (cwd may change)
	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		config = loadConfig(cwd);
		activeServers = getActiveServerNames(config);
	});

	// Clean up LSP servers on shutdown
	pi.on("session_shutdown", async () => {
		for (const client of clients.values()) {
			try {
				client.connection.sendNotification("exit");
				client.connection.dispose();
				client.process.kill();
			} catch {
				/* ignore */
			}
		}
		clients.clear();
	});

	// =========================================================================
	// Client Management
	// =========================================================================

	const startClient = async (name: string, serverConfig: LSPServerConfig): Promise<LSPClient | null> => {
		const proc = cp.spawn(serverConfig.command, serverConfig.args || [], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		if (!proc.stdin || !proc.stdout) {
			proc.kill();
			return null;
		}

		proc.on("exit", () => clients.delete(name));

		const connection = createMessageConnection(
			new StreamMessageReader(proc.stdout),
			new StreamMessageWriter(proc.stdin),
		);

		const client: LSPClient = {
			name,
			config: serverConfig,
			process: proc,
			connection,
			capabilities: {},
			diagnostics: new Map(),
			openFiles: new Map(),
			ready: false,
		};

		connection.onNotification(
			PublishDiagnosticsNotification.type,
			(params: { uri: string; diagnostics: Diagnostic[] }) => {
				client.diagnostics.set(params.uri, params.diagnostics);
			},
		);

		connection.onNotification(() => {});
		connection.listen();

		try {
			const result = await connection.sendRequest(InitializeRequest.type, {
				processId: process.pid,
				rootUri: fileToUri(cwd),
				rootPath: cwd,
				capabilities: {
					textDocument: {
						synchronization: { didSave: true },
						hover: { contentFormat: ["markdown", "plaintext"] },
						definition: {},
						references: {},
						rename: { prepareSupport: true },
						codeAction: {
							codeActionLiteralSupport: {
								codeActionKind: {
									valueSet: [CodeActionKind.QuickFix, CodeActionKind.Refactor, CodeActionKind.Source],
								},
							},
							resolveSupport: { properties: ["edit"] },
						},
						publishDiagnostics: { relatedInformation: true },
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
					},
					workspace: {
						applyEdit: true,
						workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] },
						configuration: true,
					},
				},
				initializationOptions: serverConfig.initOptions || {},
				workspaceFolders: [{ uri: fileToUri(cwd), name: path.basename(cwd) }],
			});

			client.capabilities = result.capabilities;
			connection.sendNotification(InitializedNotification.type, {});
			client.ready = true;

			connection.onRequest("workspace/configuration", (params: { items: Array<{ section?: string }> }) => {
				return params.items.map((item) => serverConfig.settings?.[item.section || ""] || {});
			});

			connection.onRequest("workspace/applyEdit", async (params: { edit: WorkspaceEdit }) => {
				try {
					applyWorkspaceEdit(params.edit);
					return { applied: true };
				} catch (e) {
					return { applied: false, failureReason: String(e) };
				}
			});

			return client;
		} catch (e) {
			proc.kill();
			throw new Error(`Failed to initialize ${name}: ${e}`);
		}
	};

	const getClientForFile = async (filePath: string): Promise<LSPClient> => {
		const serverInfo = getServerForFile(config, filePath);
		if (!serverInfo) throw new Error(`No LSP server for ${path.extname(filePath)} files`);

		const [name, serverConfig] = serverInfo;
		if (!clients.has(name)) {
			const client = await startClient(name, serverConfig);
			if (!client) throw new Error(`Failed to start ${name}`);
			clients.set(name, client);
		}
		return clients.get(name)!;
	};

	const ensureFileOpen = async (client: LSPClient, filePath: string): Promise<void> => {
		const uri = fileToUri(filePath);
		if (client.openFiles.has(uri)) return;

		const content = fs.readFileSync(filePath, "utf-8");
		client.connection.sendNotification(DidOpenTextDocumentNotification.type, {
			textDocument: { uri, languageId: detectLanguageId(filePath), version: 1, text: content },
		});
		client.openFiles.set(uri, { version: 1, languageId: detectLanguageId(filePath) });
	};

	const refreshFile = async (client: LSPClient, filePath: string): Promise<void> => {
		const uri = fileToUri(filePath);
		const info = client.openFiles.get(uri);
		if (!info) {
			await ensureFileOpen(client, filePath);
			return;
		}
		const content = fs.readFileSync(filePath, "utf-8");
		info.version++;
		client.connection.sendNotification(DidChangeTextDocumentNotification.type, {
			textDocument: { uri, version: info.version },
			contentChanges: [{ text: content }],
		});
		client.connection.sendNotification(DidSaveTextDocumentNotification.type, {
			textDocument: { uri },
			text: content,
		});
	};

	const waitForDiagnostics = (client: LSPClient, uri: string, timeout = 3000): Promise<Diagnostic[]> => {
		return new Promise((resolve) => {
			const startTime = Date.now();
			const check = () => {
				const diags = client.diagnostics.get(uri);
				if (diags !== undefined || Date.now() - startTime > timeout) {
					resolve(diags || []);
				} else {
					setTimeout(check, 100);
				}
			};
			setTimeout(check, 200);
		});
	};

	const hasRust = () => isServerActive(config, "rust");

	const getRustClient = async (): Promise<LSPClient> => {
		if (!hasRust()) throw new Error("rust-analyzer not available");
		let client = clients.get("rust");
		if (!client) {
			const rsFiles = findFilesWithExtension(cwd, ".rs", 5);
			if (rsFiles.length === 0) throw new Error("No .rs files found");
			client = await getClientForFile(rsFiles[0]);
			await ensureFileOpen(client, rsFiles[0]);
		}
		return client;
	};

	// =========================================================================
	// Action Handlers
	// =========================================================================

	const handleDiagnostics = async (files: string[]): Promise<string> => {
		const results: string[] = [];
		for (const file of files) {
			const absPath = path.resolve(cwd, file);
			try {
				const client = await getClientForFile(absPath);
				await ensureFileOpen(client, absPath);
				await refreshFile(client, absPath);
				const diags = await waitForDiagnostics(client, fileToUri(absPath));
				const relPath = path.relative(cwd, absPath);
				if (diags.length === 0) {
					results.push(`✓ ${relPath}: no issues`);
				} else {
					const errors = diags.filter((d) => d.severity === 1).length;
					const warnings = diags.filter((d) => d.severity === 2).length;
					results.push(`✗ ${relPath}: ${errors} error(s), ${warnings} warning(s)`);
					for (const d of diags) results.push(`  ${formatDiagnostic(d, relPath)}`);
				}
			} catch (e) {
				results.push(`✗ ${file}: ${e}`);
			}
		}
		return results.join("\n");
	};

	const handleReferences = async (pos: FilePosition, includeDeclaration: boolean): Promise<string> => {
		const absPath = path.resolve(cwd, pos.file);
		const client = await getClientForFile(absPath);
		await ensureFileOpen(client, absPath);
		const locations = await client.connection.sendRequest(ReferencesRequest.type, {
			textDocument: { uri: fileToUri(absPath) },
			position: { line: pos.line - 1, character: pos.character - 1 },
			context: { includeDeclaration },
		});
		if (!locations?.length) return "No references found.";
		const results = [`Found ${locations.length} reference(s):`];
		for (const loc of locations) results.push(`  ${formatLocation(loc, cwd)}`);
		return results.join("\n");
	};

	const handleDefinition = async (pos: FilePosition): Promise<string> => {
		const absPath = path.resolve(cwd, pos.file);
		const client = await getClientForFile(absPath);
		await ensureFileOpen(client, absPath);
		const result = await client.connection.sendRequest(DefinitionRequest.type, {
			textDocument: { uri: fileToUri(absPath) },
			position: { line: pos.line - 1, character: pos.character - 1 },
		});
		if (!result) return "No definition found.";
		const locations = Array.isArray(result) ? result : [result];
		if (locations.length === 0) return "No definition found.";
		const results = [`Found ${locations.length} definition(s):`];
		for (const loc of locations) {
			if ("uri" in loc) results.push(`  ${formatLocation(loc as Location, cwd)}`);
			else if ("targetUri" in loc)
				results.push(`  ${formatLocation({ uri: loc.targetUri, range: loc.targetRange }, cwd)}`);
		}
		return results.join("\n");
	};

	const handleRename = async (pos: FilePosition, newName: string, apply: boolean): Promise<string> => {
		const absPath = path.resolve(cwd, pos.file);
		const client = await getClientForFile(absPath);
		await ensureFileOpen(client, absPath);
		const edit = await client.connection.sendRequest(RenameRequest.type, {
			textDocument: { uri: fileToUri(absPath) },
			position: { line: pos.line - 1, character: pos.character - 1 },
			newName,
		});
		if (!edit) return "Rename returned no edits.";
		const changes = formatWorkspaceEdit(edit, cwd);
		if (changes.length === 0) return "Rename returned no changes.";
		if (apply) {
			const applied = applyWorkspaceEdit(edit);
			return `Rename applied:\n${applied.join("\n")}`;
		}
		return `Rename preview (use apply=true to apply):\n${changes.map((c) => `  ${c}`).join("\n")}`;
	};

	const handleCodeActions = async (
		pos: FilePosition,
		endLine?: number,
		endChar?: number,
		kind?: string,
		apply?: number,
	): Promise<string> => {
		const absPath = path.resolve(cwd, pos.file);
		const client = await getClientForFile(absPath);
		await ensureFileOpen(client, absPath);
		await refreshFile(client, absPath);

		const uri = fileToUri(absPath);
		const range: Range = {
			start: { line: pos.line - 1, character: pos.character - 1 },
			end: { line: (endLine || pos.line) - 1, character: (endChar || pos.character) - 1 },
		};

		const allDiags = client.diagnostics.get(uri) || [];
		const relevantDiags = allDiags.filter(
			(d) => d.range.start.line <= range.end.line && d.range.end.line >= range.start.line,
		);

		const actions = await client.connection.sendRequest(CodeActionRequest.type, {
			textDocument: { uri },
			range,
			context: { diagnostics: relevantDiags, only: kind ? [kind] : undefined },
		});

		if (!actions?.length) return "No code actions available.";
		const codeActions = actions.filter((a): a is CodeAction => "title" in a);

		if (apply !== undefined) {
			if (apply < 0 || apply >= codeActions.length)
				return `Invalid index ${apply}. Available: 0-${codeActions.length - 1}`;

			let action = codeActions[apply];
			if (
				!action.edit &&
				client.capabilities.codeActionProvider &&
				typeof client.capabilities.codeActionProvider === "object" &&
				client.capabilities.codeActionProvider.resolveProvider
			) {
				action = await client.connection.sendRequest("codeAction/resolve", action);
			}

			if (action.edit) {
				const applied = applyWorkspaceEdit(action.edit);
				return `Applied "${action.title}":\n${applied.join("\n")}`;
			} else if (action.command) {
				await client.connection.sendRequest(ExecuteCommandRequest.type, {
					command: action.command.command,
					arguments: action.command.arguments,
				});
				return `Executed "${action.title}"`;
			}
			return `Action "${action.title}" has no edit or command.`;
		}

		const results = [`Available code actions (${codeActions.length}):`];
		codeActions.forEach((a, i) => {
			const k = a.kind ? ` [${a.kind}]` : "";
			const pref = a.isPreferred ? " ★" : "";
			results.push(`  [${i}] ${a.title}${k}${pref}`);
		});
		results.push("\nUse apply=<index> to apply.");
		return results.join("\n");
	};

	const handleHover = async (pos: FilePosition): Promise<string> => {
		const absPath = path.resolve(cwd, pos.file);
		const client = await getClientForFile(absPath);
		await ensureFileOpen(client, absPath);
		const hover = await client.connection.sendRequest(HoverRequest.type, {
			textDocument: { uri: fileToUri(absPath) },
			position: { line: pos.line - 1, character: pos.character - 1 },
		});
		if (!hover?.contents) return "No hover information.";
		if (typeof hover.contents === "string") return hover.contents;
		if ("value" in hover.contents) return hover.contents.value;
		if (Array.isArray(hover.contents))
			return hover.contents
				.map((c: string | { value: string }) => (typeof c === "string" ? c : c.value))
				.join("\n\n");
		return String(hover.contents);
	};

	const handleSymbols = async (file: string): Promise<string> => {
		const absPath = path.resolve(cwd, file);
		const client = await getClientForFile(absPath);
		await ensureFileOpen(client, absPath);
		const symbols = await client.connection.sendRequest(DocumentSymbolRequest.type, {
			textDocument: { uri: fileToUri(absPath) },
		});
		if (!symbols?.length) return "No symbols found.";
		const relPath = path.relative(cwd, absPath);
		const results = [`Symbols in ${relPath}:`];
		for (const sym of symbols) results.push(...formatSymbol(sym, relPath));
		return results.join("\n");
	};

	const handleWorkspaceSymbols = async (query: string, file?: string): Promise<string> => {
		let client = clients.values().next().value;
		if (!client && file) client = await getClientForFile(path.resolve(cwd, file));
		if (!client) {
			for (const [_name, serverConfig] of Object.entries(config.servers)) {
				const files = findFilesWithExtension(cwd, serverConfig.fileTypes[0], 5);
				if (files.length > 0) {
					client = await getClientForFile(files[0]);
					break;
				}
			}
		}
		if (!client) return "No LSP server running.";
		const symbols = await client.connection.sendRequest(WorkspaceSymbolRequest.type, { query });
		if (!symbols?.length) return `No symbols matching "${query}".`;
		const results = [`Symbols matching "${query}" (${symbols.length}):`];
		for (const sym of symbols as SymbolInformation[]) {
			if ("location" in sym) {
				const file = path.relative(cwd, uriToFile(sym.location.uri));
				results.push(`  ${sym.name} @ ${file}:${sym.location.range.start.line + 1}`);
			}
		}
		return results.join("\n");
	};

	// Rust-specific handlers
	const handleFlycheck = async (file?: string): Promise<string> => {
		const client = await getRustClient();
		const textDocument = file ? { uri: fileToUri(path.resolve(cwd, file)) } : null;
		await client.connection.sendNotification("rust-analyzer/runFlycheck", { textDocument });
		await new Promise((r) => setTimeout(r, 2000));
		const allDiags: string[] = [];
		for (const [uri, diags] of client.diagnostics) {
			const relPath = path.relative(cwd, uriToFile(uri));
			for (const d of diags) allDiags.push(formatDiagnostic(d, relPath));
		}
		return allDiags.length === 0
			? "✓ No issues found."
			: `Found ${allDiags.length} issue(s):\n${allDiags.join("\n")}`;
	};

	const handleExpandMacro = async (pos: FilePosition): Promise<string> => {
		const absPath = path.resolve(cwd, pos.file);
		const client = await getClientForFile(absPath);
		await ensureFileOpen(client, absPath);
		const result = (await client.connection.sendRequest("rust-analyzer/expandMacro", {
			textDocument: { uri: fileToUri(absPath) },
			position: { line: pos.line - 1, character: pos.character - 1 },
		})) as { name: string; expansion: string } | null;
		if (!result?.expansion) return "No macro at this position.";
		return `Macro: ${result.name}\n\n${result.expansion}`;
	};

	const handleSSR = async (pattern: string, replacement: string, apply: boolean): Promise<string> => {
		const client = await getRustClient();
		const rsFiles = findFilesWithExtension(cwd, ".rs", 5);
		const result: WorkspaceEdit = await client.connection.sendRequest("experimental/ssr", {
			query: `${pattern} ==>> ${replacement}`,
			parseOnly: !apply,
			textDocument: { uri: fileToUri(rsFiles[0]) },
			position: { line: 0, character: 0 },
			selections: [],
		});
		const changes = formatWorkspaceEdit(result, cwd);
		if (changes.length === 0) return "SSR matched nothing.";
		if (apply) {
			const applied = applyWorkspaceEdit(result);
			return `SSR applied:\n${applied.join("\n")}`;
		}
		return `SSR preview:\n${changes.map((c) => `  ${c}`).join("\n")}`;
	};

	const handleRunnables = async (file?: string, line?: number): Promise<string> => {
		const client = await getRustClient();
		let targetFile = file;
		if (!targetFile) {
			const rsFiles = findFilesWithExtension(cwd, ".rs", 5);
			if (rsFiles.length > 0) targetFile = path.relative(cwd, rsFiles[0]);
			else return "No .rs files found.";
		}
		const params: { textDocument: { uri: string }; position?: Position } = {
			textDocument: { uri: fileToUri(path.resolve(cwd, targetFile)) },
		};
		if (line !== undefined) params.position = { line: line - 1, character: 0 };
		const runnables = (await client.connection.sendRequest("experimental/runnables", params)) as Array<{
			label: string;
			kind: string;
			args?: { cargoArgs: string[] };
			location?: { targetUri: string };
		}>;
		if (!runnables?.length) return "No runnables found.";
		const results = [`Found ${runnables.length} runnable(s):`];
		for (const r of runnables) {
			const loc = r.location ? ` @ ${path.relative(cwd, uriToFile(r.location.targetUri))}` : "";
			const cmd = r.kind === "cargo" && r.args ? ` → cargo ${r.args.cargoArgs.join(" ")}` : "";
			results.push(`  ${r.label}${loc}${cmd}`);
		}
		return results.join("\n");
	};

	const handleRelatedTests = async (pos: FilePosition): Promise<string> => {
		const absPath = path.resolve(cwd, pos.file);
		const client = await getClientForFile(absPath);
		await ensureFileOpen(client, absPath);
		const tests = (await client.connection.sendRequest("rust-analyzer/relatedTests", {
			textDocument: { uri: fileToUri(absPath) },
			position: { line: pos.line - 1, character: pos.character - 1 },
		})) as Array<{ runnable?: { label: string } }>;
		if (!tests?.length) return "No related tests.";
		const results = [`Found ${tests.length} related test(s):`];
		for (const t of tests) if (t.runnable) results.push(`  ${t.runnable.label}`);
		return results.join("\n");
	};

	const handleReloadWorkspace = async (): Promise<string> => {
		const client = await getRustClient();
		await client.connection.sendRequest("rust-analyzer/reloadWorkspace", null);
		return "Workspace reloaded.";
	};

	// =========================================================================
	// Build dynamic action list and description
	// =========================================================================

	const baseActions = [
		"diagnostics",
		"references",
		"definition",
		"rename",
		"actions",
		"hover",
		"symbols",
		"workspace_symbols",
		"status",
	] as const;

	// Note: rust-specific actions are always included in the schema but return
	// helpful errors if rust-analyzer isn't available. This avoids needing to
	// regenerate the tool schema at runtime.
	const allActions = [
		...baseActions,
		"flycheck",
		"expand_macro",
		"ssr",
		"runnables",
		"related_tests",
		"reload_workspace",
	] as const;

	type ActionType = (typeof allActions)[number];

	let description = "Language Server Protocol tool for code intelligence.\n\n";
	description +=
		"Standard actions: diagnostics, references, definition, rename, actions, hover, symbols, workspace_symbols, status\n";
	description += "Rust-analyzer actions: flycheck, expand_macro, ssr, runnables, related_tests, reload_workspace\n\n";
	description += "Auto-detects language servers from project markers and installed binaries.\n";
	description += "Configure via ~/.pi/lsp.json or .pi/lsp.json.";

	// =========================================================================
	// Register the tool
	// =========================================================================

	pi.registerTool({
		name: "lsp",
		label: "LSP",
		description,

		parameters: Type.Object({
			action: Type.Union(
				allActions.map((a) => Type.Literal(a)),
				{ description: "LSP action to perform" },
			),
			files: Type.Optional(Type.Array(Type.String({ description: "File paths for diagnostics" }))),
			file: Type.Optional(Type.String({ description: "File path" })),
			line: Type.Optional(Type.Number({ description: "Line (1-based)" })),
			character: Type.Optional(Type.Number({ description: "Column (1-based, defaults to 1)" })),
			end_line: Type.Optional(Type.Number({ description: "End line for range" })),
			end_character: Type.Optional(Type.Number({ description: "End column for range" })),
			new_name: Type.Optional(Type.String({ description: "New name for rename" })),
			apply: Type.Optional(
				Type.Union([Type.Boolean(), Type.Number()], { description: "Apply action (true or index)" }),
			),
			kind: Type.Optional(Type.String({ description: "Code action kind filter" })),
			query: Type.Optional(Type.String({ description: "Search query for workspace_symbols" })),
			pattern: Type.Optional(Type.String({ description: "SSR pattern (Rust)" })),
			replacement: Type.Optional(Type.String({ description: "SSR replacement (Rust)" })),
			include_declaration: Type.Optional(
				Type.Boolean({ description: "Include declaration in references (default: true)" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const p = params as {
				action: ActionType;
				files?: string[];
				file?: string;
				line?: number;
				character?: number;
				end_line?: number;
				end_character?: number;
				new_name?: string;
				apply?: boolean | number;
				kind?: string;
				query?: string;
				pattern?: string;
				replacement?: string;
				include_declaration?: boolean;
			};

			try {
				let result: string;

				switch (p.action) {
					case "status":
						result = `Active LSP servers: ${activeServers.join(", ") || "none"}\nRunning clients: ${[...clients.keys()].join(", ") || "none"}`;
						break;

					case "diagnostics":
						if (!p.files?.length)
							return {
								content: [{ type: "text" as const, text: "Error: 'files' parameter required" }],
								details: undefined,
							};
						result = await handleDiagnostics(p.files);
						break;

					case "references":
						if (!p.file || !p.line)
							return {
								content: [{ type: "text" as const, text: "Error: file and line required" }],
								details: undefined,
							};
						result = await handleReferences(
							{ file: p.file, line: p.line, character: p.character || 1 },
							p.include_declaration ?? true,
						);
						break;

					case "definition":
						if (!p.file || !p.line)
							return {
								content: [{ type: "text" as const, text: "Error: file and line required" }],
								details: undefined,
							};
						result = await handleDefinition({
							file: p.file,
							line: p.line,
							character: p.character || 1,
						});
						break;

					case "rename":
						if (!p.file || !p.line || !p.new_name)
							return {
								content: [{ type: "text" as const, text: "Error: file, line, and new_name required" }],
							};
						result = await handleRename(
							{ file: p.file, line: p.line, character: p.character || 1 },
							p.new_name,
							p.apply === true,
						);
						break;

					case "actions":
						if (!p.file || !p.line)
							return {
								content: [{ type: "text" as const, text: "Error: file and line required" }],
								details: undefined,
							};
						result = await handleCodeActions(
							{ file: p.file, line: p.line, character: p.character || 1 },
							p.end_line,
							p.end_character,
							p.kind,
							typeof p.apply === "number" ? p.apply : undefined,
						);
						break;

					case "hover":
						if (!p.file || !p.line)
							return {
								content: [{ type: "text" as const, text: "Error: file and line required" }],
								details: undefined,
							};
						result = await handleHover({
							file: p.file,
							line: p.line,
							character: p.character || 1,
						});
						break;

					case "symbols":
						if (!p.file)
							return { content: [{ type: "text" as const, text: "Error: file required" }], details: undefined };
						result = await handleSymbols(p.file);
						break;

					case "workspace_symbols":
						if (!p.query)
							return { content: [{ type: "text" as const, text: "Error: query required" }], details: undefined };
						result = await handleWorkspaceSymbols(p.query, p.file);
						break;

					case "flycheck":
						result = await handleFlycheck(p.file);
						break;

					case "expand_macro":
						if (!p.file || !p.line)
							return {
								content: [{ type: "text" as const, text: "Error: file and line required" }],
								details: undefined,
							};
						result = await handleExpandMacro({
							file: p.file,
							line: p.line,
							character: p.character || 1,
						});
						break;

					case "ssr":
						if (!p.pattern || !p.replacement)
							return {
								content: [{ type: "text" as const, text: "Error: pattern and replacement required" }],
							};
						result = await handleSSR(p.pattern, p.replacement, p.apply === true);
						break;

					case "runnables":
						result = await handleRunnables(p.file, p.line);
						break;

					case "related_tests":
						if (!p.file || !p.line)
							return {
								content: [{ type: "text" as const, text: "Error: file and line required" }],
								details: undefined,
							};
						result = await handleRelatedTests({
							file: p.file,
							line: p.line,
							character: p.character || 1,
						});
						break;

					case "reload_workspace":
						result = await handleReloadWorkspace();
						break;

					default:
						result = `Unknown action: ${p.action}`;
				}

				return { content: [{ type: "text" as const, text: result }], details: undefined };
			} catch (e) {
				return {
					content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }],
					details: undefined,
				};
			}
		},
	});
}
