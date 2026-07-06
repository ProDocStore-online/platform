// Message view: renders a single chat message (prose + preview/error
// attachments), the "↓ New messages" chip, and the append/persist plumbing that
// keeps in-memory history, chrome.storage, and the repo mirror in sync.
//
// The leaf of the side-panel module graph: it imports state/dom-refs/libs only,
// never a sibling panel module. The one outward coupling - what the preview
// Apply/Cancel buttons do - is injected via setPreviewActions() by the
// orchestrator, so this module has no static dependency on the conversation
// core or thread UI.

import type { ChatMessage, PendingProposal } from "../types";
import { state, history, messageBelongsToActive } from "./state";
import { messagesEl, newBelowChip } from "./dom-refs";
import { formatTime, slimForPersist } from "./format";
import { avatarEl } from "../lib/avatar";
import { appendLinkified } from "./linkify";
import { renderMarkdown } from "../lib/markdown";
import { renderPreview, type PreviewActions } from "./preview-card";
import { dlog, postDebug } from "./debug-bridge";
import { sendToBg } from "../lib/messaging";
import {
  HISTORY_LIMIT,
  repoFromScope,
  updateScopeHistory,
  writeScopeHistory,
  type Scope,
} from "../lib/history";

// What the preview Apply/Cancel buttons do. Injected once at boot (the actions
// call into the conversation core + thread header, which live elsewhere).
let previewActions: PreviewActions | null = null;
export function setPreviewActions(actions: PreviewActions): void {
  previewActions = actions;
}

// In-place navigation for same-site links in message bodies. Injected at boot
// (the actual chrome.tabs navigation lives in tab-messaging, a non-leaf module);
// keeping it a callback preserves message-view as the module-graph leaf.
let navigateSameSite: ((url: string) => void) | null = null;
export function setLinkNavigator(fn: (url: string) => void): void {
  navigateSameSite = fn;
}

export function renderMessage(msg: ChatMessage): void {
  const div = document.createElement("div");
  div.className = `message ${msg.role}`;

  // Sender row: avatar + name + timestamp. User turns show the signed-in
  // GitHub user's avatar (falls back to a neutral chip when the login is
  // unknown); assistant turns show a bot glyph. System messages keep a bare
  // timestamp with no sender.
  const ts = document.createElement("span");
  ts.className = "timestamp";
  if (msg.timestamp != null) {
    ts.textContent = formatTime(msg.timestamp);
    ts.title = new Date(msg.timestamp).toLocaleString();
  }
  if (msg.role === "system") {
    if (msg.timestamp != null) div.appendChild(ts);
  } else {
    const head = document.createElement("div");
    head.className = "msg-head";
    const name = document.createElement("span");
    name.className = "msg-author";
    if (msg.role === "user") {
      head.appendChild(avatarEl(state.myLogin, 18));
      name.textContent = state.myLogin ? `@${state.myLogin}` : "You";
    } else {
      name.textContent = "🤖 Assistant";
    }
    head.appendChild(name);
    if (msg.timestamp != null) head.appendChild(ts);
    div.appendChild(head);
  }

  // Quote the on-page selection this turn was anchored to, so you can see
  // exactly what was selected right in the transcript.
  if (msg.role === "user" && msg.selection?.text) {
    const quote = document.createElement("div");
    quote.className = "msg-selection";
    if (msg.selection.heading) {
      const h = document.createElement("div");
      h.className = "msg-selection-head";
      h.textContent = `Selected under "${msg.selection.heading}"`;
      quote.appendChild(h);
    }
    const q = document.createElement("div");
    q.className = "msg-selection-text";
    q.textContent = msg.selection.text;
    quote.appendChild(q);
    div.appendChild(quote);
  } else if (msg.role === "user" && msg.pageContext) {
    // Unselected edit: show that the whole page was the context.
    const chip = document.createElement("div");
    chip.className = "msg-context";
    chip.textContent = `📄 Whole page: ${msg.pageContext.title || msg.pageContext.sourcePath}`;
    chip.title = msg.pageContext.sourcePath;
    div.appendChild(chip);
  }

  const body = document.createElement("span");
  body.className = "body";
  // Assistant replies are Markdown (tables, code, lists); render them.
  // User messages stay plain text + linkified (they rarely use Markdown
  // and we don't want their asterisks reflowed).
  if (msg.role === "assistant") {
    body.classList.add("md");
    body.appendChild(renderMarkdown(msg.content));
  } else {
    appendLinkified(body, msg.content);
  }
  div.appendChild(body);

  // Preview attachments get a structured diff + Apply/Cancel UI below the prose.
  // The message is replaced wholesale when the user clicks either button (the
  // runtime handler returns a fresh ChatMessage we render in place of this one).
  if (msg.attachment?.kind === "preview" && previewActions) {
    const preview = renderPreview(msg.attachment.data as PendingProposal, div, previewActions);
    div.appendChild(preview);
  }

  // Restored-from-storage previews come back as preview_resolved/expired
  // because the underlying proposal lives in chrome.storage.session and
  // doesn't survive a browser restart. Add a small caption so the user
  // knows the row is historical and the original Apply window is gone.
  if (msg.attachment?.kind === "preview_resolved") {
    const data = msg.attachment.data as { outcome?: string };
    if (data?.outcome === "expired") {
      const note = document.createElement("div");
      note.className = "preview-stale";
      note.textContent = "This proposal expired (browser restart). Send the request again to retry.";
      div.appendChild(note);
    }
  }

  // Setup-needed errors carry an "open_options" action so the user can
  // get to the configuration UI in one click rather than hunting for the
  // gear icon. Particularly important after a fresh install / reinstall
  // when chrome.storage.sync has been wiped to defaults.
  if (msg.attachment?.kind === "error") {
    const data = msg.attachment.data as { action?: string };
    if (data?.action === "open_options") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "msg-action-btn";
      btn.textContent = "Open settings";
      btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
      div.appendChild(btn);
    }
  }

  // Only auto-scroll if the user was already near the bottom. If they've
  // scrolled up to read older messages, leave the viewport where it is -
  // hijacking the scroll mid-read is the kind of UX bug that makes people
  // close the panel. Instead, surface a "↓ New messages" chip so they know
  // something landed below. Suppressed during a bulk renderActiveThread,
  // which force-scrolls to the bottom itself.
  const wasNearBottom = isNearBottom();
  messagesEl.appendChild(div);
  if (state.bulkRendering) return;
  if (wasNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  else showNewBelowChip();
}

export function isNearBottom(): boolean {
  return messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 24;
}

export function showNewBelowChip(): void {
  newBelowChip.hidden = false;
}

export function hideNewBelowChip(): void {
  newBelowChip.hidden = true;
}

/** Wire the "↓ New messages" chip click + the scroll-to-dismiss listener. */
export function initMessageView(): void {
  newBelowChip.addEventListener("click", () => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    hideNewBelowChip();
  });
  // Dismiss the chip once the user scrolls back down to the latest message.
  messagesEl.addEventListener("scroll", () => {
    if (isNearBottom()) hideNewBelowChip();
  });

  // Links in a reply that point to the docs site you're browsing navigate the
  // docked tab IN PLACE - matching the edit-card breadcrumb - instead of
  // spawning a tab per click. Cross-site links (GitHub commits, external refs)
  // keep their target=_blank new-tab behaviour. One delegated listener covers
  // every message body (markdown + linkified) without touching the renderers.
  messagesEl.addEventListener("click", (e) => {
    const anchor = (e.target as HTMLElement | null)?.closest?.("a");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const href = anchor.href;
    if (!/^https?:/i.test(href)) return; // chrome:// etc. handled by linkify
    const docsUrl = state.currentContext?.url;
    if (!docsUrl) return;
    try {
      if (new URL(href).origin === new URL(docsUrl).origin) {
        e.preventDefault();
        navigateSameSite?.(href);
      }
    } catch {
      /* unparseable URL - let the default anchor behaviour run */
    }
  });
}

// slimForPersist (in ./format) drops heavy preview payloads before we write
// history to chrome.storage.local.
export async function persistHistory(): Promise<void> {
  const slim = history.map(slimForPersist);
  await writeScopeHistory(state.currentScope, slim);
  scheduleRepoMirror();
  // Stream the full live conversation to the debug bridge so a watcher sees
  // message content the dlog stream omits. No-op when the sink is unset.
  postDebug("conversation", { scope: state.currentScope, messageCount: slim.length, messages: slim });
}

// Debounced mirror of the active conversation into .prodocstore/chat/ in the
// backing repo (see lib/prodocstore-chat.ts). chrome.storage.local is the live
// buffer; this is the durable, shareable copy in git.
//
// Debounced because persistHistory fires on every appended message (user turn,
// then assistant reply, then any preview resolution) - we only want one commit
// per settled turn, not three. Snapshot the scope + messages at SCHEDULE time so
// a tab switch during the debounce window can't mirror this scope's thread under
// another repo. Origin / no-context scopes (repoFromScope === null) are skipped.
const REPO_MIRROR_DEBOUNCE_MS = 1500;
function scheduleRepoMirror(): void {
  const repo = repoFromScope(state.currentScope);
  if (!repo) return;
  const messages = history.map(slimForPersist);
  if (messages.length === 0) return;
  if (state.repoMirrorTimer != null) clearTimeout(state.repoMirrorTimer);
  state.repoMirrorTimer = window.setTimeout(() => {
    state.repoMirrorTimer = null;
    void sendToBg<{ payload?: { ok: boolean; commitUrl?: string; error?: string } }>({
      type: "PERSIST_CONVERSATION",
      owner: repo.owner,
      repo: repo.name,
      messages,
    })
      .then((resp) => dlog("repo mirror", resp?.payload))
      .catch((err) => dlog("repo mirror failed", { err: String(err) }));
  }, REPO_MIRROR_DEBOUNCE_MS) as unknown as number;
}

export async function appendMessage(msg: ChatMessage): Promise<void> {
  const stamped: ChatMessage = { ...msg, timestamp: msg.timestamp ?? Date.now() };
  history.push(stamped);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  // Paint only if the message belongs to the thread currently on screen. A reply
  // for a different thread (user switched mid-flight) updates history + storage
  // silently and appears when they switch back.
  if (messageBelongsToActive(stamped)) renderMessage(stamped);
  await persistHistory();
}

/**
 * Persist a message to ANOTHER scope's bucket (not the active one). Used when an
 * async reply lands and the user has since switched tabs: the reply belongs to
 * the conversation it was started in, so we write it directly to that scope's
 * bucket. Doesn't touch in-memory `history` or the DOM. They'll see it next time
 * loadScope runs for the originating scope (i.e. when they switch back).
 *
 * Goes through updateScopeHistory so concurrent appends to the same scope each
 * see the previous append's result and don't clobber it.
 */
export async function appendToScope(scope: Scope, msg: ChatMessage): Promise<void> {
  const stamped: ChatMessage = { ...msg, timestamp: msg.timestamp ?? Date.now() };
  await updateScopeHistory(scope, (existing) => {
    const next = [...existing, stamped];
    if (next.length > HISTORY_LIMIT) next.splice(0, next.length - HISTORY_LIMIT);
    return next.map(slimForPersist);
  });
}
