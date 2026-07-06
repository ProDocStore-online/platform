// Options page: full configuration UI. Reads/writes through the
// background service worker so storage logic (deep-merge, defaults,
// key namespacing) stays in one place.

import type { SendKey, Settings, Theme } from "../types";
import {
  startDeviceFlow,
  pollForToken,
  fetchAuthenticatedUser,
} from "../auth/github-device";
import { DEFAULT_GITHUB_APP_CLIENT_ID } from "../config";
import { applyTheme, resolveFontSize, FONT_SIZE_DEFAULT } from "../theme";
import { ADDONS } from "../lib/addons";
import { isLoopbackSinkUrl } from "../lib/debug-safety";
import { $, $$ } from "../lib/dom";
import { sendToBg } from "../lib/messaging";

const form = $<HTMLFormElement>("#options-form");
const saveStatus = $("#save-status");

// Per-field refs.
const adapterSelect = $<HTMLSelectElement>("#adapter-select");
const apiKey = $<HTMLInputElement>("#claude-api-key");
const model = $<HTMLSelectElement>("#claude-model");
const ghToken = $<HTMLInputElement>("#claude-github-token");
const ghClientId = $<HTMLInputElement>("#gh-client-id");
const openaiApiKey = $<HTMLInputElement>("#openai-api-key");
const openaiModel = $<HTMLSelectElement>("#openai-model");
const resetBtn = $<HTMLButtonElement>("#reset-btn");
const micSettingsBtn = $<HTMLButtonElement>("#mic-settings-btn");
const commitModePr = $<HTMLInputElement>("#commit-mode-pr");
const commitModeDirect = $<HTMLInputElement>("#commit-mode-direct");
const themeDark = $<HTMLInputElement>("#theme-dark");
const themeLight = $<HTMLInputElement>("#theme-light");
const fontSizeInput = $<HTMLInputElement>("#font-size");
const compactCheckbox = $<HTMLInputElement>("#compact");
const sendKeySelect = $<HTMLSelectElement>("#send-key");
const openPrCheckbox = $<HTMLInputElement>("#open-pr-in-new-tab");
const autoContinueCheckbox = $<HTMLInputElement>("#auto-continue");
const debugSinkUrl = $<HTMLInputElement>("#debug-sink-url");
const debugAllowInject = $<HTMLInputElement>("#debug-allow-inject");

// ── Tabs ─────────────────────────────────────────────────────────────
// The page outgrew a single scroll, so settings are grouped into tabs.
// The Save button lives outside the panels and persists every field
// regardless of which tab is showing.
const tabButtons = $$<HTMLButtonElement>(".tab");
const tabPanels = $$<HTMLElement>(".tab-panel");
function showTab(name: string): void {
  for (const b of tabButtons) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const p of tabPanels) p.hidden = p.dataset.panel !== name;
}
for (const b of tabButtons) {
  b.addEventListener("click", () => showTab(b.dataset.tab ?? "general"));
}
showTab("general");

// GitHub auth UI.
const ghStatus = $("#gh-status");
const ghSignin = $<HTMLButtonElement>("#gh-signin");
const ghSignout = $<HTMLButtonElement>("#gh-signout");
const ghDevice = $("#gh-device") as HTMLElement;
const ghUserCode = $("#gh-user-code");
const ghVerificationUri = $<HTMLAnchorElement>("#gh-verification-uri");
const ghCopyCode = $<HTMLButtonElement>("#gh-copy-code");
const ghDeviceStatus = $("#gh-device-status");
const ghCancel = $<HTMLButtonElement>("#gh-cancel");

let deviceFlowAbort: AbortController | null = null;

async function loadIntoForm() {
  const resp = (await sendToBg({ type: "GET_SETTINGS" })) as {
    type: string;
    payload: Settings;
  };
  const s = resp.payload;

  const mode = s.commitMode ?? "pr";
  commitModePr.checked = mode === "pr";
  commitModeDirect.checked = mode === "direct";

  const theme: Theme = s.theme ?? "dark";
  themeDark.checked = theme === "dark";
  themeLight.checked = theme === "light";
  fontSizeInput.value = String(resolveFontSize(s.fontSize));
  compactCheckbox.checked = s.compact ?? false;
  sendKeySelect.value = s.sendKey ?? "enter";
  // Defaults-on checkboxes: treat missing as true so new installs opt in.
  openPrCheckbox.checked = s.openPrInNewTab === true;
  autoContinueCheckbox.checked = s.autoContinue !== false;

  // Apply immediately so the options page itself honours the loaded choice.
  applyTheme({ theme, fontSize: s.fontSize, compact: s.compact });

  adapterSelect.value = s.adapter ?? "claude";
  apiKey.value = s.claude?.apiKey ?? "";
  model.value = s.claude?.model ?? "claude-sonnet-4-6";
  ghToken.value = s.claude?.githubToken ?? "";
  // Stored override wins; otherwise show the baked-in default (or empty
  // when no default is configured yet).
  ghClientId.value = s.claude?.githubApp?.clientId ?? DEFAULT_GITHUB_APP_CLIENT_ID;

  openaiApiKey.value = s.openai?.apiKey ?? "";
  openaiModel.value = s.openai?.model ?? "gpt-5.4";

  debugSinkUrl.value = s.debug?.sinkUrl ?? "";
  debugAllowInject.checked = !!s.debug?.allowInject;

  renderAuthStatus(s);
}

function renderAuthStatus(s: Settings) {
  const app = s.claude?.githubApp;
  if (app?.accessToken) {
    ghStatus.textContent = `Signed in as @${app.username ?? "unknown"}`;
    ghStatus.className = "auth-status ok";
    ghSignin.hidden = true;
    ghSignout.hidden = false;
  } else if (s.claude?.githubToken) {
    ghStatus.textContent = "Using personal access token (PAT).";
    ghStatus.className = "auth-status";
    ghSignin.hidden = false;
    ghSignout.hidden = true;
  } else {
    ghStatus.textContent = "Not signed in. Sign in via the GitHub App or paste a PAT below.";
    ghStatus.className = "auth-status";
    ghSignin.hidden = false;
    ghSignout.hidden = true;
  }
}

function setStatus(text: string, kind: "ok" | "err" | "" = "") {
  saveStatus.textContent = text;
  saveStatus.className = `save-status${kind ? " " + kind : ""}`;
}

function setDeviceStatus(text: string, kind: "" | "err" = "") {
  ghDeviceStatus.textContent = text;
  ghDeviceStatus.className = `device-status${kind ? " " + kind : ""}`;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus("Saving\u2026");

  // Preserve the existing githubApp block so we don't wipe stored tokens
  // just because the user saved other settings.
  const current = ((await sendToBg({ type: "GET_SETTINGS" })) as {
    type: string;
    payload: Settings;
  }).payload;

  const theme: Theme = themeLight.checked ? "light" : "dark";
  // Parse freely, then clamp/fallback so an empty or bogus value becomes
  // the default rather than blowing up layout.
  const fontSize = fontSizeInput.value.trim() === ""
    ? FONT_SIZE_DEFAULT
    : resolveFontSize(fontSizeInput.value);
  fontSizeInput.value = String(fontSize);
  const compact = compactCheckbox.checked;
  const sendKey = sendKeySelect.value as SendKey;
  const openPrInNewTab = openPrCheckbox.checked;
  const autoContinue = autoContinueCheckbox.checked;

  // Debug sink: reject a non-loopback URL up front so the user gets a clear
  // message instead of silently-ignored diagnostics. Empty is fine (off).
  const sinkRaw = debugSinkUrl.value.trim();
  if (sinkRaw && !isLoopbackSinkUrl(sinkRaw)) {
    setStatus("Debug sink URL must be loopback (localhost / 127.0.0.1).", "err");
    return;
  }
  // Apply locally before persisting so the options page flips instantly
  // even if storage.onChanged is slow to fire for same-page writes.
  applyTheme({ theme, fontSize, compact });

  const patch: Partial<Settings> = {
    adapter: adapterSelect.value as Settings["adapter"],
    commitMode: commitModeDirect.checked ? "direct" : "pr",
    theme,
    fontSize,
    compact,
    sendKey,
    openPrInNewTab,
    autoContinue,
    claude: {
      apiKey: apiKey.value.trim(),
      model: model.value,
      githubToken: ghToken.value.trim() || undefined,
      githubApp: {
        ...(current.claude?.githubApp ?? {}),
        clientId: ghClientId.value.trim(),
      },
    },
    openai: {
      apiKey: openaiApiKey.value.trim(),
      model: openaiModel.value,
    },
    // Empty string -> undefined so a blank field cleanly disables the sink
    // rather than persisting "" and short-circuiting every postDebug check.
    // allowInject only matters with a sink, but persist the intent as-is.
    debug: {
      sinkUrl: sinkRaw || undefined,
      allowInject: debugAllowInject.checked,
    },
  };

  try {
    await sendToBg({ type: "SET_SETTINGS", payload: patch });
    setStatus("Saved.", "ok");
  } catch (err) {
    setStatus(`Save failed: ${String(err)}`, "err");
  }

  setTimeout(() => setStatus(""), 3000);
});

// Two-click confirm pattern: first click swaps the label and arms the
// button; second click within 3s actually runs the destructive action.
// Avoids OS-level confirm() dialogs which interrupt the page.
function confirmOnNextClick(btn: HTMLButtonElement, armedLabel: string): boolean {
  if (btn.dataset.armed === "1") {
    btn.dataset.armed = "";
    btn.textContent = btn.dataset.originalLabel ?? "";
    btn.classList.remove("armed");
    return true;
  }
  btn.dataset.armed = "1";
  btn.dataset.originalLabel = btn.textContent ?? "";
  btn.textContent = armedLabel;
  btn.classList.add("armed");
  setTimeout(() => {
    if (btn.dataset.armed !== "1") return;
    btn.dataset.armed = "";
    btn.textContent = btn.dataset.originalLabel ?? "";
    btn.classList.remove("armed");
  }, 3000);
  return false;
}

resetBtn.addEventListener("click", async () => {
  if (!confirmOnNextClick(resetBtn, "Click again to wipe everything")) return;
  // Clear BOTH stores. Settings are mirrored to local (durable fallback for
  // when sync is over quota/disabled), so removing only sync would leave the
  // local copy behind - loadStoredSettings would read it straight back and the
  // "reset" would silently un-happen. allSettled so a disabled sync area
  // doesn't abort the local wipe (or vice versa).
  await Promise.allSettled([
    chrome.storage.sync.remove("prodocstore.settings"),
    chrome.storage.local.remove("prodocstore.settings"),
  ]);
  await loadIntoForm();
  setStatus("Cleared.", "ok");
  setTimeout(() => setStatus(""), 3000);
});

// One-click jump to Chrome's microphone toggle for THIS extension.
// chrome:// URLs can't be opened from a normal anchor click, so we go
// through chrome.tabs.create. The path is the canonical
// site-details URL Chrome itself uses; setting Microphone to Allow
// there grants the extension origin so the side panel's dictation
// works (the address-bar mic toggle only covers the docs page).
micSettingsBtn.addEventListener("click", () => {
  const id = chrome.runtime.id;
  void chrome.tabs.create({
    url: `chrome://settings/content/siteDetails?site=chrome-extension%3A%2F%2F${id}`,
  });
});

// ── GitHub App device flow ─────────────────────────────────────────

ghSignin.addEventListener("click", async () => {
  // Use whatever is in the field (which starts as the baked-in default),
  // or fall back directly to the default if it was cleared.
  const clientId = ghClientId.value.trim() || DEFAULT_GITHUB_APP_CLIENT_ID;
  if (!clientId) {
    setStatus(
      "No GitHub App Client ID configured. Edit extension/src/config.ts to bake in a default, or paste one into the field above.",
      "err"
    );
    ghClientId.focus();
    return;
  }

  // Persist the Client ID immediately so the user doesn't have to click
  // Save first. This saves only the clientId field; the rest of the form
  // keeps its unsaved state.
  await sendToBg({
    type: "SET_SETTINGS",
    payload: {
      claude: { ...(await currentClaudeBlock()), githubApp: { clientId } },
    },
  });

  ghSignin.disabled = true;
  ghDevice.hidden = false;
  setDeviceStatus("Requesting code\u2026");
  deviceFlowAbort = new AbortController();

  try {
    const start = await startDeviceFlow(clientId);
    ghUserCode.textContent = start.userCode;
    // Only ever assign an https URL to the anchor / open it (the value comes
    // from a network response; guard against a javascript:/data: scheme).
    const httpsUri = /^https:\/\//i.test(start.verificationUri) ? start.verificationUri : "";
    ghVerificationUri.href = httpsUri;
    ghVerificationUri.textContent = start.verificationUri.replace(/^https?:\/\//, "");

    // Open the pre-filled URL in a new tab so the user skips the "paste
    // the code" step - GitHub jumps straight to Authorize.
    if (start.verificationUriComplete && /^https:\/\//i.test(start.verificationUriComplete)) {
      chrome.tabs.create({ url: start.verificationUriComplete, active: true });
    }

    setDeviceStatus("Opened GitHub in a new tab. Waiting for you to authorize\u2026");

    const token = await pollForToken(
      clientId,
      start.deviceCode,
      start.interval,
      deviceFlowAbort.signal
    );

    setDeviceStatus("Fetching user info\u2026");
    const username = await fetchAuthenticatedUser(token.accessToken);

    // Persist via settings merge so sibling fields in claude block survive.
    await sendToBg({
      type: "SET_SETTINGS",
      payload: {
        claude: {
          ...(await currentClaudeBlock()),
          githubApp: {
            clientId,
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            expiresAt: token.expiresAt,
            username,
          },
        },
      },
    });

    ghDevice.hidden = true;
    await loadIntoForm();
    setStatus(`Signed in as @${username}.`, "ok");
    setTimeout(() => setStatus(""), 4000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setDeviceStatus(msg, "err");
  } finally {
    ghSignin.disabled = false;
    deviceFlowAbort = null;
  }
});

ghCancel.addEventListener("click", () => {
  deviceFlowAbort?.abort();
  ghDevice.hidden = true;
});

ghCopyCode.addEventListener("click", async () => {
  const code = ghUserCode.textContent ?? "";
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    ghCopyCode.textContent = "Copied";
    setTimeout(() => (ghCopyCode.textContent = "Copy"), 1500);
  } catch {
    // Clipboard can fail in some frames; silently no-op.
  }
});

ghSignout.addEventListener("click", async () => {
  if (!confirmOnNextClick(ghSignout, "Click again to sign out")) return;
  const claude = await currentClaudeBlock();
  const next = {
    ...claude,
    githubApp: claude.githubApp ? { clientId: claude.githubApp.clientId } : undefined,
  };
  await sendToBg({
    type: "SET_SETTINGS",
    payload: { claude: next },
  });
  await loadIntoForm();
  setStatus("Signed out.", "ok");
  setTimeout(() => setStatus(""), 3000);
});

async function currentClaudeBlock() {
  const resp = (await sendToBg({ type: "GET_SETTINGS" })) as {
    type: string;
    payload: Settings;
  };
  return resp.payload.claude ?? { apiKey: "", model: "claude-sonnet-4-6" };
}

/**
 * Copy `text` to the clipboard and flash the source button so the user
 * sees confirmation. Tolerates the rare case where clipboard write is
 * blocked (e.g. opening the options page in a context Chrome doesn't
 * grant clipboard-write to) by surfacing a fallback label.
 */
async function copyPrompt(btn: HTMLButtonElement, text: string): Promise<void> {
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "\u2713 copied";
    btn.classList.add("copied");
  } catch {
    btn.textContent = "\u2717 copy blocked";
    btn.classList.add("copy-failed");
  }
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove("copied", "copy-failed");
  }, 1200);
}

/**
 * Render the read-only catalog of available add-ons. Per VISION.md the
 * UI deliberately omits any copy-paste config snippets - it tells the
 * user WHAT to ask the agent for, not HOW to hand-edit features.json.
 * Each ask-the-agent prompt is rendered as a clickable chip that
 * copies that exact text to the clipboard for pasting into chat.
 */
function renderAddons() {
  const list = document.getElementById("addons-list");
  if (!list) return;
  list.replaceChildren();
  for (const a of ADDONS) {
    const li = document.createElement("li");
    li.className = "addon";

    const head = document.createElement("div");
    head.className = "addon-head";
    const name = document.createElement("strong");
    name.textContent = a.name;
    const key = document.createElement("code");
    key.textContent = a.key;
    head.append(name, document.createTextNode(" "), key);
    li.appendChild(head);

    const desc = document.createElement("div");
    desc.className = "addon-desc";
    desc.textContent = a.description;
    li.appendChild(desc);

    const generates = document.createElement("div");
    generates.className = "addon-generates";
    generates.textContent = `Adds: ${a.generates}`;
    li.appendChild(generates);

    if (a.askPrompts.length) {
      const ask = document.createElement("div");
      ask.className = "addon-ask";
      const label = document.createElement("span");
      label.className = "addon-ask-label";
      label.textContent = "Ask the agent:";
      ask.appendChild(label);
      for (const p of a.askPrompts) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "addon-prompt";
        chip.title = "Copy this prompt to the clipboard";
        chip.textContent = `"${p}"`;
        chip.addEventListener("click", () => {
          void copyPrompt(chip, p);
        });
        ask.appendChild(chip);
      }
      li.appendChild(ask);
    }

    list.appendChild(li);
  }
}

renderAddons();
void loadIntoForm();
