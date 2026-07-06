// Per-scope chat history storage.
//
// The side panel keeps one conversation per (repo or origin), not one
// global thread. This module owns the storage shape:
//
//   chrome.storage.local["prodocstore.history"]: { [scope]: ChatMessage[] }
//
// Scope key:
//   "repo:owner/name"   - when the page resolves to a GitHub repo
//                         (preview + production deploys of the same
//                         site share the thread)
//   "origin:https://x"  - fallback for any other site
//   "__nocontext__"     - opening the side panel with no page context
//
// Pure persistence + a tiny helper for tracking which proposal IDs a
// chat owns (so Clear can delete only its own pending previews and
// leave other sites' alone). Nothing in here touches the DOM or the
// in-memory chat state - that lives in the side panel.

import type { ChatMessage, PageContext, PendingProposal } from "../types";

export const HISTORY_KEY = "prodocstore.history";
export const HISTORY_LIMIT = 500;
export const NO_CONTEXT_SCOPE = "__nocontext__";

export type Scope = string;
export type HistoryMap = Record<Scope, ChatMessage[]>;

export function scopeFromContext(ctx: PageContext | null): Scope {
  if (ctx?.repo) return `repo:${ctx.repo.owner}/${ctx.repo.name}`;
  if (ctx?.url) {
    try {
      return `origin:${new URL(ctx.url).origin}`;
    } catch {
      /* malformed URL - fall through to no-context */
    }
  }
  return NO_CONTEXT_SCOPE;
}

/**
 * Inverse of the `repo:` branch of scopeFromContext. Returns the owner +
 * name for a repo-backed scope, or null for origin/no-context scopes (which
 * have no repo to persist conversation logs into). Used by the side panel to
 * decide whether a conversation can be mirrored to `.prodocstore/chat/` in the
 * backing repo.
 */
export function repoFromScope(scope: Scope): { owner: string; name: string } | null {
  if (!scope.startsWith("repo:")) return null;
  const rest = scope.slice("repo:".length);
  const slash = rest.indexOf("/");
  // Require a non-empty owner before the slash and a non-empty name after it.
  if (slash <= 0 || slash >= rest.length - 1) return null;
  return { owner: rest.slice(0, slash), name: rest.slice(slash + 1) };
}

export async function readHistoryMap(): Promise<HistoryMap> {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const raw = stored[HISTORY_KEY];
  // Anything other than a plain object (missing key, or the legacy v1
  // flat-array shape we no longer support) is treated as empty. We do
  // NOT migrate v1 - chat history is ephemeral and there is no good
  // way to guess which scope the legacy entries belonged to.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as HistoryMap;
}

export async function readScopeHistory(scope: Scope): Promise<ChatMessage[]> {
  const map = await readHistoryMap();
  return map[scope] ?? [];
}

/**
 * Serializes all writes to the history map through a single promise
 * chain. chrome.storage.local has no atomic read-modify-write, so two
 * concurrent writeScopeHistory calls would each read the full map,
 * each apply their own delta, and each set the whole map back -
 * whichever set landed second silently overwrites the other's bucket.
 * Realistic in the multi-tab routing path: appendToScope(A) racing
 * with persistHistory()-on-B, or two replies arriving for the same
 * stale scope in close succession.
 *
 * NOTE: this queue only serializes writes WITHIN ONE page context. History is
 * written directly from the panel (message-view.persistHistory), not funneled
 * through the single service worker the way tasks are. So two side panels open
 * in two browser windows each have their own writeQueue: if window A (scope X)
 * and window B (scope Y) persist at the same instant, both read the same whole
 * HistoryMap and B's set() can clobber A's just-added bucket (lost after
 * reload). Rare (needs two panels active at once) but real; the durable fix is
 * to route history writes through the SW (single realm) like tasks.ts, or move
 * to per-scope storage keys so cross-scope writes don't share one map.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Read-modify-write so two side panels open on different scopes never
 * stomp on each other's bucket. Empty input deletes the bucket entirely
 * (keeps storage tidy after a Clear). All writes are queued through
 * `writeQueue` so concurrent callers serialize cleanly.
 */
export async function writeScopeHistory(scope: Scope, messages: ChatMessage[]): Promise<void> {
  const next = writeQueue.then(async () => {
    const map = await readHistoryMap();
    if (messages.length === 0) {
      delete map[scope];
    } else {
      map[scope] = messages;
    }
    await chrome.storage.local.set({ [HISTORY_KEY]: map });
  });
  // Catch the promise so a single failed write doesn't poison every
  // subsequent write in the chain. Errors still propagate to THIS
  // call's caller via the return.
  writeQueue = next.catch(() => {});
  return next;
}

/**
 * Atomic read-then-modify-then-write inside the serialized writeQueue.
 * The transformer receives the current bucket and returns the new one;
 * everything between the read and the write happens with no other
 * write interleaved. Use this whenever a caller needs to grow or mutate
 * a bucket relative to its current state - a plain `read + writeScope`
 * sequence captures a stale snapshot if a concurrent write completes
 * between the read and the write, silently losing the concurrent
 * update.
 *
 * Returns the new messages array so callers can render or measure it.
 */
export async function updateScopeHistory(
  scope: Scope,
  transform: (existing: ChatMessage[]) => ChatMessage[],
): Promise<ChatMessage[]> {
  let result: ChatMessage[] = [];
  const next = writeQueue.then(async () => {
    const map = await readHistoryMap();
    const existing = map[scope] ?? [];
    const updated = transform(existing);
    if (updated.length === 0) {
      delete map[scope];
    } else {
      map[scope] = updated;
    }
    await chrome.storage.local.set({ [HISTORY_KEY]: map });
    result = updated;
  });
  writeQueue = next.catch(() => {});
  await next;
  return result;
}

/**
 * The chrome.storage.session keys for every preview attachment in the
 * given messages. Used by Clear to delete only the proposals owned by
 * THIS scope's chat - other sites' pending previews stay put.
 */
export function proposalKeysFor(messages: ChatMessage[]): string[] {
  const keys: string[] = [];
  for (const m of messages) {
    const att = m.attachment;
    if (att?.kind !== "preview") continue;
    const data = att.data as PendingProposal | undefined;
    if (data?.proposalId) keys.push(`proposal:${data.proposalId}`);
  }
  return keys;
}

/**
 * Async chat handlers (CHAT_TURN, APPLY_PROPOSAL, CANCEL_PROPOSAL) take
 * hundreds of ms and the user can switch tabs while we wait. Snapshot
 * the scope at send-time and check it against the current scope when
 * the reply arrives - a mismatch means the user moved on and the reply
 * must be dropped to prevent cross-scope bleed (the reply landing in
 * the new site's history instead of the originating site's).
 *
 * This is named (rather than inlined) so any future async handler in
 * the side panel can grep "isStaleReply" to find the pattern and avoid
 * reintroducing the bug.
 */
export function isStaleReply(sentScope: Scope, currentScope: Scope): boolean {
  return sentScope !== currentScope;
}
