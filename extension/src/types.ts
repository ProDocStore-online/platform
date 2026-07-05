// Shared types across background, content, and sidepanel scripts.
//
// NavConfig + NavItem live in templates/search/scripts/lib/nav.d.ts - the
// same module the deploy-time injector consumes - so the schema can't drift
// between the extension and the build step. Re-exported here for ergonomics.

export type { NavConfig, NavItem } from "../../templates/search/scripts/lib/nav";

import type { NavConfig } from "../../templates/search/scripts/lib/nav";

/**
 * Site-level opt-in toggles, fetched from `/features.json` on the same
 * origin. Matches templates/features.schema.json in this repo. Only
 * keys explicitly set to true count as enabled - unknown or missing
 * keys are treated as off. The extension uses this read-only to show
 * which deploy features the current KB has on.
 */
export interface FeatureConfig {
  changelog?: boolean;
  sitemap?: boolean;
  pageMeta?: boolean;
  references?: boolean;
  nav?: boolean;
  search?: boolean;
}

export interface PageContext {
  url: string;
  title: string;
  /** Extracted source-path hint. Usually `docs/<basename>.html` from the URL. */
  sourcePath: string;
  /** Derived from the docs-repo meta tag (via the docs-repo meta tag). */
  repo: { owner: string; name: string } | null;
  /** Full outerHTML for the agent to reason over. */
  html: string;
  /** Just the visible text, used when the adapter prefers prose over markup. */
  text: string;
  /**
   * Site-level nav config fetched from `/nav.json` on the same origin.
   * Present when the site uses the `inject-nav` pipeline. Adapters should
   * route menu/topbar edits to `docs/nav.json`, not to the rendered HTML -
   * the topbar block is a generated artifact overwritten on every deploy.
   */
  navConfig: NavConfig | null;
  /**
   * Site-level feature flags from /features.json. Null when the KB hasn't
   * adopted the file. Consumers read only: the extension doesn't edit it
   * directly yet.
   */
  features: FeatureConfig | null;
  /**
   * Text the user highlighted on the rendered page (via the in-page
   * floating "Edit this" button), with the nearest heading for scope.
   * Null when nothing is selected. Passed to the adapter as the exact
   * change target so the agent edits only the matching source span.
   */
  selection?: { text: string; heading?: string } | null;
}

/**
 * Lifecycle of an edit task (one card on the Kanban board, one thread).
 * - proposed   : a diff is ready, waiting for the user to Apply.
 * - in_review  : Apply opened a PR; awaiting merge.
 * - deployed   : direct-pushed (or PR merged) - the change is live.
 * - done       : closed out by the user.
 * - cancelled  : the proposal was dismissed before applying.
 */
export type TaskStatus = "proposed" | "in_review" | "deployed" | "done" | "cancelled";

/** One message in a task's own thread (sub-conversation). */
export interface TaskMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /**
   * GitHub login (lowercase) of the human who wrote this turn - stamped on user
   * turns from the committing identity, so a shared/mirrored thread can show the
   * right person's avatar per message even across multiple contributors. Absent
   * on assistant (bot) turns and on pre-attribution messages.
   */
  author?: string;
}

/**
 * An edit task: every change is its own thread, surfaced as a card on the
 * board and (Phase B) a marker on the page. Stored in chrome.storage.local
 * and best-effort mirrored to .freedocstore/tasks/<id>.json so teammates and
 * Claude Code can see it.
 */
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  /** "owner/name" of the backing repo. */
  repo: string;
  /** Source file the edit targets, e.g. docs/architecture.md. */
  sourcePath: string;
  /** The published page the task was created from (for in-page markers). */
  pageUrl?: string;
  /**
   * GitHub login of the teammate who requested this edit (from the committing
   * identity at creation time). Drives the "by @user" attribution on the shared
   * board and the person filter. Set once when the task is created; preserved on
   * follow-up turns. Undefined for pre-attribution tasks.
   */
  requestedBy?: string;
  /**
   * GitHub logins (lowercase) tagged with "@login" anywhere in this thread's
   * prompts. Accumulated across turns so a teammate stays flagged. Drives the
   * "you're mentioned" highlight and filter on the shared board.
   */
  mentions?: string[];
  /** What the user highlighted, if anything. The marker anchors to this. */
  selection?: { text: string; heading?: string } | null;
  /**
   * Best-effort rendered-text anchor for the in-page highlight when the user
   * did NOT select anything: a distinctive phrase pulled from the edit's find
   * text (markdown stripped). Less precise than `selection` but lets typed
   * edits still be located on the page.
   */
  anchorText?: string;
  /**
   * User archived this edit: hide it from the active dropdown / list / board
   * without deleting the record. Orthogonal to `status` (you can archive a
   * deployed or a proposed edit alike). See the board's "Archived" filter.
   */
  archived?: boolean;
  summary: string;
  rationale?: string;
  /** Links to the live PendingProposal while status is "proposed". */
  proposalId?: string;
  pr?: { url: string; number: number };
  commit?: { url: string; sha: string };
  conversation: TaskMessage[];
  createdAt: number;
  updatedAt: number;
}

export type AdapterId = "claude" | "openai" | "github-agent" | "mcp";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** Epoch ms; set by the UI when the message is added to the transcript. */
  timestamp?: number;
  /**
   * Thread tag. Absent = the read-only "Ask" thread. Set to a task id =
   * that edit thread. A thread is a filtered view over the one scope
   * transcript (so the preview/Apply machinery is shared, not duplicated).
   */
  taskId?: string;
  /**
   * On-page selection this turn was anchored to (rendered text + nearest
   * heading), if any. Display-only: shown as a quote on the user's message so
   * you can see what was selected. Set by the side panel at submit time.
   */
  selection?: { text: string; heading?: string };
  /**
   * Whole-page context indicator for an edit turn made WITHOUT a selection -
   * the edit acted on the entire open page/source file. Display-only, shown as
   * a chip so an unselected edit's grounding is explicit. Mutually exclusive
   * with `selection`.
   */
  pageContext?: { sourcePath: string; title?: string };
  /** Optional structured payload the UI can render, e.g. a PR link. */
  attachment?: {
    kind: "pr" | "commit" | "diff" | "error" | "preview" | "preview_resolved";
    data: unknown;
  };
}

/**
 * A pending edit-file proposal stored in chrome.storage.session between
 * the moment the model proposes the change and the moment the user
 * clicks Apply (or Cancel). The side panel renders the diff from this
 * shape; APPLY_PROPOSAL replays the commit logic against it.
 */
export interface PendingEditProposal {
  kind: "edit";
  proposalId: string;
  /** The board task this proposal belongs to, so Apply/Cancel can advance it. */
  taskId?: string;
  owner: string;
  repo: string;
  /** Source path the edit targets (may differ from the page the user is on). */
  path: string;
  summary: string;
  rationale?: string;
  /** Diff information for each requested edit. The UI renders these as red/green blocks. */
  outcomes: Array<{
    find: string;
    replace: string;
    applied: boolean;
    reason?: "not_found" | "ambiguous" | "empty_find" | "invalid_replace";
  }>;
  /** The fully-edited file content - what would be committed if the user clicks Apply. */
  editedContent: string;
  /**
   * SHA of the file at fetch time. Sent to GitHub on apply; mismatch -> 409
   * conflict. `null` when CREATING a new page (the file doesn't exist yet) -
   * GitHub uses the absence of a sha to create rather than update.
   */
  fileSha: string | null;
  /** Which commit mode is currently selected. UI uses this for the Apply button label. */
  commitMode: CommitMode;
}

export interface PendingNavProposal {
  kind: "nav";
  proposalId: string;
  owner: string;
  repo: string;
  summary: string;
  rationale?: string;
  /**
   * Target nav file. Defaults to docs/nav.json (hand-authored HTML sites);
   * on generator sites this is the detected config, e.g. "mkdocs.yml". Chosen
   * by the extension (resolveNavTarget), never by the model - so a nav write
   * can only ever land on a real nav config, not arbitrary repo files.
   */
  path?: string;
  /** Current target-file content, for diffing. */
  currentContent: string;
  /** Proposed target-file content. */
  newContent: string;
  /** SHA of the target file at fetch time; null when the nav file doesn't
   * exist yet (PUT then creates it, as with a new page). */
  fileSha: string | null;
  commitMode: CommitMode;
}

/**
 * A pending addition to .docs-chat/MEMORY.md (the team-shared memory
 * file). Same preview/apply flow as edits - the side panel renders the
 * proposed entry, user approves, applyPendingProposal commits the
 * updated file.
 */
export interface PendingMemoryProposal {
  kind: "memory";
  proposalId: string;
  owner: string;
  repo: string;
  /** The new memory entry the model wants to add. */
  entry: string;
  /** ## section heading to file under (defaults to "Notes" when omitted). */
  section?: string;
  /** Current MEMORY.md content (empty when the file doesn't exist yet). */
  currentContent: string;
  /** Updated MEMORY.md content with the new entry merged in. */
  newContent: string;
  /** SHA of MEMORY.md at fetch time, or null when creating the file fresh. */
  fileSha: string | null;
  /** PR title - typically a one-liner derived from entry. */
  summary: string;
  commitMode: CommitMode;
}

export type PendingProposal =
  | PendingEditProposal
  | PendingNavProposal
  | PendingMemoryProposal;

/**
 * An Adapter turns a user prompt + page context into one or more assistant
 * messages (streamed or all-at-once) and optionally produces a real-world
 * side-effect like a PR.
 */
export interface Adapter {
  id: AdapterId;
  /** Human-readable label shown in the adapter picker. */
  label: string;
  /** Validate settings. Returns null if ready, or an error message to show. */
  configError(settings: Settings): string | null;
  /** Run a single turn. `opts.taskId` targets an existing edit thread so a
   *  follow-up edit revises that same task instead of creating a new one. */
  chat(
    prompt: string,
    context: PageContext,
    history: ChatMessage[],
    settings: Settings,
    opts?: { taskId?: string }
  ): Promise<ChatMessage>;
}

/**
 * What the agent does when you send a chat message.
 * - "read" : answer questions about the page without making changes.
 *            DEFAULT - no GitHub auth or commits required, anyone can
 *            use the extension to browse docs without signing in.
 * - "edit" : analyse the user's request, propose + apply edits, open
 *            a PR or push a commit (per CommitMode). Requires GitHub
 *            auth + write access to the target repo.
 */
export type Mode = "edit" | "read";

/**
 * Subset of the `permissions` object GitHub returns on
 * GET /repos/{owner}/{repo} for authenticated requests. Used to gate
 * Edit mode on actual write access.
 */
export interface RepoPermissions {
  push: boolean;
  admin: boolean;
  pull: boolean;
}

/**
 * How the adapter publishes a change in Edit mode.
 * - "pr"     : create a branch, commit there, open a PR (default, safe).
 * - "direct" : commit straight to the default branch. Skips review and
 *              triggers the Cloudflare Pages deploy immediately.
 */
export type CommitMode = "pr" | "direct";

/** UI theme for the sidepanel + options pages. Dark is the default. */
export type Theme = "dark" | "light";

/** Chat body font size. Scaled via a CSS custom property on <html>. */
/**
 * Chat font size in pixels. Free-form number so users can dial in their
 * preferred reading size. theme.ts clamps invalid values to a sane range.
 * Legacy "small" | "medium" | "large" strings from older installs are
 * migrated on read (see theme.ts).
 */
export type FontSize = number;

/**
 * How the prompt textarea commits a message.
 * - "enter":     Enter sends, Shift+Enter newlines (default).
 * - "mod-enter": Cmd/Ctrl+Enter sends, plain Enter newlines (IDE-like).
 */
export type SendKey = "enter" | "mod-enter";

export interface Settings {
  adapter: AdapterId;
  /**
   * Default "read". Switch to "edit" via the side-panel header when you
   * want the agent to make changes. Edit also requires write access to
   * the target repo (gated automatically when the user is signed in).
   */
  mode?: Mode;
  /** Default "pr". Direct push is fast iteration, no review. Only applies in Edit mode. */
  commitMode?: CommitMode;
  /** Default "dark". */
  theme?: Theme;
  /** Default 13 (px). Affects chat message text + the prompt textarea. */
  fontSize?: FontSize;
  /** Default false. Tightens padding/gaps in the chat for denser reading. */
  compact?: boolean;
  /** Default "enter". "mod-enter" binds Cmd/Ctrl+Enter to send. */
  sendKey?: SendKey;
  /** Default true. Open the returned PR in a new tab after success. */
  openPrInNewTab?: boolean;
  /**
   * Default true. After you Apply a change in an edit thread, auto-send a
   * short follow-up so the agent takes the NEXT step needed to finish your
   * request (e.g. adding a new page to the site menu) - a small in-thread
   * loop. Each step still shows a preview you Apply, so it's bounded by
   * your clicks. Turn off to require a manual prompt for every step.
   */
  autoContinue?: boolean;
  openai?: {
    apiKey: string;
    model: string;
    /**
     * GitHub auth reuses the same structure as the claude adapter - either
     * a PAT or a user token from the GitHub App device flow. The adapter
     * prefers the App token when both are present. Once wired up, the
     * openai adapter should share the claude block's githubApp/githubToken
     * rather than duplicating them.
     */
  };
  claude?: {
    apiKey: string;
    model: string;
    /**
     * GitHub authentication for docs commits. The adapter prefers
     * `githubApp` over `githubToken` (PAT) when both are populated.
     * Commits appear as the authenticated user either way; the App
     * path just removes manual token management.
     */
    githubToken?: string;
    githubApp?: {
      /** Public Client ID of the GitHub App - safe to ship in settings. */
      clientId: string;
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;       // ms since epoch
      /** Cached `login` from GET /user, for display in the UI. */
      username?: string;
    };
  };
  githubAgent?: {
    pat: string;
    repo: string; // owner/name
  };
  mcp?: {
    serverUrl: string;
  };
  /**
   * Local debugging bridge. When `sinkUrl` is set, the side panel POSTs
   * diagnostic events (the dlog stream) and the live conversation to that
   * endpoint best-effort. Intended for a localhost collector (e.g. the
   * freedocstore debug MCP server) so a developer - or an AI agent reading
   * the collector - has full visibility into what the extension is doing.
   * Off by default (unset).
   */
  debug?: {
    /**
     * Local diagnostics sink. MUST be a loopback URL (localhost/127.0.0.1/
     * [::1]); a remote value is ignored so page content + conversations
     * can't be exfiltrated. Off by default.
     */
    sinkUrl?: string;
    /**
     * Opt in to the REVERSE channel: let an external driver queue prompts
     * (via the collector's /inject) that the panel auto-submits. This is
     * remote control of the agent, so it's separate from sinkUrl and off
     * by default. Requires a valid loopback sinkUrl to have any effect.
     */
    allowInject?: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  adapter: "claude",
  // Read mode is the safe default - users can browse + ask questions
  // about docs without needing GitHub auth or write access. They opt
  // into Edit via the side-panel header when they want to make changes.
  mode: "read",
  theme: "dark",
  fontSize: 13,
  compact: false,
  sendKey: "enter",
  openPrInNewTab: false,
  autoContinue: true,
};

/** Messages passed between content script, sidepanel, and background. */
export type RuntimeMessage =
  | { type: "GET_PAGE_CONTEXT" }
  | { type: "PAGE_CONTEXT_RESULT"; payload: PageContext }
  // Side panel -> content script: read the page's current/pinned selection.
  // The content script answers with the highlighted text + nearest heading,
  // or null when nothing is selected. CLEAR_SELECTION drops the pin after a
  // turn is sent so the chip doesn't linger.
  | { type: "GET_SELECTION" }
  | { type: "SELECTION_RESULT"; payload: { text: string; heading?: string } | null }
  | { type: "CLEAR_SELECTION" }
  // Side panel -> content script: focus the in-page highlight on a specific
  // edit thread's section (bright outline + scroll into view), or clear the
  // focus (passive outlines for all in-progress edits remain). taskId null =
  // clear. The content script locates the section from the task's stored
  // on-page selection (rendered text + heading).
  | { type: "FOCUS_EDIT"; taskId: string | null }
  // Content script (in-page highlight's 💬 button) -> side panel: open this
  // edit's thread in the panel. The panel is already open (highlights only show
  // then), so this just switches it to that thread.
  | { type: "FOCUS_EDIT_THREAD"; taskId: string }
  // Content script -> background: is the side panel open for THIS tab's window?
  // Gates the in-page affordances (✎ button, edit badge, highlight overlays) so
  // they only appear while the panel is open. Answered from the SW's per-window
  // open-panel set (tracked via the panel's long-lived "sidepanel" port).
  | { type: "IS_PANEL_OPEN" }
  | { type: "IS_PANEL_OPEN_RESULT"; payload: { open: boolean } }
  // Background -> content script: the side panel just opened/closed for this
  // window; show or hide the in-page affordances live (no wait for a poll).
  | { type: "PANEL_STATE"; open: boolean }
  // Content script (in-page marker) -> background: open the tasks board,
  // optionally focused on a specific task / filtered to a repo.
  | { type: "OPEN_BOARD"; taskId?: string; repo?: string }
  // Side panel -> background: append a message to a task's thread. Routed
  // through the background so the task store has a single, serialized writer
  // (see lib/tasks.ts) - the panel must never write tasks directly.
  | { type: "TASK_APPEND_MESSAGE"; taskId: string; message: TaskMessage }
  // Side panel -> background: archive/unarchive an edit (hide from active
  // views without deleting). Routed through the SW for single-writer safety.
  | { type: "SET_TASK_ARCHIVED"; taskId: string; archived: boolean }
  // Side panel/board -> background: manually drive an edit's lifecycle stage
  // (Mark done, Reopen, Cancel). Lets the user move a task the automatic
  // apply/PR transitions can't - e.g. a merged PR -> Done, or reopen a cancel.
  | { type: "SET_TASK_STATUS"; taskId: string; status: TaskStatus }
  | { type: "TASK_RESULT"; payload: { task: Task | null } }
  // `mode` overrides settings.mode for this one turn (Ask thread forces
  // "read"). `taskId` targets an EXISTING edit thread so a follow-up edit
  // revises that same task/file instead of minting a new one.
  | {
      type: "CHAT_TURN";
      prompt: string;
      context: PageContext;
      history: ChatMessage[];
      mode?: Mode;
      taskId?: string;
    }
  | { type: "CHAT_TURN_RESULT"; payload: ChatMessage }
  | { type: "GET_SETTINGS" }
  | { type: "SETTINGS_RESULT"; payload: Settings }
  | { type: "SET_SETTINGS"; payload: Partial<Settings> }
  | { type: "CHECK_PERMISSIONS"; owner: string; repo: string }
  | { type: "PERMISSIONS_RESULT"; payload: RepoPermissions | null }
  | { type: "APPLY_PROPOSAL"; proposalId: string }
  | { type: "CANCEL_PROPOSAL"; proposalId: string }
  | { type: "PROPOSAL_RESULT"; payload: ChatMessage }
  | { type: "READ_REPO_FILE"; owner: string; repo: string; path: string }
  | { type: "READ_REPO_FILE_RESULT"; payload: { content: string } | { error: string } }
  // Mirror the current scope's conversation into .freedocstore/chat/ in the
  // backing repo. Best-effort: the background no-ops (ok:false) when the
  // user isn't signed in to GitHub. The side panel fires this debounced
  // after a turn; it does not block the chat UI on the result.
  | { type: "PERSIST_CONVERSATION"; owner: string; repo: string; messages: ChatMessage[] }
  | { type: "PERSIST_CONVERSATION_RESULT"; payload: { ok: true; commitUrl: string } | { ok: false; error: string } }
  // Sent by the background's onMessage error envelope. Any handler
  // throw is converted to this so the sidepanel doesn't crash on a
  // missing response. Payload is shaped like a ChatMessage so callers
  // can render it in the transcript.
  | { type: "ERROR_RESULT"; payload: ChatMessage };
