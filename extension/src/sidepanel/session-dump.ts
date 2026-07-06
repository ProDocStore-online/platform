// Builds the plain-text diagnostic dump the "copy chat" button produces:
// context + settings + every message + the recent diagnostic log, pastable
// into another chat to debug what the extension is doing. Pure (given its
// inputs) and secret-safe, so it lives here and is unit-tested rather than
// buried in the side panel's click handler.

import type { ChatMessage, PageContext, Settings } from "../types";
import { redactSecrets, scrubSecrets } from "../lib/debug-safety";

export function buildSessionDump(opts: {
  ctx: PageContext | null;
  settings: Settings;
  history: ChatMessage[];
  logBuffer: string[];
  formatTime: (ts: number) => string;
}): string {
  const { ctx, settings, history, logBuffer, formatTime } = opts;

  // Strip secrets before dumping: anything under a token/key/secret-named key
  // becomes "<redacted>" so the dump is safe to paste elsewhere.
  const sanitized = redactSecrets(settings);

  const sections: string[] = ["# FreeDocStore session dump", ""];

  sections.push("## Context");
  if (ctx) {
    if (ctx.repo) sections.push(`- repo: ${ctx.repo.owner}/${ctx.repo.name}`);
    sections.push(`- source: ${ctx.sourcePath}`);
    sections.push(`- url: ${ctx.url}`);
    if (ctx.navConfig) sections.push(`- navConfig items: ${ctx.navConfig.items.length}`);
  } else {
    sections.push("- (no page context)");
  }
  sections.push("");

  sections.push("## Settings");
  sections.push("```json");
  sections.push(JSON.stringify(sanitized, null, 2));
  sections.push("```");
  sections.push("");

  sections.push(`## Messages (${history.length} total)`);
  for (const msg of history) {
    const stamp = msg.timestamp != null ? `[${formatTime(msg.timestamp)}] ` : "";
    sections.push(`${stamp}${msg.role}:`);
    sections.push(msg.content);
    sections.push("");
  }

  sections.push(`## Diagnostic log (${logBuffer.length} entries)`);
  if (logBuffer.length) {
    sections.push("```");
    sections.push(...logBuffer);
    sections.push("```");
  } else {
    sections.push("(empty - send a message first)");
  }

  // redactSecrets only scrubs values under secret-named keys in settings. Run
  // the FINAL text through scrubSecrets too, which catches token *shapes*
  // (ghp_/sk-ant-/…) anywhere - e.g. a key pasted into a chat message or log.
  return scrubSecrets(sections.join("\n").trim());
}
