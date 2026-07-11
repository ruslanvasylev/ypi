import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface WriteScopeDecision {
	allowed: boolean;
	absolutePath?: string;
	reason?: string;
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function nearestExistingPath(candidate: string): string | undefined {
	let current = candidate;
	while (!existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return current;
}

export function checkImplementWritePath(root: string, cwd: string, requestedPath: unknown): WriteScopeDecision {
	if (typeof requestedPath !== "string" || requestedPath.length === 0 || requestedPath.includes("\0")) {
		return { allowed: false, reason: "Implementer write path is missing or invalid" };
	}
	let canonicalRoot: string;
	try {
		canonicalRoot = realpathSync(root);
	} catch {
		return { allowed: false, reason: "Implementer workspace root is unavailable" };
	}
	const absolutePath = path.resolve(cwd, requestedPath);
	const existing = nearestExistingPath(absolutePath);
	if (!existing) {
		return { allowed: false, absolutePath, reason: "Implementer write ancestry could not be verified" };
	}
	let canonicalCandidate: string;
	try {
		const realExisting = realpathSync(existing);
		canonicalCandidate = path.resolve(realExisting, path.relative(existing, absolutePath));
	} catch {
		return { allowed: false, absolutePath, reason: "Implementer write ancestry could not be resolved" };
	}
	if (!isWithin(canonicalRoot, canonicalCandidate)) {
		return { allowed: false, absolutePath, reason: "Implementer write would escape the leased checkout or follow an external symlink" };
	}
	const relative = path.relative(canonicalRoot, canonicalCandidate);
	const firstComponent = relative.split(path.sep)[0];
	if (firstComponent === ".git" || firstComponent === ".jj") {
		return { allowed: false, absolutePath, reason: "Implementer cannot modify repository metadata" };
	}
	return { allowed: true, absolutePath };
}

export function registerImplementWriteScope(pi: ExtensionAPI): void {
	const root = process.env.YPI_IMPLEMENT_ROOT;
	if (!root) return;
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		const decision = checkImplementWritePath(root, ctx.cwd, event.input.path);
		if (decision.allowed) return undefined;
		if (ctx.hasUI) ctx.ui.notify(decision.reason || "Implementer write blocked", "warning");
		return { block: true, reason: decision.reason || "Implementer write blocked" };
	});
}
