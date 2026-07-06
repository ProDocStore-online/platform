// Dictation wrapper over the browser's SpeechRecognition API.
//
// Chrome uses a cloud-backed recogniser (Google speech-to-text). No API
// key needed; internet required; the user sees a mic permission prompt
// on first use. The webkit- prefix is still the only working form in
// Chromium as of 2026, so we probe both and pick whichever is present.
//
// Not all browsers support this (Firefox notably lacks it); callers
// should check `isSupported()` and disable the mic button when false.

// Minimal type shims - SpeechRecognition isn't in lib.dom.d.ts.

interface SpeechRecognitionAlternative {
  transcript: string;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  0: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognition;

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSupported(): boolean {
  return getCtor() !== null;
}

export interface DictationOptions {
  /** Fired with the live, non-final transcript as the user speaks. */
  onInterim?: (text: string) => void;
  /** Fired once a chunk of speech is finalised. */
  onFinal?: (text: string) => void;
  /** Fired on service errors (permission, network, etc.). */
  onError?: (code: string, message: string) => void;
  /** Fired when recognition naturally stops. */
  onEnd?: () => void;
  /** BCP-47 language tag, e.g. "en-US". Default: browser locale. */
  lang?: string;
}

export interface DictationHandle {
  /** Resolves once recognition has started (or permission denial has fired). */
  start(): Promise<void> | void;
  stop(): void;
  toggle(): void;
  isActive(): boolean;
}

export function createDictation(opts: DictationOptions): DictationHandle {
  const maybeCtor = getCtor();
  if (!maybeCtor) {
    return {
      start: () =>
        opts.onError?.(
          "not-supported",
          "SpeechRecognition is not available in this browser.",
        ),
      stop: () => {},
      toggle: () =>
        opts.onError?.(
          "not-supported",
          "SpeechRecognition is not available in this browser.",
        ),
      isActive: () => false,
    };
  }
  // Rebind to a non-nullable const so TS carries the narrowing into the
  // nested buildRec function declaration (which TS otherwise treats as
  // potentially called after Ctor was reassigned, even though it isn't).
  const Ctor: SpeechRecognitionCtor = maybeCtor;

  let rec: SpeechRecognition | null = null;
  let active = false;
  // Once the user grants mic access via the getUserMedia pre-flight we
  // skip subsequent probes - SpeechRecognition.start() can use the
  // permission directly on later calls. We don't cache DENIED results:
  // the user may fix the browser permission in another tab, and the
  // re-probe will resolve immediately either way (no prompt shown
  // after denial, just another rejection), so re-trying is cheap.
  let micGranted = false;
  // Bumped each time start() runs. stop() bumps it too, which lets a
  // probe-in-flight notice it's been cancelled and bail before
  // recognition spins up. Without this, clicking mic-on then mic-off
  // during the (~tens of ms) probe window leaves recognition running
  // because rec was still null when stop() fired.
  let startCounter = 0;

  async function probeMic(): Promise<{ ok: boolean; error?: string }> {
    const log = (label: string, payload?: unknown) => {
      // Log to the side panel devtools console with a recognisable
      // prefix so it's easy to grep when diagnosing mic issues.
      console.log(`[prodocstore:mic] ${label}`, payload ?? "");
    };
    log("probeMic start", {
      micGranted,
      origin: location.origin,
      extensionId: chrome?.runtime?.id ?? "(no chrome.runtime)",
    });

    if (micGranted) {
      log("probeMic skipped (already granted this session)");
      return { ok: true };
    }
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) {
      log("mediaDevices.getUserMedia missing", {
        hasMediaDevices: !!md,
        secureContext: window.isSecureContext,
      });
      return {
        ok: false,
        error: "Microphone API not available in this browser context.",
      };
    }

    // Pre-query the permission state so we can tell apart "user has
    // never been asked" (Permissions API: prompt) from "user actively
    // denied" (Permissions API: denied) - the latter means even the
    // getUserMedia call won't surface the dialog again.
    let permState: string | null = null;
    try {
      const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
      permState = status.state;
      log("permissions.query microphone", { state: permState });
    } catch (err) {
      log("permissions.query failed", { err: String(err) });
    }

    try {
      log("getUserMedia begin");
      const stream = await md.getUserMedia({ audio: true });
      const trackInfo = stream.getTracks().map((t) => ({
        kind: t.kind,
        label: t.label,
        readyState: t.readyState,
        muted: t.muted,
      }));
      log("getUserMedia resolved", { trackInfo });
      // SpeechRecognition has its own internal audio capture; we only
      // needed this call to trigger Chrome's permission dialog. Release
      // the tracks so the OS mic indicator doesn't stay lit.
      stream.getTracks().forEach((t) => t.stop());
      micGranted = true;
      return { ok: true };
    } catch (err) {
      const name = (err as { name?: string })?.name ?? "unknown";
      const msg = err instanceof Error ? err.message : String(err);
      log("getUserMedia rejected", { name, message: msg, permState });
      if (name === "NotAllowedError" || name === "SecurityError") {
        // The side panel has its own origin (chrome-extension://<id>),
        // separate from the docs page the user is looking at. Granting
        // mic for *.pages.dev does NOT grant it for the side panel; the
        // user has to allow it for the extension origin specifically.
        // This trips people up because Chrome's address-bar mic toggle
        // applies to the docs page, not the side panel.
        const extId = chrome?.runtime?.id ?? "";
        const where = extId
          ? `chrome://settings/content/siteDetails?site=chrome-extension%3A%2F%2F${extId}`
          : "chrome://settings/content/microphone";
        const stateNote =
          permState === "denied"
            ? " (Chrome reports permission state: DENIED - this means the toggle has been explicitly set to Block somewhere)"
            : permState === "prompt"
              ? " (Chrome reports permission state: PROMPT - the dialog should have appeared; if it didn't, your browser may be suppressing prompts in extension contexts)"
              : "";
        return {
          ok: false,
          error:
            "Microphone permission isn't granted for this extension. The page's mic setting (the icon in the address bar) only covers the docs page - the side panel has its own origin. " +
            `To fix: open ${where}, set Microphone to Allow, then try again.${stateNote}`,
        };
      }
      if (name === "NotFoundError" || name === "OverconstrainedError") {
        return { ok: false, error: "No microphone found on this device." };
      }
      return { ok: false, error: `Microphone unavailable: ${msg} (name: ${name})` };
    }
  }

  function buildRec(): SpeechRecognition {
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    if (opts.lang) r.lang = opts.lang;
    r.onstart = () => {
      active = true;
    };
    r.onend = () => {
      active = false;
      opts.onEnd?.();
    };
    r.onerror = (e) => {
      active = false;
      opts.onError?.(e.error, e.message ?? "");
    };
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0]?.transcript ?? "";
        if (res.isFinal) {
          opts.onFinal?.(text);
        } else {
          interim += text;
        }
      }
      if (interim) opts.onInterim?.(interim);
    };
    return r;
  }

  const handle: DictationHandle = {
    // start() is async because the mic-permission probe is async. The
    // return value is never awaited by callers; errors are surfaced via
    // opts.onError so there's nothing to reject. Keeping the function
    // async (returning Promise<void>) lets future callers `await` it if
    // they want to know when recognition has actually spun up.
    async start() {
      if (active) return;
      // Flip `active` synchronously BEFORE the async probe. Without the
      // sync flip, a fast double-click (or hotkey twice) during the
      // probe window would fire start() twice and spawn two recognisers.
      active = true;
      const myStart = ++startCounter;

      // Pre-flight: Chrome extension side panels don't trigger the
      // mic permission dialog from SpeechRecognition.start() alone -
      // it just fails with "not-allowed". getUserMedia is the call
      // that actually surfaces the browser's permission UI.
      const probe = await probeMic();
      // If stop() was called while we were probing, abandon the start
      // before recognition spins up. Without this check, a quick on-off
      // tap leaves recognition running because rec was still null when
      // stop() fired.
      if (myStart !== startCounter) {
        active = false;
        opts.onEnd?.();
        return;
      }
      if (!probe.ok) {
        active = false;
        opts.onError?.("not-allowed", probe.error ?? "Microphone permission denied.");
        return;
      }

      rec = buildRec();
      try {
        rec.start();
      } catch (err) {
        active = false;
        rec = null;
        // Chrome throws if called while already running, or if the user
        // hasn't granted mic permission yet. Surface the message so the
        // side panel can show a useful note.
        opts.onError?.(
          "start-failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    stop() {
      // Bump the counter so any probe still in flight notices on resume
      // and bails. Without this, "start, then stop before probe resolves"
      // would let recognition run anyway.
      startCounter++;
      if (!rec) {
        // No recogniser yet (probe still in flight, or never started).
        // Flip active off so the UI updates immediately and notify the
        // caller that we're done. The pending start() will see the
        // counter change and short-circuit.
        if (active) {
          active = false;
          opts.onEnd?.();
        }
        return;
      }
      try {
        rec.stop();
      } catch {
        // Some browsers throw if stop() is called on an already-stopped
        // recogniser. Safe to ignore - onend will fire.
      }
    },
    toggle() {
      if (active) handle.stop();
      else void handle.start(); // start() never rejects; see start()'s try/catch
    },
    isActive() {
      return active;
    },
  };
  return handle;
}
