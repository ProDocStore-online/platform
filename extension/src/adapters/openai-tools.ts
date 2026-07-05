// Tool dispatch for the OpenAI adapter's multi-turn loop.
//
// list_pages: one recursive-tree call to GitHub, flattened into navItems
//   (from nav.json, when present) + otherPages (site HTML not covered by
//   nav). Cached in the closure so repeated list_pages in the same loop
//   reuse the tree.
// read_page: path validation -> gh.getFile -> html-to-text stripping +
//   title extraction. 20k-char cap with head+tail truncation.
//
// Exported helpers are tested directly in openai-tools.test.mjs.

import type { NavItem, PageContext } from "../types";
import type { GitHubClient } from "../lib/github";
import type { ToolCall } from "../lib/openai";
import { extractTitle, htmlToVisibleText } from "../lib/text";

export const READ_PAGE_CAP = 20_000;
export const READ_PAGE_HALF = 10_000;

export interface NavEntry {
  path: string;
  label: string;
  parent: string | null;
}

export function collectNav(
  items: NavItem[],
  parent: string | null,
  out: NavEntry[],
  covered: Set<string>,
): void {
  for (const it of items) {
    if (it.href) {
      const path = `docs/${it.href}`;
      out.push({ path, label: it.label, parent });
      covered.add(path);
    }
    if (it.children?.length) {
      collectNav(it.children, it.label, out, covered);
    }
  }
}

// Source files we know how to read/edit: hand-authored HTML and the
// Markdown family that static generators (Zensical, MkDocs, Docusaurus)
// build from. Still docs/-scoped, still traversal-proof.
const SOURCE_EXT = /\.(html?|mdx?|markdown)$/i;

/**
 * Source language of a file, by extension. Drives the editing prompt
 * (Markdown vs HTML) and the grounding code-fence. Everything that isn't
 * a recognised Markdown extension is treated as HTML (the FreeDocStore
 * default), so hand-authored docs/*.html keep their existing behaviour.
 */
export function sourceFormatOf(path: string): "html" | "markdown" {
  return /\.(mdx?|markdown)$/i.test(path) ? "markdown" : "html";
}

export function isValidReadPath(path: string): boolean {
  if (!path) return false;
  if (path.includes("..")) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (!/^docs\/[A-Za-z0-9._/-]+$/.test(path)) return false;
  return SOURCE_EXT.test(path);
}

/**
 * Anywhere-in-the-repo path validator for read_repo_file. Far more
 * permissive than isValidReadPath - any file in the repo is fair game
 * (extension/src/*.ts, .github/workflows/*.yml, README, etc.) - but
 * still rejects path traversal and absolute paths so the tool can
 * never escape the repo root.
 *
 * Denylist approach so legitimate-but-unusual paths work:
 *   node_modules/@scope/pkg/index.js  (npm scopes need @)
 *   src/(auth)/login/page.tsx         (Next.js route groups need parens)
 *   v1.2.3+build.5/notes.md           (semver tags need + and =)
 * Rejects only what is dangerous to interpolate into a GitHub API URL or
 * shell context: NUL/control chars, shell metacharacters, whitespace,
 * and quotes. Real repo paths essentially never contain those.
 */
export function isValidRepoPath(path: string): boolean {
  if (!path) return false;
  if (path.includes("..")) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f<>|;&$`'"*?\\\s]/.test(path)) return false;
  return true;
}

export function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= READ_PAGE_CAP) return { text, truncated: false };
  const head = text.slice(0, READ_PAGE_HALF);
  const tail = text.slice(-READ_PAGE_HALF);
  const trimmed = text.length - head.length - tail.length;
  return {
    text: `${head}\n...[TRUNCATED ${trimmed} CHARS]...\n${tail}`,
    truncated: true,
  };
}

/**
 * Heuristic binary-file detector. NUL bytes essentially never appear in
 * real text files; the U+FFFD replacement character is what TextDecoder
 * emits when binary bytes are decoded as UTF-8. Either signal means the
 * model is about to receive mangled content - cheaper to refuse than to
 * waste tokens on garbage. Sample the first 8KB so a huge file doesn't
 * cost us a full O(n) scan.
 */
export function looksLikeBinary(text: string): boolean {
  const sample = text.length > 8192 ? text.slice(0, 8192) : text;
  return sample.includes("\x00") || sample.includes("\uFFFD");
}

export function siteIdentifier(context: PageContext): string {
  if (context.repo) return `${context.repo.owner}/${context.repo.name}`;
  try {
    return new URL(context.url).hostname;
  } catch {
    return "unknown-site";
  }
}

/**
 * Build the per-turn dispatcher. The tree and known-paths set are
 * cached in closure so repeated list_pages calls share a single GitHub
 * request, and read_page membership checks kick in after the first
 * list_pages.
 */
export function makeDispatch(
  gh: GitHubClient | null,
  context: PageContext,
): (call: ToolCall) => Promise<string> {
  let cachedTree: string[] | null = null;
  let knownPaths: Set<string> | null = null;

  return async (call) => {
    try {
      if (call.name === "list_pages") {
        if (!context.repo) return JSON.stringify({ error: "no_repo" });
        if (!gh) return JSON.stringify({ error: "no_github_client" });
        const { owner, name: repo } = context.repo;

        const allHtml = cachedTree ?? (await gh.listDocsHtml(owner, repo));
        cachedTree = allHtml;

        const navSkip = context.navConfig?.navSkip ?? [];
        const navItems: NavEntry[] = [];
        const covered = new Set<string>();
        if (context.navConfig) {
          collectNav(context.navConfig.items, null, navItems, covered);
        }
        const otherPages = allHtml.filter((p) => !covered.has(p));

        knownPaths = new Set<string>([
          ...navItems.map((i) => i.path),
          ...otherPages,
        ]);

        return JSON.stringify({
          site: siteIdentifier(context),
          currentPage: context.sourcePath,
          navItems,
          otherPages,
          navSkip,
        });
      }

      if (call.name === "read_page") {
        const args = (call.args ?? {}) as { path?: string };
        const path = typeof args.path === "string" ? args.path : "";
        if (!context.repo) return JSON.stringify({ error: "no_repo" });
        if (!gh) return JSON.stringify({ error: "no_github_client" });
        if (!isValidReadPath(path)) {
          return JSON.stringify({
            error: "invalid_path",
            detail: "path must be docs/<name> with a .html/.md/.mdx extension",
          });
        }
        if (knownPaths && !knownPaths.has(path)) {
          return JSON.stringify({
            error: "invalid_path",
            detail: "call list_pages first",
          });
        }

        try {
          const file = await gh.getFile(context.repo.owner, context.repo.name, path);
          const title = extractTitle(file.content);
          const text = htmlToVisibleText(file.content);
          const capped = capText(text);
          return JSON.stringify({
            path,
            title,
            text: capped.text,
            truncated: capped.truncated,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/404/.test(msg)) return JSON.stringify({ error: "not_found", path });
          return JSON.stringify({ error: "fetch_failed", detail: msg.slice(0, 300) });
        }
      }

      if (call.name === "list_repo_files") {
        if (!context.repo) return JSON.stringify({ error: "no_repo" });
        if (!gh) return JSON.stringify({ error: "no_github_client" });
        const { owner, name: repo } = context.repo;
        try {
          const allFiles = await gh.listRepoFiles(owner, repo);
          // Cap at 1000 entries to keep the response bounded; very few
          // docs repos have more, but if we ever index a monorepo the
          // model gets a clear cutoff message rather than a runaway list.
          const FILE_LIMIT = 1000;
          const truncated = allFiles.length > FILE_LIMIT;
          const files = truncated ? allFiles.slice(0, FILE_LIMIT) : allFiles;
          return JSON.stringify({
            site: siteIdentifier(context),
            count: allFiles.length,
            files,
            truncated,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return JSON.stringify({ error: "fetch_failed", detail: msg.slice(0, 300) });
        }
      }

      if (call.name === "read_repo_file") {
        const args = (call.args ?? {}) as { path?: string };
        const path = typeof args.path === "string" ? args.path : "";
        if (!context.repo) return JSON.stringify({ error: "no_repo" });
        if (!gh) return JSON.stringify({ error: "no_github_client" });
        if (!isValidRepoPath(path)) {
          return JSON.stringify({
            error: "invalid_path",
            detail: "path must be a repo-relative file path with no '..' and no leading '/'",
          });
        }
        try {
          const file = await gh.getFile(context.repo.owner, context.repo.name, path);
          if (looksLikeBinary(file.content)) {
            return JSON.stringify({
              error: "binary_file",
              path,
              detail: "file appears to be binary (NUL bytes or UTF-8 replacement chars); cannot return as text",
            });
          }
          const capped = capText(file.content);
          return JSON.stringify({
            path,
            text: capped.text,
            truncated: capped.truncated,
            sha: file.sha,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/404/.test(msg)) return JSON.stringify({ error: "not_found", path });
          return JSON.stringify({ error: "fetch_failed", detail: msg.slice(0, 300) });
        }
      }

      return JSON.stringify({ error: "unknown_tool", name: call.name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: "dispatch_error", detail: msg.slice(0, 300) });
    }
  };
}
