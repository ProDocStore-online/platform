// Pure helpers for settings persistence + the chrome.storage wrappers
// that everything in the extension should route through. Pure helpers
// (mergeSettings, hydrate) are tested directly; the storage wrappers
// rely on chrome.* and are exercised end to end via the extension.

import { DEFAULT_SETTINGS } from "./types";
import type { Settings } from "./types";

/**
 * Single key all chrome.storage.sync writes touch. Exported so callers
 * that need to clear or migrate can reference the same string we use
 * everywhere else.
 */
export const SETTINGS_KEY = "freedocstore.settings";

/**
 * Deep-merge a patch into existing settings.
 *
 * One level deep is enough for our shape - `Settings` has top-level
 * scalars (`adapter`) and one level of per-adapter objects (`claude`,
 * `openai`, ...). A shallow spread would wipe sibling fields within
 * an adapter block when the user only updates one of them.
 */
export function mergeSettings(current: Settings, patch: Partial<Settings>): Settings {
  const out: Settings = { ...current };

  for (const key of Object.keys(patch) as (keyof Settings)[]) {
    const patchValue = patch[key];
    if (patchValue === undefined) continue;

    const currentValue = current[key];
    const sink = out as unknown as Record<string, unknown>;
    if (isPlainObject(currentValue) && isPlainObject(patchValue)) {
      // One level of merge; sibling fields preserved.
      sink[key] = {
        ...(currentValue as Record<string, unknown>),
        ...(patchValue as Record<string, unknown>),
      };
    } else {
      sink[key] = patchValue;
    }
  }

  return out;
}

/**
 * Sibling stamp written next to the settings on every save. loadStoredSettings
 * uses it to pick the FRESHER of the sync/local copies. Without it, a save
 * where sync.set() fails (over the 8KB/item quota - a full blob with API keys
 * + GitHub tokens easily hits it) but sync.get() still returns the last stale
 * value would be read sync-first forever: the new value lands only in local
 * and is never seen. That's the "it won't save" bug. Stripped from the result.
 */
const STAMP_KEY = "_savedAt";
type Stamped = Partial<Settings> & { _savedAt?: number };

/** Start from defaults and merge stored settings on top. */
export function hydrate(stored: Partial<Settings> | null | undefined): Settings {
  if (isPlainObject(stored)) {
    // Drop the bookkeeping stamp so it never leaks into the live Settings
    // object (and can't be re-persisted as if it were a real field).
    const { [STAMP_KEY]: _omit, ...rest } = stored as Stamped;
    return mergeSettings(DEFAULT_SETTINGS, rest);
  }
  return mergeSettings(DEFAULT_SETTINGS, stored ?? {});
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read settings from chrome.storage.sync, applying defaults for any
 * missing fields. Use this everywhere instead of touching
 * chrome.storage.sync.get directly so the storage key + hydrate logic
 * stays in one place.
 */
async function readRaw(area: chrome.storage.StorageArea): Promise<Stamped | null> {
  try {
    const got = await area.get(SETTINGS_KEY);
    return (got[SETTINGS_KEY] as Stamped) ?? null;
  } catch {
    return null; // area disabled / unavailable
  }
}

/**
 * Pick the fresher of the two stored blobs by save stamp. A strict `>` means
 * ties fall to sync, keeping it authoritative for cross-device on a normal
 * save (both stamped identically). Only when local is STRICTLY newer - a sync
 * write that failed while local's succeeded - does local win.
 */
function fresher(sync: Stamped | null, local: Stamped | null): Stamped | null {
  if (!sync) return local;
  if (!local) return sync;
  return (local._savedAt ?? 0) > (sync._savedAt ?? 0) ? local : sync;
}

export async function loadStoredSettings(): Promise<Settings> {
  const [sync, local] = await Promise.all([
    readRaw(chrome.storage.sync),
    readRaw(chrome.storage.local),
  ]);
  return hydrate(fresher(sync, local));
}

/**
 * Deep-merge a partial settings patch into whatever's currently in
 * chrome.storage.sync, then persist. Returns the post-merge result.
 *
 * This is the ONLY safe way to update settings from anywhere in the
 * extension - direct chrome.storage.sync.set calls would do a shallow
 * write and clobber sibling fields (e.g. wiping the GitHub App tokens
 * when only the OpenAI key was meant to change).
 */
export async function patchStoredSettings(patch: Partial<Settings>): Promise<Settings> {
  const [syncRaw, localRaw] = await Promise.all([
    readRaw(chrome.storage.sync),
    readRaw(chrome.storage.local),
  ]);
  const current = hydrate(fresher(syncRaw, localRaw));
  const next = mergeSettings(current, patch);
  // Stamp the persisted copy so loadStoredSettings can tell which store is
  // freshest (see STAMP_KEY). Derive the stamp as strictly greater than any
  // prior one, so two saves within the same clock millisecond (Date.now()
  // resolution) still order correctly - otherwise a same-ms sync-write-fail
  // would tie and wrongly resolve to the stale sync copy. Both writes carry
  // the SAME stamp; whichever store accepts the write wins the next read.
  const prevMax = Math.max(syncRaw?._savedAt ?? 0, localRaw?._savedAt ?? 0);
  const stamped: Stamped = { ...next, [STAMP_KEY]: Math.max(Date.now(), prevMax + 1) };
  // Write to sync (cross-device) AND local (durable fallback). If sync throws -
  // over quota, disabled, or rate-limited - the settings still persist locally
  // instead of being silently lost, which is what made "font size didn't save"
  // possible. As long as ONE store accepts the write, the save succeeds.
  let saved = false;
  try {
    await chrome.storage.sync.set({ [SETTINGS_KEY]: stamped });
    saved = true;
  } catch {
    /* sync full/disabled - the local write below is the fallback */
  }
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: stamped });
    saved = true;
  } catch {
    /* local failed too */
  }
  if (!saved) throw new Error("Couldn't save settings: browser storage is unavailable.");
  return next;
}
