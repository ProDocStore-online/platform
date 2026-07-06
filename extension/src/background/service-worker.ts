// Service worker: brokers messages between the side panel and content
// script, holds settings, and drives the chosen adapter.

import { getAdapter } from "../adapters/base";
import { loadStoredSettings, patchStoredSettings } from "../settings";
import { GitHubClient } from "../lib/github";
import { persistConversation } from "../lib/prodocstore-chat";
import { applyPendingProposal } from "../adapters/proposal-engine";
import { loadPendingProposal, removePendingProposal } from "../lib/proposals";
import { isValidRepoPath } from "../adapters/openai-tools";
import { mutateTask } from "../lib/tasks";
import { isLoopbackSinkUrl, scrubSecrets } from "../lib/debug-safety";
import { classifyMessage } from "./message-guard";
import type { ChatMessage, RepoPermissions, RuntimeMessage } from "../types";

const loadSettings = loadStoredSettings;
const saveSettings = patchStoredSettings;

// ── Debug bridge (service-worker side) ──────────────────────────────
// Mirrors background events - adapter request/response, commit results,
// errors - to settings.debug.sinkUrl so a local debug collector sees what
// the SW does, not just the side panel's view. Cached sink URL refreshed on
// settings change; best-effort.
// Only ever holds a LOOPBACK url (validated on assignment); a remote value
// is treated as disabled so diagnostics can't be exfiltrated off-box.
let debugSinkUrl: string | null = null;
async function refreshDebugSink(): Promise<void> {
  try {
    const s = await loadSettings();
    const sink = s.debug?.sinkUrl;
    debugSinkUrl = isLoopbackSinkUrl(sink) ? sink! : null;
  } catch {
    /* settings unreadable - leave sink disabled */
  }
}
function swDebug(payload: Record<string, unknown>): void {
  const url = debugSinkUrl;
  if (!url || !isLoopbackSinkUrl(url)) return;
  try {
    const body = scrubSecrets(
      JSON.stringify({ ts: Date.now(), kind: "sw", scope: "background", payload }),
    );
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-prodocstore-debug": "1" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never let debug plumbing break the service worker */
  }
}
void refreshDebugSink();

// In-memory permissions cache, keyed by `${owner}/${repo}`. GitHub
// permissions don't change often; a 5-minute TTL keeps us off the rate
// limit during normal navigation. Service-worker restarts wipe this -
// that's fine, the next request just refetches.
const PERMS_TTL_MS = 5 * 60_000;
const permsCache = new Map<string, { value: RepoPermissions | null; fetchedAt: number }>();

async function checkRepoPermissions(owner: string, repo: string): Promise<RepoPermissions | null> {
  const key = `${owner}/${repo}`;
  const cached = permsCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PERMS_TTL_MS) {
    return cached.value;
  }
  try {
    const settings = await loadSettings();
    // Not signed in - return null so the UI stays permissive (we don't
    // want to disable Edit just because the user hasn't signed in yet).
    if (!settings.claude?.githubToken && !settings.claude?.githubApp?.accessToken) {
      return null;
    }
    const gh = await GitHubClient.fromSettings(settings);
    const perms = await gh.getRepoPermissions(owner, repo);
    permsCache.set(key, { value: perms, fetchedAt: Date.now() });
    return perms;
  } catch {
    // Network error, repo not found, etc. Return null and don't cache
    // so a transient failure doesn't lock the user out for 5 minutes.
    return null;
  }
}

// Settings changes (sign-in, sign-out, switch accounts) invalidate the
// permissions cache. Without this, the cache could keep returning a
// push:true result after the user signed out, leaving the side panel
// showing Edit as enabled while chat-time configError fails.
chrome.storage.onChanged.addListener((changes, area) => {
  // Watch sync AND local: patchStoredSettings mirrors to both, and an
  // over-quota sync write lands only in local. A sync-only guard would then
  // miss a sign-out (stale permissions cache) or a debug-sink toggle. Both
  // carry the same value, so a double-fire on a normal save is idempotent.
  if (area !== "sync" && area !== "local") return;
  const change = changes["prodocstore.settings"];
  if (!change) return;
  const oldClaude = (change.oldValue as { claude?: unknown } | undefined)?.claude;
  const newClaude = (change.newValue as { claude?: unknown } | undefined)?.claude;
  // Only flush when the auth-relevant block changed. Cheap to over-flush
  // (next CHECK_PERMISSIONS just refetches) but a strict equality guard
  // keeps the cache useful when only e.g. the openai apiKey was updated.
  if (JSON.stringify(oldClaude) !== JSON.stringify(newClaude)) {
    permsCache.clear();
  }
  // Keep the cached debug sink URL in sync so toggling it in Options takes
  // effect without restarting the service worker. Loopback-only.
  const sink = (change.newValue as { debug?: { sinkUrl?: string } } | undefined)?.debug?.sinkUrl;
  debugSinkUrl = isLoopbackSinkUrl(sink) ? sink! : null;
});

// Authoritative single-flight guard for Apply. The proposal is only removed
// AFTER its commit/PR completes, so two concurrent APPLY_PROPOSAL for the same
// id (two open side panels, or a manual Apply racing the reverse channel) would
// both load it and both commit - a duplicate PR or a second push that 409s on a
// now-stale SHA. The panel guards this per-instance, but the SW is the one
// context every Apply funnels through, so the lock belongs here too.
const applyingProposalIds = new Set<string>();

/**
 * Resolve a stored PendingProposal to a chat reply. Loads the proposal
 * from chrome.storage.session, builds a fresh GitHubClient using the
 * current settings, and runs the actual commit. Surfaces a clear error
 * if the proposal is gone (session restart, double-Apply) or if the
 * user has no GitHub credentials.
 */
async function handleApplyProposal(id: string): Promise<ChatMessage> {
  if (applyingProposalIds.has(id)) {
    return {
      role: "assistant",
      content: "That change is already being applied - hold on.",
      attachment: { kind: "preview_resolved", data: { proposalId: id, outcome: "applied" } },
    };
  }
  const proposal = await loadPendingProposal(id);
  if (!proposal) {
    return {
      role: "assistant",
      content: "Proposal expired or already applied. Send the request again.",
      attachment: { kind: "preview_resolved", data: { proposalId: id, outcome: "expired" } },
    };
  }
  applyingProposalIds.add(id);
  try {
    const settings = await loadStoredSettings();
    const gh = await GitHubClient.fromSettings(settings);
    const reply = await applyPendingProposal(proposal, gh);
    // applyPendingProposal removes the proposal on success. Tag the
    // reply so the UI can swap the preview message for the result.
    reply.attachment = reply.attachment ?? { kind: "preview_resolved", data: { proposalId: id, outcome: "applied" } };
    return reply;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { role: "assistant", content: `Apply failed: ${msg}` };
  } finally {
    // Released whether the commit succeeded (proposal now gone) or failed
    // (so the user can retry Apply on the still-pending proposal).
    applyingProposalIds.delete(id);
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id != null) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

// Track which windows currently have the side panel open, so a content script
// can gate its in-page affordances (✎ button, edit badge, highlight overlays)
// on the panel being open in ITS window. There is no Chrome API to query panel
// visibility, so the panel opens a long-lived "sidepanel" port on load and
// tells us its windowId; the port's onDisconnect fires when the panel document
// unloads (panel closed / window closed), giving us a reliable close signal.
const openPanelWindows = new Set<number>();

// Tell the content scripts in `windowId` that the panel just opened/closed, so
// they show/hide immediately instead of waiting for their next paint. Content
// scripts run only on *.pages.dev; sendMessage to any other tab has no receiver
// and rejects - swallow that per tab.
async function broadcastPanelState(windowId: number, open: boolean): Promise<void> {
  const tabs = await chrome.tabs.query({ windowId });
  for (const t of tabs) {
    if (t.id == null) continue;
    try {
      await chrome.tabs.sendMessage(t.id, { type: "PANEL_STATE", open });
    } catch {
      // No content script in this tab (not a *.pages.dev page) - expected.
    }
  }
}

// A tab dragged into another window inherits that window's panel state, but the
// content script's cached panelOpen doesn't know it moved. Push the new window's
// state to the moved tab so its in-page affordances re-sync. Best-effort: no
// content script (non-docs tab) just means no receiver.
chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => {
  chrome.tabs
    .sendMessage(tabId, { type: "PANEL_STATE", open: openPanelWindows.has(newWindowId) })
    .catch(() => {});
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidepanel") return;
  let windowId: number | null = null;
  port.onMessage.addListener((m: { windowId?: number }) => {
    if (typeof m?.windowId === "number") {
      windowId = m.windowId;
      openPanelWindows.add(windowId);
      void broadcastPanelState(windowId, true);
    }
  });
  port.onDisconnect.addListener(() => {
    if (windowId != null) {
      openPanelWindows.delete(windowId);
      void broadcastPanelState(windowId, false);
    }
  });
});

// Dev-mode auto-reload.
//
// build.mjs watch-mode writes dist/.dev-build with a fresh timestamp on
// every successful rebuild. We poll that file from the service worker
// and call chrome.runtime.reload() when the stamp changes - so editing
// any source file triggers a rebuild and then a self-reload of the
// extension, no manual click in chrome://extensions needed.
//
// In production builds .dev-build isn't shipped, so the first fetch
// 404s and the loop bails out silently. Zero cost outside dev.
//
// Chrome may suspend the service worker after ~30s of inactivity; when
// it wakes, this IIFE runs again with a fresh baseline. Any rebuilds
// that happened while the SW was asleep simply become the new baseline
// on wake-up (no spurious reload).
(async function devAutoReload() {
  const url = chrome.runtime.getURL(".dev-build");
  let baseline: string;
  try {
    const r = await fetch(url);
    if (!r.ok) return;
    baseline = await r.text();
  } catch {
    return; // production build or file unreadable
  }
  console.log("[prodocstore:dev] auto-reload active, baseline =", baseline);
  setInterval(async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) return;
      const stamp = await r.text();
      if (stamp !== baseline) {
        console.log("[prodocstore:dev] rebuild detected, reloading extension");
        chrome.runtime.reload();
      }
    } catch {
      // Transient errors are fine; we'll try again next tick.
    }
  }, 1500);
})();

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
  // Trust boundary. Ignore anything not from our own extension, and gate
  // privileged handlers so a content script can't read settings/secrets,
  // commit, or persist on behalf of a malicious page. See message-guard.ts for
  // the sender classification (options/board pages live in tabs too, so a bare
  // sender.tab check wrongly refused them).
  const verdict = classifyMessage(msg.type, sender, chrome.runtime.id);
  if (verdict === "drop") return; // another extension - drop silently
  if (verdict === "refuse") {
    swDebug({ event: "message_refused", msgType: msg.type, reason: "content_script_not_allowed" });
    sendResponse({
      type: "ERROR_RESULT",
      payload: {
        role: "assistant",
        content: `Refused: ${msg.type} is not available from a page context.`,
      },
    });
    return true;
  }
  (async () => {
    try {
      await dispatchMessage(msg, sender, sendResponse);
    } catch (err) {
      // Without this catch, an exception inside the IIFE prevents
      // sendResponse from being called - the sender's promise rejects
      // with "Could not establish connection" and the side panel crashes
      // dereferencing resp.payload. Convert any throw to a structured
      // error envelope the caller can render as a chat message.
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[prodocstore:bg] handler threw", { msgType: msg.type, detail });
      swDebug({ event: "handler_error", msgType: msg.type, detail: detail.slice(0, 300) });
      try {
        sendResponse({
          type: "ERROR_RESULT",
          payload: {
            role: "assistant",
            content: `Background error (${msg.type}): ${detail.slice(0, 300)}`,
            attachment: { kind: "error", data: { action: "open_options" } },
          },
        });
      } catch {
        // sendResponse can throw if the channel is already closed;
        // there's nothing meaningful we can do in that case.
      }
    }
  })();
  return true; // keep the channel open for the async response
});

async function dispatchMessage(
  msg: RuntimeMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): Promise<void> {
  if (msg.type === "IS_PANEL_OPEN") {
    // Report open-state for the asking tab's window only (panels are per-window).
    const wid = sender.tab?.windowId;
    const open = wid != null && openPanelWindows.has(wid);
    sendResponse({ type: "IS_PANEL_OPEN_RESULT", payload: { open } });
    return;
  }
  if (msg.type === "FOCUS_EDIT_THREAD") {
    // Panel-directed (the side panel's own onMessage handles it); the SW just
    // acks so the sender's channel closes cleanly.
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "GET_SETTINGS") {
    sendResponse({ type: "SETTINGS_RESULT", payload: await loadSettings() });
    return;
  }
  if (msg.type === "SET_SETTINGS") {
    const next = await saveSettings(msg.payload);
    sendResponse({ type: "SETTINGS_RESULT", payload: next });
    return;
  }
  if (msg.type === "CHECK_PERMISSIONS") {
    const perms = await checkRepoPermissions(msg.owner, msg.repo);
    sendResponse({ type: "PERMISSIONS_RESULT", payload: perms });
    return;
  }
  if (msg.type === "READ_REPO_FILE") {
    // Fallback path for content-script fetches that can't reach the
    // live site (Cloudflare Access redirect, missing file served as
    // 200+HTML by CF Pages default handler). Requires GitHub auth;
    // returns a structured error otherwise so the caller can decide
    // whether to surface it to the user.
    try {
      const settings = await loadSettings();
      if (!settings.claude?.githubToken && !settings.claude?.githubApp?.accessToken) {
        sendResponse({ type: "READ_REPO_FILE_RESULT", payload: { error: "no_github_auth" } });
        return;
      }
      // Clamp the repo path even though the only in-tree sender hardcodes
      // docs/nav.json / docs/features.json: this is the one message-guard-allowed
      // content-script route with a repo path, so validate it as defence in depth
      // (a compromised/renamed sender can't fetch arbitrary repo files).
      if (!isValidRepoPath(msg.path)) {
        sendResponse({ type: "READ_REPO_FILE_RESULT", payload: { error: "invalid_path" } });
        return;
      }
      const gh = await GitHubClient.fromSettings(settings);
      const file = await gh.getFile(msg.owner, msg.repo, msg.path);
      sendResponse({ type: "READ_REPO_FILE_RESULT", payload: { content: file.content } });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      sendResponse({
        type: "READ_REPO_FILE_RESULT",
        payload: { error: /404/.test(detail) ? "not_found" : detail.slice(0, 200) },
      });
    }
    return;
  }
  if (msg.type === "PERSIST_CONVERSATION") {
    // Best-effort mirror of the conversation into the repo. Requires
    // GitHub auth (same credential as commits); when absent we return a
    // structured no-op rather than an error so the side panel can stay
    // quiet for read-only/anonymous users.
    try {
      const settings = await loadSettings();
      if (!settings.claude?.githubToken && !settings.claude?.githubApp?.accessToken) {
        sendResponse({ type: "PERSIST_CONVERSATION_RESULT", payload: { ok: false, error: "no_github_auth" } });
        return;
      }
      const gh = await GitHubClient.fromSettings(settings);
      const now = new Date().toISOString();
      const { commitUrl } = await persistConversation(gh, msg.owner, msg.repo, msg.messages, now);
      swDebug({ event: "persist_conversation", repo: `${msg.owner}/${msg.repo}`, messageCount: msg.messages.length, commitUrl });
      sendResponse({ type: "PERSIST_CONVERSATION_RESULT", payload: { ok: true, commitUrl } });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      swDebug({ event: "persist_conversation_failed", repo: `${msg.owner}/${msg.repo}`, detail: detail.slice(0, 200) });
      sendResponse({ type: "PERSIST_CONVERSATION_RESULT", payload: { ok: false, error: detail.slice(0, 200) } });
    }
    return;
  }
  if (msg.type === "APPLY_PROPOSAL") {
    const reply = await handleApplyProposal(msg.proposalId);
    sendResponse({ type: "PROPOSAL_RESULT", payload: reply });
    return;
  }
  if (msg.type === "CANCEL_PROPOSAL") {
    // Refuse to cancel a proposal that's mid-Apply: the commit is already in
    // flight and advanceTaskOnApply will set the task to deployed/in_review, so
    // a cancel here would remove the pending record and flip the task to
    // "cancelled" only for Apply to un-cancel it and commit anyway. Make the
    // user wait out the ~1-2s Apply instead.
    if (applyingProposalIds.has(msg.proposalId)) {
      sendResponse({
        type: "PROPOSAL_RESULT",
        payload: {
          role: "assistant",
          content: "This change is being applied right now - can't cancel it. It'll finish in a moment.",
        },
      });
      return;
    }
    // Dismissing a proposal cancels its board task. Read the proposal for
    // its taskId BEFORE removing it. Local-only update (no gh needed); the
    // next mirror-triggering action reconciles the shared copy.
    const pending = await loadPendingProposal(msg.proposalId);
    if (pending?.kind === "edit" && pending.taskId) {
      // Read-modify-write inside the serialized queue so a concurrent task
      // write can't clobber the cancel (or be clobbered by it).
      await mutateTask(pending.taskId, (t) =>
        t.status === "proposed" ? { ...t, status: "cancelled", updatedAt: Date.now() } : t,
      );
    }
    await removePendingProposal(msg.proposalId);
    sendResponse({
      type: "PROPOSAL_RESULT",
      payload: { role: "assistant", content: "Cancelled.", attachment: { kind: "preview_resolved", data: { proposalId: msg.proposalId, outcome: "cancelled" } } },
    });
    return;
  }
  if (msg.type === "CHAT_TURN") {
    const loaded = await loadSettings();
    // Per-turn mode override (thread Q&A forces "read"); falls back to the
    // stored mode. A shallow copy so we don't mutate the cached settings.
    const settings = msg.mode ? { ...loaded, mode: msg.mode } : loaded;
    const adapter = getAdapter(settings.adapter);
    console.log("[prodocstore:bg] CHAT_TURN received", {
      adapter: settings.adapter,
      prompt: msg.prompt.slice(0, 80),
      historyCount: (msg.history ?? []).length,
    });
    swDebug({
      event: "chat_turn",
      adapter: settings.adapter,
      mode: settings.mode ?? "read",
      repo: msg.context?.repo ? `${msg.context.repo.owner}/${msg.context.repo.name}` : null,
      sourcePath: msg.context?.sourcePath,
      promptPreview: msg.prompt.slice(0, 200),
      historyCount: (msg.history ?? []).length,
    });
    if (!adapter) {
      sendResponse({
        type: "CHAT_TURN_RESULT",
        payload: {
          role: "assistant",
          content: `Adapter '${settings.adapter}' is not implemented yet.`,
        },
      });
      return;
    }
    const err = adapter.configError(settings);
    if (err) {
      // Surface as an actionable error: the side panel renders a
      // clickable "Open settings" button under the prose so a fresh
      // install (or reinstall - chrome.storage.sync clears on
      // uninstall) has a one-click path to a fix.
      sendResponse({
        type: "CHAT_TURN_RESULT",
        payload: {
          role: "assistant",
          content: `Setup needed: ${err}.`,
          attachment: { kind: "error", data: { action: "open_options" } },
        },
      });
      return;
    }
    const reply = await adapter.chat(msg.prompt, msg.context, msg.history ?? [], settings, {
      taskId: msg.taskId,
    });
    swDebug({
      event: "chat_reply",
      adapter: settings.adapter,
      role: reply.role,
      attachment: reply.attachment?.kind ?? null,
      contentPreview: reply.content.slice(0, 300),
    });
    sendResponse({ type: "CHAT_TURN_RESULT", payload: reply });
    return;
  }

  if (msg.type === "SELECTION_RESULT") {
    // Content script -> side panel push (the in-page "Edit this" button
    // pinned a selection). It broadcasts to every extension context; the
    // side panel consumes it, the background is not a participant. Ack and
    // return so it doesn't fall through to the unknown-type warning.
    sendResponse({ type: "SELECTION_RESULT", payload: null });
    return;
  }

  if (msg.type === "TASK_APPEND_MESSAGE") {
    // Single-writer discipline: the panel asks US to append; mutateTask
    // serializes it against proposal/apply writes so nothing is lost.
    const task = await mutateTask(msg.taskId, (t) => ({
      ...t,
      conversation: [...t.conversation, msg.message],
      updatedAt: Date.now(),
    }));
    sendResponse({ type: "TASK_RESULT", payload: { task } });
    return;
  }

  if (msg.type === "SET_TASK_ARCHIVED") {
    const task = await mutateTask(msg.taskId, (t) => ({
      ...t,
      archived: msg.archived,
      updatedAt: Date.now(),
    }));
    sendResponse({ type: "TASK_RESULT", payload: { task } });
    return;
  }

  if (msg.type === "SET_TASK_STATUS") {
    const task = await mutateTask(msg.taskId, (t) => ({
      ...t,
      status: msg.status,
      updatedAt: Date.now(),
    }));
    sendResponse({ type: "TASK_RESULT", payload: { task } });
    return;
  }

  if (msg.type === "OPEN_BOARD") {
    // Open (or focus) the board, deep-linked to a task/repo. Reuse an
    // existing board tab so marker clicks don't pile up duplicates.
    const params = new URLSearchParams();
    if (msg.taskId) params.set("task", msg.taskId);
    if (msg.repo) params.set("repo", msg.repo);
    const q = params.toString();
    const url = chrome.runtime.getURL(`board.html${q ? `?${q}` : ""}`);
    const base = chrome.runtime.getURL("board.html");
    const tabs = await chrome.tabs.query({ url: `${base}*` });
    const found = tabs.find((t) => t.id != null);
    if (found?.id != null) {
      await chrome.tabs.update(found.id, { url, active: true });
    } else {
      await chrome.tabs.create({ url });
    }
    sendResponse({ type: "PROPOSAL_RESULT", payload: { role: "assistant", content: "ok" } });
    return;
  }

  // Default branch: any message type that has no handler (mistyped
  // sender, accidental *_RESULT envelope from another extension on the
  // same channel, or a future RuntimeMessage variant added without a
  // handler). Without this, the IIFE returns silently, sendResponse is
  // never called, and the sender's promise hangs until Chrome times out
  // the channel - the side panel would crash on resp.payload.
  // NOTE: this is deliberately NOT a `never` exhaustiveness assert. RuntimeMessage
  // is a shared union across contexts - it includes messages bound for the
  // content script (GET_PAGE_CONTEXT, GET_SELECTION, …) and the side panel
  // (PAGE_CONTEXT_RESULT, TASK_RESULT, …) that the service worker legitimately
  // never handles. So the residual here is a real (non-never) union; we just
  // need to always reply so the sender's promise doesn't hang.
  const unhandled: { type: string } = msg;
  console.warn("[prodocstore:bg] unknown message type", unhandled.type);
  sendResponse({
    type: "ERROR_RESULT",
    payload: {
      role: "assistant",
      content: `Background received an unknown message type: ${unhandled.type}. This is an extension bug.`,
      attachment: { kind: "error", data: { action: "open_options" } },
    },
  });
}
