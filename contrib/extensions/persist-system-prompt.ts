/**
 * persist-system-prompt — Save the effective system prompt to session files.
 *
 * Pi session files (.jsonl) don't include the system prompt by default.
 * This extension captures it on each agent start and appends it as a
 * custom entry, making sessions self-contained and auditable.
 *
 * The prompt is captured AFTER all extensions have modified it (via
 * before_agent_start), so it includes injected lessons, context, etc.
 *
 * Edge cases handled:
 * - Captures once per session (agent_start fires per message, we only record the first)
 * - On session resume, captures again (prompt may have changed since last run)
 * - Includes a sha256 hash so consumers can deduplicate without storing the full text
 * - No-session mode: appendEntry is a no-op, no errors
 *
 * Session entry format:
 *   {"type":"custom","customType":"system_prompt","data":{"prompt":"...","charCount":N,"sha256":"...","timestamp":"..."}}
 *
 * The entry is persisted to the session file but NOT sent to the LLM.
 *
 * Install:
 *   Place at ~/.pi/agent/extensions/persist-system-prompt.ts
 *   Or load with: pi -e path/to/persist-system-prompt.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";

export default function persistSystemPromptExtension(pi: ExtensionAPI) {
  let captured = false;

  pi.on("agent_start", async (_event, ctx) => {
    // Only capture once per Pi process lifetime for this session.
    // agent_start fires on every user message, but the system prompt
    // is set once (by before_agent_start) and doesn't change between turns.
    if (captured) return;
    captured = true;

    const prompt = ctx.getSystemPrompt();
    if (!prompt) return;

    const hash = createHash("sha256").update(prompt).digest("hex");

    pi.appendEntry("system_prompt", {
      prompt,
      charCount: prompt.length,
      sha256: hash,
      timestamp: new Date().toISOString(),
    });
  });

  // Reset on session switch so the new session gets its own snapshot.
  // On session resume, captured resets naturally (fresh extension load),
  // so the resumed session records the current prompt (which may differ
  // from the original — new lessons, updated AGENTS.md, etc.).
  pi.on("session_switch", async () => {
    captured = false;
  });
}
