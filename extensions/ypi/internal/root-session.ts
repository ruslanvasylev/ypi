import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	openSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import {
	canonicalPrivateFilePath,
	parsePrivateFileIdentity,
	PRIVATE_FILE_MODE,
	type PrivatePathIdentity,
} from "./private-path.ts";

interface ActiveRootBinding {
	path: string;
	identity: PrivatePathIdentity;
}

let activeRootBinding: ActiveRootBinding | undefined;

function controlError(message: string): Error {
	return new Error(message);
}

function assertOwner(metadata: BigIntStats, candidate: string): void {
	const uid = process.getuid?.();
	if (uid !== undefined && metadata.uid !== BigInt(uid)) {
		throw controlError(`Root session path is owned by another user: ${candidate}`);
	}
}

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function identityOf(metadata: BigIntStats): PrivatePathIdentity {
	return {
		device: metadata.dev.toString(),
		inode: metadata.ino.toString(),
		kind: "file",
		mode: process.platform === "win32"
			? PRIVATE_FILE_MODE
			: Number(metadata.mode & 0o777n),
		links: metadata.nlink.toString(),
	};
}

/** Resolve benign ancestor aliases without ever following the final component. */
export function canonicalRootSessionFilePath(candidate: string): string {
	try {
		return canonicalPrivateFilePath(candidate);
	} catch (error) {
		if (error instanceof Error && error.message === "Private file path must be absolute and normalized") {
			throw controlError("Root session path must be absolute and normalized");
		}
		throw error;
	}
}

/**
 * Harden only Pi's exact current root transcript. Historical files, directory
 * modes, and the process umask are intentionally untouched.
 */
export function hardenActiveRootSessionFile(candidate: string | undefined): PrivatePathIdentity | undefined {
	if ((process.env.RLM_DEPTH || "0") !== "0") {
		delete process.env.YPI_ROOT_SESSION_FILE_IDENTITY;
		return undefined;
	}
	if (!candidate) {
		delete process.env.YPI_ROOT_SESSION_FILE_IDENTITY;
		activeRootBinding = undefined;
		return undefined;
	}
	const canonical = canonicalRootSessionFilePath(candidate);
	if (activeRootBinding?.path !== canonical) activeRootBinding = undefined;
	const canonicalParent = path.dirname(canonical);
	const parentMetadata = lstatSync(canonicalParent, { bigint: true });
	if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
		throw controlError(`Root session parent is not a regular directory: ${canonicalParent}`);
	}
	assertOwner(parentMetadata, canonicalParent);

	let namedBefore: BigIntStats;
	try {
		namedBefore = lstatSync(canonical, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			delete process.env.YPI_ROOT_SESSION_FILE_IDENTITY;
			return undefined;
		}
		throw error;
	}
	if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) {
		throw controlError(`Root session path is not a regular file: ${canonical}`);
	}
	assertOwner(namedBefore, canonical);
	if (namedBefore.nlink !== 1n) {
		throw controlError(`Root session file must be singly linked: ${canonical}`);
	}
	const previous = activeRootBinding?.identity
		?? (process.env.YPI_ROOT_SESSION_FILE_IDENTITY
			? parsePrivateFileIdentity(process.env.YPI_ROOT_SESSION_FILE_IDENTITY)
			: undefined);
	if (previous) {
		if (
			previous.device !== namedBefore.dev.toString()
			|| previous.inode !== namedBefore.ino.toString()
		) {
			throw controlError(`Root session file identity changed: ${canonical}`);
		}
	}

	const descriptor = openSync(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
	try {
		const opened = fstatSync(descriptor, { bigint: true });
		if (!opened.isFile() || !sameInode(namedBefore, opened)) {
			throw controlError(`Root session identity changed before hardening: ${canonical}`);
		}
		assertOwner(opened, canonical);
		if (opened.nlink !== 1n) {
			throw controlError(`Root session file must be singly linked: ${canonical}`);
		}
		if (process.platform !== "win32") fchmodSync(descriptor, PRIVATE_FILE_MODE);
		const hardened = fstatSync(descriptor, { bigint: true });
		const namedAfter = lstatSync(canonical, { bigint: true });
		const parentAfter = lstatSync(canonicalParent, { bigint: true });
		if (
			!sameInode(opened, hardened)
			|| !sameInode(opened, namedAfter)
			|| namedAfter.isSymbolicLink()
			|| !sameInode(parentMetadata, parentAfter)
			|| hardened.nlink !== 1n
			|| (process.platform !== "win32" && Number(hardened.mode & 0o777n) !== PRIVATE_FILE_MODE)
		) {
			throw controlError(`Root session identity changed during hardening: ${canonical}`);
		}
		const identity = identityOf(hardened);
		activeRootBinding = { path: canonical, identity };
		process.env.YPI_ROOT_SESSION_FILE_IDENTITY = JSON.stringify(identity);
		return identity;
	} finally {
		closeSync(descriptor);
	}
}
