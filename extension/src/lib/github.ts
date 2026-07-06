// Minimal GitHub REST helpers. Hand-rolled fetch instead of pulling in
// @octokit/rest - we use 5 endpoints and bundle size matters for a
// browser extension.
//
// Auth: prefers the GitHub App user-to-server token (settings.claude.githubApp);
// falls back to a PAT. All operations act AS the authenticated user,
// so commits are attributed correctly.

import type { Settings, RepoPermissions } from "../types";
import { refreshAccessToken, type GitHubToken } from "../auth/github-device";
import { DEFAULT_GITHUB_APP_CLIENT_ID } from "../config";
import { loadStoredSettings, patchStoredSettings } from "../settings";

const API = "https://api.github.com";

// Single-flight guard for GitHub App token refresh. Refresh tokens are
// single-use (rotating): the first refresh consumes the token and returns a
// new one, so two concurrent refreshes with the SAME token race and the loser
// gets `invalid_grant`. In the service worker (one JS context shared by every
// GitHubClient instance) a panel open fires CHECK_PERMISSIONS + memory +
// activity fetches at once, each building its own client near token expiry -
// exactly the burst that races. Dedupe by refresh token so all concurrent
// callers await ONE network refresh and receive the same rotated token.
const inFlightRefresh = new Map<string, Promise<GitHubToken>>();

function coordinatedRefresh(clientId: string, refreshToken: string): Promise<GitHubToken> {
  const existing = inFlightRefresh.get(refreshToken);
  if (existing) return existing;
  const p = refreshAccessToken(clientId, refreshToken).finally(() => {
    inFlightRefresh.delete(refreshToken);
  });
  inFlightRefresh.set(refreshToken, p);
  return p;
}

export interface GitHubFile {
  content: string;
  sha: string;
  path: string;
}

export interface DefaultBranchInfo {
  name: string;
  sha: string;
}

export interface PullRequest {
  number: number;
  url: string;
  html_url: string;
}

export interface CommitInfo {
  sha: string;
  html_url: string;
}

export interface RecentCommit {
  sha: string;
  /** ISO 8601 commit author date, as returned by GitHub. */
  date: string;
  /** GitHub login when the commit author has a linked GH account; git author name otherwise. */
  author: string;
  /** First line of the commit message. */
  message: string;
}

/**
 * Persist a refreshed GitHub App token through the centralised settings
 * helper. mergeSettings only deep-merges one level, so we hand-merge the
 * githubApp block here (preserving username + clientId) before sending
 * the whole claude block as the patch. Goes through patchStoredSettings
 * so sibling top-level fields (commitMode, openai) survive a
 * concurrent options-page save.
 */
async function persistAppToken(appCtx: AppCtx, expiresAt: number): Promise<void> {
  const current = await loadStoredSettings();
  // The caller only invokes this when an App token exists, so the claude
  // block is present. Type-check guard for completeness.
  if (!current.claude) return;
  await patchStoredSettings({
    claude: {
      ...current.claude,
      githubApp: {
        ...(current.claude.githubApp ?? { clientId: appCtx.clientId }),
        accessToken: appCtx.accessToken,
        refreshToken: appCtx.refreshToken,
        expiresAt,
      },
    },
  });
}

/**
 * App-token context kept in the client closure so we can refresh on 401
 * without going back to chrome.storage. PAT users have appCtx === null.
 */
interface AppCtx {
  clientId: string;
  refreshToken: string;
  /** Mutable: updated in place when we refresh. */
  accessToken: string;
}

export class GitHubClient {
  private constructor(
    private cachedToken: string,
    private appCtx: AppCtx | null,
    // The signed-in user's GitHub login (from the cached GET /user), or null
    // for a bare PAT with no cached login. Used to attribute tasks to the
    // teammate who created them (requestedBy).
    readonly login: string | null = null,
  ) {}

  static async fromSettings(settings: Settings): Promise<GitHubClient> {
    const pat = settings.claude?.githubToken;
    const app = settings.claude?.githubApp;
    if (!pat && !app?.accessToken) {
      throw new Error("GitHub not connected - sign in with GitHub or paste a PAT");
    }

    const appCtx: AppCtx | null = app?.accessToken && app.refreshToken
      ? {
          clientId: app.clientId || DEFAULT_GITHUB_APP_CLIENT_ID,
          refreshToken: app.refreshToken,
          accessToken: app.accessToken,
        }
      : null;

    let token = app?.accessToken ?? pat ?? "";

    // Proactive refresh: if the App token is within a minute of expiry,
    // swap it now to avoid burning a request just to discover the 401.
    if (appCtx && app?.expiresAt && app.expiresAt < Date.now() + 60_000) {
      const fresh = await coordinatedRefresh(appCtx.clientId, appCtx.refreshToken);
      token = fresh.accessToken;
      appCtx.accessToken = fresh.accessToken;
      appCtx.refreshToken = fresh.refreshToken ?? appCtx.refreshToken;
      await persistAppToken(appCtx, fresh.expiresAt);
    }

    return new GitHubClient(token, appCtx, app?.username ?? null);
  }

  /**
   * Stable, non-secret identifier for the current credential. Used by
   * caches that need to invalidate across auth changes: when the user
   * signs out of one account and into another, the fingerprint changes
   * and any cache keyed by it transparently misses (cross-account leak
   * fix). Last 12 chars of the token is enough entropy for cache keying
   * (not security) and avoids logging the full secret if a cache key
   * ever ends up in an error message.
   */
  authFingerprint(): string {
    const t = this.cachedToken;
    return t.length > 12 ? t.slice(-12) : t;
  }

  private async refreshAndCache(): Promise<string> {
    if (!this.appCtx) throw new Error("Cannot refresh: not authenticated via GitHub App");
    // Close the sequential stale-token window: another client (or an earlier
    // burst) may have already rotated + persisted a newer token while this
    // long-lived instance kept using its old one. Refresh tokens are
    // single-use, so refreshing with our now-dead token would `invalid_grant`.
    // If storage already holds a DIFFERENT access token, adopt it and skip the
    // network refresh entirely - the single-flight guard only covers concurrent
    // bursts, not this later 401.
    const stored = (await loadStoredSettings()).claude?.githubApp;
    if (stored?.accessToken && stored.accessToken !== this.appCtx.accessToken) {
      this.cachedToken = stored.accessToken;
      this.appCtx.accessToken = stored.accessToken;
      if (stored.refreshToken) this.appCtx.refreshToken = stored.refreshToken;
      return stored.accessToken;
    }
    const fresh = await coordinatedRefresh(this.appCtx.clientId, this.appCtx.refreshToken);
    this.cachedToken = fresh.accessToken;
    this.appCtx.accessToken = fresh.accessToken;
    this.appCtx.refreshToken = fresh.refreshToken ?? this.appCtx.refreshToken;
    await persistAppToken(this.appCtx, fresh.expiresAt);
    return fresh.accessToken;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const send = async (token: string): Promise<Response> => fetch(`${API}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

    let res = await send(this.cachedToken);

    // 401 with App auth: token expired between the proactive check and
    // now. Refresh once and retry. PAT auth can't refresh - bubble up.
    if (res.status === 401 && this.appCtx) {
      const fresh = await this.refreshAndCache();
      res = await send(fresh);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub API ${init.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
    }
    return res;
  }

  /**
   * Read the authenticated user's permissions on a repo. GitHub returns
   * the `permissions` block on GET /repos/{owner}/{repo} for any
   * authenticated request. We surface push / admin / pull as a tiny
   * value object so the UI can gate Edit mode on actual write access.
   *
   * Returns null if the repo is unreachable (404, 403) - the caller
   * should treat null as "unknown permissions, leave UI permissive".
   */
  async getRepoPermissions(owner: string, repo: string): Promise<RepoPermissions | null> {
    try {
      const res = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
      const body = (await res.json()) as {
        permissions?: { push?: boolean; admin?: boolean; pull?: boolean };
      };
      const p = body.permissions ?? {};
      return {
        push: !!p.push,
        admin: !!p.admin,
        pull: !!p.pull,
      };
    } catch {
      return null;
    }
  }

  /**
   * Read a file by path. Returns null on 404 (file doesn't exist).
   * Convenience wrapper around getFile that doesn't throw for the
   * "no memory file yet" case the memory subsystem hits constantly.
   * `ref` targets a specific branch/tag/sha (e.g. the conversation-log
   * branch); omit it to read the default branch.
   */
  async getFileOrNull(owner: string, repo: string, path: string, ref?: string): Promise<GitHubFile | null> {
    try {
      return await this.getFile(owner, repo, path, ref);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/\b404\b/.test(msg)) return null;
      throw err;
    }
  }

  /**
   * Return `branch`, creating it from the default branch's HEAD when it
   * doesn't exist yet. Used by the conversation-log persistence, which
   * commits to a dedicated branch so the chat history never triggers the
   * site's production deploy (Pages deploys run on the default branch
   * only) and never clutters the default branch's history.
   */
  async ensureBranch(owner: string, repo: string, branch: string): Promise<string> {
    try {
      await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`);
      return branch; // already exists
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/\b404\b/.test(msg)) throw err; // real error, not "no such branch"
    }
    const def = await this.getDefaultBranch(owner, repo);
    await this.createBranch(owner, repo, branch, def.sha);
    return branch;
  }

  /**
   * Recent commits touching `path` (typically `docs/`). Used by the agent
   * adapter to inject a "who did what lately" block into the system prompt
   * so the model can answer "who added X?" / "what changed yesterday?"
   * questions from real git history. No mutation, no extra API calls
   * beyond this one - we deliberately don't fetch per-commit file lists
   * (would be N+1) and rely on the commit message to convey scope.
   *
   * Caller controls TTL caching; this method is the raw fetch.
   */
  async listRecentCommits(
    owner: string,
    repo: string,
    pathFilter: string,
    sinceDays = 30,
    limit = 20,
  ): Promise<RecentCommit[]> {
    const sinceIso = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    const qs = new URLSearchParams({
      path: pathFilter,
      since: sinceIso,
      per_page: String(Math.min(Math.max(limit, 1), 100)),
    });
    const res = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?${qs.toString()}`);
    const body = (await res.json()) as Array<{
      sha: string;
      commit: { author?: { name?: string; date?: string }; message?: string };
      author?: { login?: string } | null;
    }>;
    return body.slice(0, limit).map((c) => ({
      sha: c.sha,
      date: c.commit.author?.date ?? "",
      // Prefer the GitHub login when present (linked GH account); fall
      // back to the git author name (works for unlinked commits).
      author: c.author?.login || c.commit.author?.name || "(unknown)",
      // Keep just the first line of the commit message - the body adds
      // tokens without much extra signal for "who did what" context.
      message: (c.commit.message ?? "").split("\n")[0],
    }));
  }

  async getDefaultBranch(owner: string, repo: string): Promise<DefaultBranchInfo> {
    const res = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    const repoInfo = (await res.json()) as { default_branch: string };
    const ref = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(repoInfo.default_branch)}`
    );
    const refInfo = (await ref.json()) as { object: { sha: string } };
    return { name: repoInfo.default_branch, sha: refInfo.object.sha };
  }

  async getFile(owner: string, repo: string, path: string, ref?: string): Promise<GitHubFile> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const res = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}${q}`);
    const body = (await res.json()) as { content: string; sha: string; path: string; encoding: string };
    if (body.encoding !== "base64") {
      throw new Error(`Unexpected encoding ${body.encoding} for ${path}`);
    }
    return { content: b64ToUtf8(body.content), sha: body.sha, path: body.path };
  }

  /**
   * List a directory's immediate entries via the contents API. Returns []
   * when the directory doesn't exist (404) so callers don't need to guard the
   * "no shared tasks yet" case. Only file/dir names + paths - no content (the
   * dir listing omits it; fetch each file separately if you need bodies).
   */
  async listDir(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<Array<{ name: string; path: string; type: string }>> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    let res: Response;
    try {
      res = await this.request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}${q}`,
      );
    } catch {
      return []; // best-effort: directory absent or unreadable
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return []; // a file, not a directory
    return body
      .filter((e): e is { name: string; path: string; type: string } =>
        e != null && typeof e === "object" && typeof (e as { path?: unknown }).path === "string",
      )
      .map((e) => ({ name: e.name, path: e.path, type: e.type }));
  }

  async createBranch(owner: string, repo: string, branch: string, fromSha: string): Promise<void> {
    await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
    });
  }

  async updateFile(
    owner: string,
    repo: string,
    path: string,
    newContent: string,
    /** Omit `sha` (pass null) to CREATE a new file - GitHub uses the
     * presence of `sha` to disambiguate "update existing" vs "create new". */
    expectedSha: string | null,
    branch: string,
    message: string
  ): Promise<CommitInfo> {
    const body: Record<string, unknown> = {
      message,
      content: utf8ToB64(newContent),
      branch,
    };
    if (expectedSha != null) body.sha = expectedSha;
    const res = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { commit: { sha: string; html_url?: string } };
    // Synthesise html_url if the API didn't return one (older mock paths).
    const html_url = data.commit.html_url
      ?? `https://github.com/${owner}/${repo}/commit/${data.commit.sha}`;
    return { sha: data.commit.sha, html_url };
  }

  /**
   * List every `docs/*.html` blob in the repo tree at `ref` (default
   * branch if omitted). One recursive-tree request - cheap, even on
   * larger docs sites. Used by the read_page / list_pages tools to
   * enumerate pages beyond the ones covered by nav.json.
   */
  async listDocsHtml(owner: string, repo: string, ref?: string): Promise<string[]> {
    const branch = ref ?? (await this.getDefaultBranch(owner, repo)).name;
    const res = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    const body = (await res.json()) as {
      tree?: Array<{ path: string; type: string }>;
      truncated?: boolean;
    };
    // GitHub truncates tree responses over 100k entries or 7MB. Our docs
    // sites are tiny so this shouldn't fire, but log it so we notice if
    // a repo ever grows past that threshold - the alternative (per-subtree
    // pagination) is only worth the code if this actually hits.
    if (body.truncated) {
      console.warn(
        `[prodocstore] listDocsHtml: GitHub tree for ${owner}/${repo}@${branch} was truncated; some pages may be missing from the list`,
      );
    }
    return (body.tree ?? [])
      .filter((e) => e.type === "blob" && e.path.startsWith("docs/") && e.path.endsWith(".html"))
      .map((e) => e.path);
  }

  /**
   * List every blob path in the repo tree at `ref` (default branch if
   * omitted). Used by the agent's `list_repo_files` tool so the model
   * can discover what's in the repo - including non-docs source code -
   * in order to verify docs against reality. Same one-request shape as
   * listDocsHtml; same 100k-entry GitHub truncation caveat.
   */
  async listRepoFiles(owner: string, repo: string, ref?: string): Promise<string[]> {
    const branch = ref ?? (await this.getDefaultBranch(owner, repo)).name;
    const res = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    const body = (await res.json()) as {
      tree?: Array<{ path: string; type: string }>;
      truncated?: boolean;
    };
    if (body.truncated) {
      console.warn(
        `[prodocstore] listRepoFiles: GitHub tree for ${owner}/${repo}@${branch} was truncated; some files may be missing from the list`,
      );
    }
    return (body.tree ?? [])
      .filter((e) => e.type === "blob")
      .map((e) => e.path);
  }

  async createPullRequest(
    owner: string,
    repo: string,
    title: string,
    body: string,
    head: string,
    base: string
  ): Promise<PullRequest> {
    const res = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title, body, head, base }),
    });
    const pr = (await res.json()) as { number: number; url: string; html_url: string };
    return pr;
  }
}

/**
 * URL-encode each path segment but keep the slashes. GitHub's contents
 * endpoint accepts `docs/foo.html` verbatim; `docs%2Ffoo.html` may work
 * but isn't guaranteed and is rejected by some proxies.
 */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function b64ToUtf8(b64: string): string {
  // GitHub returns the content with line breaks; strip them.
  const clean = b64.replace(/\s/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function utf8ToB64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
