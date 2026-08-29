import {
	chmodSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hardenActiveRootSessionFile } from "../extensions/ypi/internal/root-session.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "ypi-root-session-"));
chmodSync(scratch, 0o775);
let pass = 0;
let fail = 0;

function record(ok: boolean, label: string): void {
	if (ok) {
		pass++;
		console.log(`  PASS ${label}`);
	} else {
		fail++;
		console.error(`  FAIL ${label}`);
	}
}

function rejected(action: () => void): boolean {
	try {
		action();
		return false;
	} catch {
		return true;
	}
}

const originalDepth = process.env.RLM_DEPTH;
const originalIdentity = process.env.YPI_ROOT_SESSION_FILE_IDENTITY;
try {
	console.log("\n=== Active root transcript privacy ===");
	process.env.RLM_DEPTH = "0";
	delete process.env.YPI_ROOT_SESSION_FILE_IDENTITY;
	const active = path.join(scratch, "active.jsonl");
	const historical = path.join(scratch, "historical.jsonl");
	writeFileSync(active, "{}\n", { mode: 0o664 });
	writeFileSync(historical, "{}\n", { mode: 0o664 });
	const identity = hardenActiveRootSessionFile(active);
	record((lstatSync(active).mode & 0o777) === 0o600, "exact active transcript becomes 0600");
	record((lstatSync(historical).mode & 0o777) === 0o664, "historical transcript mode is untouched");
	record((lstatSync(scratch).mode & 0o777) === 0o775, "session directory mode is untouched");
	record(Boolean(identity && process.env.YPI_ROOT_SESSION_FILE_IDENTITY), "hardened inode identity is projected");

	const moved = path.join(scratch, "moved.jsonl");
	renameSync(active, moved);
	writeFileSync(active, "{}\n", { mode: 0o664 });
	record(rejected(() => hardenActiveRootSessionFile(active)), "same-path inode replacement fails closed");

	delete process.env.YPI_ROOT_SESSION_FILE_IDENTITY;
	const source = path.join(scratch, "source.jsonl");
	const link = path.join(scratch, "link.jsonl");
	writeFileSync(source, "{}\n", { mode: 0o600 });
	symlinkSync(source, link);
	record(rejected(() => hardenActiveRootSessionFile(link)), "symlinked active transcript is rejected");
	const hardlink = path.join(scratch, "hardlink.jsonl");
	linkSync(source, hardlink);
	record(rejected(() => hardenActiveRootSessionFile(source)), "multiply-linked active transcript is rejected");

	delete process.env.YPI_ROOT_SESSION_FILE_IDENTITY;
	const childFile = path.join(scratch, "child.jsonl");
	writeFileSync(childFile, "{}\n", { mode: 0o664 });
	process.env.RLM_DEPTH = "1";
	hardenActiveRootSessionFile(childFile);
	record((lstatSync(childFile).mode & 0o777) === 0o664, "descendants cannot harden or claim a root transcript");
} finally {
	if (originalDepth === undefined) delete process.env.RLM_DEPTH;
	else process.env.RLM_DEPTH = originalDepth;
	if (originalIdentity === undefined) delete process.env.YPI_ROOT_SESSION_FILE_IDENTITY;
	else process.env.YPI_ROOT_SESSION_FILE_IDENTITY = originalIdentity;
	rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
