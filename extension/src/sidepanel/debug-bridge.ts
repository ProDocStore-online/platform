// Debug bridge: the local diagnostic sink + the in-memory, per-scope log
// buffer. This is the transport/state half of the debug feature; the panel
// keeps the UI actuation (the reverse-channel prompt/apply driver) since that
// pokes DOM. Everything here is loopback-only and no-op unless the user has
// configured settings.debug.sinkUrl.
//
// The current scope is read lazily via an injected getter (initDebug) so this
// module doesn't have to import the panel's mutable currentScope.

import type { Settings } from "../types";
import type { Scope } from "../lib/history";
import { isLoopbackSinkUrl, scrubSecrets } from "../lib/debug-safety";

// Debug bridge target (settings.debug.sinkUrl). Null = disabled (default).
// Only ever holds a LOOPBACK url (validated at assignment); a remote value
// is treated as disabled. Kept in module state so the synchronous dlog()
// can read it without an await. Updated by applyDebugSettings.
let debugSinkUrl: string | null = null;
// Reverse-drive (inject) opt-in. Separate from the sink so enabling
// read-only diagnostics does NOT also enable remote prompt injection.
// Requires BOTH a valid loopback sink AND settings.debug.allowInject.
let allowInject = false;

let getScope: () => Scope = () => "" as Scope;

/** Wire the lazy current-scope accessor. Call once during panel init. */
export function initDebug(scopeGetter: () => Scope): void {
  getScope = scopeGetter;
}

/** Apply the debug settings to module state with loopback validation. */
export function applyDebugSettings(debug: Settings["debug"]): void {
  const sink = debug?.sinkUrl;
  debugSinkUrl = isLoopbackSinkUrl(sink) ? sink! : null;
  allowInject = !!debug?.allowInject && debugSinkUrl != null;
}

/**
 * Fire-and-forget a debug event to the local sink, if configured. Best
 * effort by design: a missing/closed collector must never affect the
 * chat UI, so every failure is swallowed. keepalive lets late events
 * (e.g. during panel close) still flush. See settings.debug.sinkUrl.
 */
export function postDebug(kind: string, payload: unknown): void {
  const url = debugSinkUrl;
  // Loopback-only, always. debugSinkUrl is already validated at assignment,
  // but re-check here so no future code path can POST diagnostics off-box.
  if (!url || !isLoopbackSinkUrl(url)) return;
  try {
    // Scrub token-shaped secrets from the whole payload (a user could paste
    // a token into the chat, which rides out in a "conversation" event).
    const body = scrubSecrets(
      JSON.stringify({ ts: Date.now(), kind, scope: getScope(), payload }),
    );
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-freedocstore-debug": "1" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* malformed URL etc. - never let debug plumbing break the panel */
  }
}

// In-memory diagnostic log. Per-scope (same scoping as history) so
// switching sites doesn't bleed one site's events into another's dump.
// The live buffer is mutated in place; stash/restore/clear swap it per scope.
const LOG_LIMIT = 200;
const logBuffer: string[] = [];
const logBuffersByScope: Record<Scope, string[]> = {};

export function dlog(label: string, payload?: unknown): void {
  const stamp = new Date().toISOString().slice(11, 19);
  const line = payload === undefined
    ? `[${stamp}] ${label}`
    : `[${stamp}] ${label} ${JSON.stringify(payload)}`;
  logBuffer.push(line);
  if (logBuffer.length > LOG_LIMIT) logBuffer.splice(0, logBuffer.length - LOG_LIMIT);
  console.log(`[docs-chat] ${label}`, payload ?? "");
  // Mirror the diagnostic line to the debug bridge (no-op when unset).
  postDebug("log", { label, payload });
}

/** The live log buffer for the active scope (for copy-chat / session dumps). */
export function getLogBuffer(): string[] {
  return logBuffer;
}

/** Stash the live buffer under `scope` before swapping scopes. */
export function stashLog(scope: Scope): void {
  if (logBuffer.length > 0) logBuffersByScope[scope] = [...logBuffer];
}

/** Swap the live buffer to `scope`'s saved log (or empty). */
export function restoreLog(scope: Scope): void {
  logBuffer.length = 0;
  const saved = logBuffersByScope[scope] ?? [];
  logBuffer.push(...saved);
}

/** Wipe the live buffer and drop `scope`'s stash (used by Clear chat). */
export function clearLog(scope: Scope): void {
  logBuffer.length = 0;
  delete logBuffersByScope[scope];
}

/**
 * The reverse-channel base URL, or null when injection isn't enabled. The
 * panel's inject poller reads this; the actuation (submitting prompts,
 * clicking Apply) stays in the panel because it drives DOM.
 */
export function injectBaseUrl(): string | null {
  if (!allowInject || !debugSinkUrl) return null;
  return debugSinkUrl.replace(/\/event\/?$/, "");
}
