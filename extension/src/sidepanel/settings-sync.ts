// Settings sync: load the cached behaviour flags into shared state at boot, keep
// them fresh when the options page writes, and drive the compact commit-mode
// toggle. Extracted from sidepanel.ts. loadSettings() runs once at boot;
// initSettingsSync() wires the storage listener + toggle click (nothing runs at
// import time).

import type { Settings } from "../types";
import { applyTheme } from "../theme";
import { applyDebugSettings, dlog } from "./debug-bridge";
import { sendToBg } from "../lib/messaging";
import { state } from "./state";
import { commitModeToggle } from "./dom-refs";

export async function loadSettings(): Promise<void> {
  const resp = (await sendToBg({ type: "GET_SETTINGS" })) as {
    type: string;
    payload: Settings;
  };
  // Adapter (model) is chosen in Settings now, not a header dropdown.
  state.commitMode = resp.payload.commitMode ?? "pr";
  renderCommitToggle();
  applyTheme({
    theme: resp.payload.theme,
    fontSize: resp.payload.fontSize,
    compact: resp.payload.compact,
  });
  state.sendKey = resp.payload.sendKey ?? "enter";
  state.myLogin = resp.payload.claude?.githubApp?.username?.toLowerCase() ?? null;
  // Defaults-on: treat missing as true so new installs opt in to the
  // safer behaviour without needing to visit the options page first.
  state.openPrInNewTab = resp.payload.openPrInNewTab === true;
  // Defaults-on: missing means true, so new installs get the loop.
  state.autoContinue = resp.payload.autoContinue !== false;
  applyDebugSettings(resp.payload.debug);
}

// Compact commit-mode switch: one small icon button that toggles PR <-> Direct
// push (a global default, reflected wherever you Apply). Full explanation lives
// in the hover tooltip so it stays tiny in the header.
function renderCommitToggle(): void {
  const direct = state.commitMode === "direct";
  commitModeToggle.textContent = direct ? "⚡ Direct" : "⇅ PR";
  commitModeToggle.classList.toggle("direct", direct);
  commitModeToggle.setAttribute("aria-pressed", String(direct));
  commitModeToggle.title = direct
    ? "Commit mode: Direct push — Apply commits to the default branch and deploys immediately. Click to switch to Pull request."
    : "Commit mode: Pull request — Apply opens a PR for review. Click to switch to Direct push.";
}

/** Wire the storage.onChanged listener + the commit-mode toggle click. */
export function initSettingsSync(): void {
  // Settings writes from the options page fire here. Re-apply appearance and
  // refresh cached behaviour flags on the fly so users don't need to reload the
  // panel. Listen on BOTH sync and local: patchStoredSettings writes to both,
  // but when the sync write fails (over the 8KB/item quota - a full blob with API
  // keys + GitHub tokens easily hits it) the change lands ONLY in local. A
  // sync-only listener would then silently miss the update - e.g. toggling
  // "Allow remote prompt injection" would save but never take effect in the open
  // panel. Both stores carry identical content, so a double-fire is idempotent.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" && area !== "local") return;
    const next = changes["prodocstore.settings"]?.newValue as Settings | undefined;
    if (!next) return;
    applyTheme({ theme: next.theme, fontSize: next.fontSize, compact: next.compact });
    state.sendKey = next.sendKey ?? "enter";
    state.myLogin = next.claude?.githubApp?.username?.toLowerCase() ?? null;
    state.openPrInNewTab = next.openPrInNewTab === true;
    state.autoContinue = next.autoContinue !== false;
    state.commitMode = next.commitMode ?? "pr";
    renderCommitToggle();
    applyDebugSettings(next.debug);
  });

  commitModeToggle.addEventListener("click", async () => {
    state.commitMode = state.commitMode === "direct" ? "pr" : "direct";
    renderCommitToggle();
    await sendToBg({ type: "SET_SETTINGS", payload: { commitMode: state.commitMode } });
    dlog("commitMode changed", { mode: state.commitMode });
  });
}
