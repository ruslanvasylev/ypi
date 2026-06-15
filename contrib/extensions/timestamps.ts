/**
 * timestamps — Give agents time awareness.
 *
 * Agents have no built-in clock. This extension injects the current time
 * into every turn, tracks session uptime and turn duration, and registers
 * a `clock` tool for on-demand time queries.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function fmt(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

function now() { return new Date(); }
function iso(d: Date) { return d.toISOString(); }
function human(d: Date) { return d.toLocaleTimeString("en-US", { hour12: false, timeZoneName: "short" }); }

export default function timestamps(pi: ExtensionAPI) {
	const sessionStart = now();
	let turnStart = now();
	let lastTurnEnd = sessionStart;

	pi.on("session_start", async (_ev, ctx) => {
		const t = now();
		const tz = t.toLocaleString("en-US", { timeZoneName: "long" }).split(", ").pop() || "";
		pi.sendMessage({
			customType: "timestamp",
			content: `Current date and time: ${t.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} at ${human(t)}\nTimezone: ${tz}`,
			display: "inline",
		});
	});

	pi.on("before_agent_start", async () => { turnStart = now(); });

	pi.on("agent_end", async (_ev, ctx) => {
		const t = now();
		const uptime = fmt(t.getTime() - sessionStart.getTime());
		const turn = fmt(t.getTime() - turnStart.getTime());
		ctx.ui.setStatus("time", `⏱ ${human(t)} | session: ${uptime} | turn: ${turn}`);
		lastTurnEnd = t;
	});

	const { Type } = require("typebox");
	pi.registerTool({
		name: "clock",
		label: "Current time",
		description: "Returns current time, session uptime, and time since last turn. Use when you need to know what time it is.",
		parameters: Type.Object({}),
		execute: async () => {
			const t = now();
			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify({
						current_time: iso(t),
						human_time: human(t),
						session_uptime: fmt(t.getTime() - sessionStart.getTime()),
						since_last_turn: fmt(t.getTime() - lastTurnEnd.getTime()),
					}, null, 2),
				}],
			};
		},
	});
}
