// The "⋯" menu's chat-wide actions: Clear chat (two-click confirm) and Copy
// chat (full diagnostic dump to the clipboard). Extracted from sidepanel.ts;
// wired at boot via initChatActions(). disarmClear is exported because the
// pop-menu close hook disarms the two-click Clear whenever a menu closes.

import type { Settings } from "../types";
import { buildSessionDump } from "./session-dump";
import { formatTime } from "./format";
import { getActiveTabContext } from "./tab-messaging";
import { dlog, getLogBuffer, clearLog } from "./debug-bridge";
import { sendToBg } from "../lib/messaging";
import { proposalKeysFor, writeScopeHistory } from "../lib/history";
import { clearChatBtn, copyChatBtn, messagesEl } from "./dom-refs";
import { bumpTurnId, history, scrollByScope, state } from "./state";

const CLEAR_TITLE =
  "Clear the chat on this device. The copy saved to GitHub (freedocstore-chat branch) is not removed — see Options for how to clear that.";

/** Reset the two-click Clear confirm (called on menu close via the pop hook). */
export function disarmClear(): void {
  state.clearArmed = false;
  clearChatBtn.classList.remove("armed");
  clearChatBtn.title = CLEAR_TITLE;
  if (state.clearArmTimer != null) {
    clearTimeout(state.clearArmTimer);
    state.clearArmTimer = null;
  }
}

async function clearChat(e: MouseEvent): Promise<void> {
  if (history.length === 0 && getLogBuffer().length === 0) return;
  if (!state.clearArmed) {
    state.clearArmed = true;
    clearChatBtn.classList.add("armed");
    clearChatBtn.title = `Click again to clear ${history.length} message(s)`;
    state.clearArmTimer = window.setTimeout(disarmClear, 3000);
    // Clear now lives in the "⋯" overflow menu; keep the menu open on the
    // arming click so the "click again to clear" state is actually visible
    // (a bubbling click would close it via closeAllPopMenus). The confirming
    // click below is allowed to bubble, dismissing the menu.
    e.stopPropagation();
    return;
  }
  disarmClear();
  // Snapshot scope synchronously before any await. Without this, an in-flight
  // loadScope (from a tab-switch listener) could resolve between our wipes and
  // the persist, mutating `history` and `state.currentScope` to the new scope -
  // then we'd delete the WRONG scope's bucket and the WRONG scope's stashed log.
  const scope = state.currentScope;

  // Bump turn + load IDs so any CHAT_TURN reply or loadScope already in flight
  // gets dropped instead of landing in the now-empty transcript. Only THIS
  // scope's turn id; other scopes' in-flight requests are not affected
  // (Clear-on-A must not invalidate B's pending reply).
  bumpTurnId(scope);
  state.activeLoadId++;

  // Capture the proposal IDs owned by this scope's messages BEFORE we wipe
  // history. We only delete proposals tied to this conversation, leaving other
  // sites' pending previews intact.
  const proposalKeys = proposalKeysFor(history);

  history.length = 0;
  clearLog(scope);
  scrollByScope.delete(scope);
  messagesEl.innerHTML = "";
  // Persist directly to the snapshotted scope so a mid-flight loadScope can't
  // redirect the deletion. writeScopeHistory deletes the bucket when empty.
  await writeScopeHistory(scope, []);

  if (proposalKeys.length) {
    try {
      await chrome.storage.session.remove(proposalKeys);
      dlog("cleared scoped proposals", { scope, count: proposalKeys.length });
    } catch (err) {
      dlog("scoped-proposal cleanup skipped", { err: String(err) });
    }
  }
  dlog("history cleared", { scope });
}

async function copyChat(): Promise<void> {
  const ctx = await getActiveTabContext();
  const settingsResp = (await sendToBg({ type: "GET_SETTINGS" })) as {
    type: string;
    payload: Settings;
  };
  const text = buildSessionDump({
    ctx,
    settings: settingsResp.payload,
    history,
    logBuffer: getLogBuffer(),
    formatTime,
  });
  try {
    await navigator.clipboard.writeText(text);
    const original = copyChatBtn.textContent;
    copyChatBtn.textContent = "✓"; // check mark
    setTimeout(() => (copyChatBtn.textContent = original), 1200);
  } catch {
    // Clipboard API can be blocked in some contexts. Surface as a transient
    // label flip on the button itself - DO NOT append to history (that would
    // persist a UI error across sessions and pollute the next dump).
    const original = copyChatBtn.textContent;
    copyChatBtn.textContent = "✗"; // X mark
    copyChatBtn.title = "Clipboard blocked - try again or open devtools";
    setTimeout(() => {
      copyChatBtn.textContent = original;
      copyChatBtn.title = "Copy full chat to clipboard";
    }, 2000);
    dlog("clipboard write failed");
  }
}

/** Wire the Clear / Copy chat buttons. Call once at boot. */
export function initChatActions(): void {
  clearChatBtn.addEventListener("click", (e) => void clearChat(e));
  copyChatBtn.addEventListener("click", () => void copyChat());
}
