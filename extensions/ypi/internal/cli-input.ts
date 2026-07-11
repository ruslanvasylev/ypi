import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface ContextSource {
	context?: string;
	contextPath?: string;
	cleanup?: () => void;
}

async function spoolStdin(): Promise<{ path: string; bytes: number; cleanup(): void }> {
	const directory = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "ypi_cli_stdin_"));
	const contextPath = path.join(directory, "context.bin");
	const descriptor = openSync(contextPath, "wx", 0o600);
	let bytes = 0;
	try {
		for await (const chunk of process.stdin) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			let offset = 0;
			while (offset < buffer.byteLength) offset += writeSync(descriptor, buffer, offset);
			bytes += buffer.byteLength;
		}
	} catch (error) {
		closeSync(descriptor);
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
	closeSync(descriptor);
	return { path: contextPath, bytes, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

export async function resolveContextSource(): Promise<ContextSource> {
	const explicitStdin = Boolean(process.env.RLM_STDIN);
	const shouldReadStdin = explicitStdin || !process.stdin.isTTY;
	if (shouldReadStdin) {
		const spooled = await spoolStdin();
		if (spooled.bytes > 0 || explicitStdin) return { contextPath: spooled.path, cleanup: spooled.cleanup };
		spooled.cleanup();
	}
	if (process.env.CONTEXT && existsSync(process.env.CONTEXT)) {
		return { contextPath: process.env.CONTEXT };
	}
	return {};
}
