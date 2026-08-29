import {
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fstatSync,
	lstatSync,
	openSync,
	realpathSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import {
	parsePrivateFileIdentity,
	PRIVATE_FILE_MODE,
	type PrivatePathIdentity,
} from "./private-path.ts";

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

/**
 * Harden only Pi's exact current root transcript. Historical files, directory
 * modes, and the process umask are intentionally untouched.
 */
export function hardenActiveRootSessionFile(candidate: string | undefined): PrivatePathIdentity | undefined {
	if ((process.env.RLM_DEPTH || "0") !== "0") {
		delete process.env.YPI_ROOT_SESSION_FILE_IDENTITY;
		return undefined;
	}
	if (!candidate || !existsSync(candidate)) {
		delete process.env.YPI_ROOT_SESSION_FILE_IDENTITY;
		return undefined;
	}
	if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) {
		throw controlError("Root session path must be absolute and normalized");
	}
	if (realpathSync.native(candidate) !== candidate) {
		throw controlError("Root session path must not contain symlinks");
	}
	const parent = path.dirname(candidate);
	const parentMetadata = lstatSync(parent, { bigint: true });
	if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
		throw controlError(`Root session parent is not a regular directory: ${parent}`);
	}
	assertOwner(parentMetadata, parent);

	const namedBefore = lstatSync(candidate, { bigint: true });
	if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) {
		throw controlError(`Root session path is not a regular file: ${candidate}`);
	}
	assertOwner(namedBefore, candidate);
	if (namedBefore.nlink !== 1n) {
		throw controlError(`Root session file must be singly linked: ${candidate}`);
	}
	const previousRaw = process.env.YPI_ROOT_SESSION_FILE_IDENTITY;
	if (previousRaw) {
		const previous = parsePrivateFileIdentity(previousRaw);
		if (
			previous.device !== namedBefore.dev.toString()
			|| previous.inode !== namedBefore.ino.toString()
		) {
			throw controlError(`Root session file identity changed: ${candidate}`);
		}
	}

	const descriptor = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
	try {
		const opened = fstatSync(descriptor, { bigint: true });
		if (!opened.isFile() || !sameInode(namedBefore, opened)) {
			throw controlError(`Root session identity changed before hardening: ${candidate}`);
		}
		assertOwner(opened, candidate);
		if (opened.nlink !== 1n) {
			throw controlError(`Root session file must be singly linked: ${candidate}`);
		}
		if (process.platform !== "win32") fchmodSync(descriptor, PRIVATE_FILE_MODE);
		const hardened = fstatSync(descriptor, { bigint: true });
		const namedAfter = lstatSync(candidate, { bigint: true });
		if (
			!sameInode(opened, hardened)
			|| !sameInode(opened, namedAfter)
			|| hardened.nlink !== 1n
			|| (process.platform !== "win32" && Number(hardened.mode & 0o777n) !== PRIVATE_FILE_MODE)
		) {
			throw controlError(`Root session identity changed during hardening: ${candidate}`);
		}
		const identity = identityOf(hardened);
		process.env.YPI_ROOT_SESSION_FILE_IDENTITY = JSON.stringify(identity);
		return identity;
	} finally {
		closeSync(descriptor);
	}
}
