import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentDepth, currentRootSessionWarning, maxDepth } from "./env.ts";

export function updateStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const label = ctx.ui.theme.fg("accent", "ypi");
	const depthInfo = ctx.ui.theme.fg("dim", ` ∞ depth ${currentDepth()}/${maxDepth()}`);
	const warning = currentRootSessionWarning()
		? ctx.ui.theme.fg("warning", " ⚠ session telemetry")
		: "";
	ctx.ui.setStatus("ypi", label + depthInfo + warning);
	ctx.ui.setTitle("ypi");
}
