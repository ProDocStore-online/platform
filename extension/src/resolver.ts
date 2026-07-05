// Resolve a rendered page URL to the backing GitHub repo + source file.
//
// Sites declare their backing GitHub repo via a single meta tag on the
// rendered HTML. Two spellings are accepted, same meaning:
//
//   <meta name="source-repo" content="owner/name">   (generic, any generator)
//   <meta name="docs-repo"   content="owner/name">   (legacy freedocstore)
//
// Decentralised by design - any site that wants to work with the
// extension opts in by emitting this tag at deploy time, regardless of
// how it was built (Zensical, MkDocs, hand-written HTML, ...). No
// registry, no per-user config, no hostname-to-repo guessing.
//
// Pages without the meta tag return repo: null. The extension still
// works in read-only mode (browse + ask questions); write operations
// (commit, PR) require a known repo.

import type { FeatureConfig, NavConfig, PageContext } from "./types";

// Re-export the shared parser so extension code has a single import point
// for nav-related helpers. Implementation lives in the deploy-time lib.
export { parseNavConfig } from "../../templates/search/scripts/lib/nav.mjs";

// Features keys we know about. Kept in sync with
// templates/features.schema.json; any unknown keys in the JSON are
// dropped so a future KB-side typo can't surface to the UI as a
// phantom feature.
const KNOWN_FEATURE_KEYS = [
  "changelog",
  "sitemap",
  "pageMeta",
  "references",
  "nav",
  "search",
] as const;

/**
 * Parse docs/features.json - the per-KB opt-in file. Returns null on
 * malformed JSON, {} when the file exists but nothing is toggled on.
 * Silently drops unknown keys so the UI only ever shows the features
 * the extension actually understands.
 */
export function parseFeatureConfig(raw: string): FeatureConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed JSON - treat as "no feature config"
  }
  if (parsed == null || typeof parsed !== "object") return null;
  const src = parsed as Record<string, unknown>;
  const out: FeatureConfig = {};
  for (const key of KNOWN_FEATURE_KEYS) {
    const v = src[key];
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}

// Two regexes because HTML attribute order is not fixed. Both match
// owner/name with characters GitHub allows (alphanumeric, hyphen,
// underscore, dot). Quote style is flexible (single or double). The
// name accepts `source-repo` (generic) or `docs-repo` (legacy).
const META_NAME = `(?:source-repo|docs-repo)`;
const META_REPO_NAME_FIRST = new RegExp(`<meta\\s+[^>]*\\bname\\s*=\\s*["']${META_NAME}["'][^>]*\\bcontent\\s*=\\s*["']([\\w.-]+)\\/([\\w.-]+)["'][^>]*>`, "i");
const META_REPO_CONTENT_FIRST = new RegExp(`<meta\\s+[^>]*\\bcontent\\s*=\\s*["']([\\w.-]+)\\/([\\w.-]+)["'][^>]*\\bname\\s*=\\s*["']${META_NAME}["'][^>]*>`, "i");

// A valid GitHub owner/repo segment: starts alphanumeric, then the chars
// GitHub allows. Critically this rejects "." and ".." (which the looser
// capture regex's `[\w.-]+` would otherwise match), so a spoofed meta tag
// can't smuggle path-traversal segments into an api.github.com URL.
const REPO_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function isSafeRepoSegment(s: string): boolean {
  return REPO_SEGMENT_RE.test(s) && s !== "." && s !== "..";
}

/**
 * Extract the backing repo from a `<meta name="source-repo">` (or legacy
 * `docs-repo`) tag in the rendered HTML. Returns null if absent or
 * malformed. The page is untrusted (any *.pages.dev host), so owner/name
 * are validated against GitHub's naming rules before we ever build a repo
 * URL from them.
 */
export function extractRepoFromMeta(html: string): { owner: string; name: string } | null {
  const m = META_REPO_NAME_FIRST.exec(html) ?? META_REPO_CONTENT_FIRST.exec(html);
  if (!m) return null;
  const owner = m[1];
  const name = m[2];
  if (!isSafeRepoSegment(owner) || !isSafeRepoSegment(name)) return null;
  return { owner, name };
}

// `<meta name="source-path" content="docs/architecture.md">`. Injected at
// build time for sites where the published page is GENERATED from a
// different source file (Zensical/MkDocs build Markdown -> HTML, so the
// URL can't be mapped to the source by extension-guessing). The build
// knows the exact mapping; this is it, made authoritative.
const META_SRCPATH_NAME_FIRST = /<meta\s+[^>]*\bname\s*=\s*["']source-path["'][^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*>/i;
const META_SRCPATH_CONTENT_FIRST = /<meta\s+[^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*\bname\s*=\s*["']source-path["'][^>]*>/i;

/**
 * Extract `<meta name="source-path">` from the rendered HTML. Returns the
 * repo-relative source path (e.g. "docs/architecture.md") or null when
 * absent/unsafe. Rejects path traversal and absolute paths so a malformed
 * tag can never point the editor outside the repo.
 */
export function extractSourcePathFromMeta(html: string): string | null {
  const m = META_SRCPATH_NAME_FIRST.exec(html) ?? META_SRCPATH_CONTENT_FIRST.exec(html);
  if (!m) return null;
  const path = m[1].trim();
  if (!path || path.includes("..") || path.startsWith("/") || path.startsWith("\\")) return null;
  // Must be a docs/ source file. The page is attacker-controllable, so
  // without this scoping a spoofed tag could point the editor at
  // .github/workflows/*.yml or root config (CI poisoning). Mirror the
  // extension set the read/edit validators accept.
  if (!/^docs\/[A-Za-z0-9._/-]+\.(html?|mdx?|markdown)$/i.test(path)) return null;
  return path;
}

/**
 * Build a PageContext from a URL and the current page's HTML.
 *
 * Path mapping handles Cloudflare Pages' clean-URL behavior:
 *   /                -> docs/index.html
 *   /foo             -> docs/foo.html          (Pages serves foo.html)
 *   /foo.html        -> docs/foo.html          (explicit)
 *   /foo/            -> docs/foo/index.html    (Pages serves foo/index.html)
 *   /foo/bar.html    -> docs/foo/bar.html      (subdirectories)
 *
 * Query strings and fragments are already stripped by URL.pathname.
 */
export function resolveContext(
  rawUrl: string,
  html: string,
  text: string,
  title: string,
  navConfig: NavConfig | null = null,
  features: FeatureConfig | null = null,
): PageContext {
  return {
    url: rawUrl,
    title,
    // Prefer the build-injected source-path meta (authoritative for
    // generated sites like Zensical/MkDocs where the page is built from a
    // different file). Fall back to clean-URL guessing for hand-authored
    // docs/*.html sites that don't emit it.
    sourcePath: extractSourcePathFromMeta(html) ?? pathnameToSource(decodePathname(new URL(rawUrl).pathname)),
    repo: extractRepoFromMeta(html),
    html,
    text,
    navConfig,
    features,
  };
}


// A URL's pathname is percent-encoded (the URL API encodes spaces/non-ASCII).
// pathnameToSource does string surgery and hands the result to the GitHub
// client, which encodeURIComponent's it again - so an undecoded "%C3%ADa" would
// be double-encoded to "%25C3%25ADa" and 404. Decode once here; if the escapes
// are malformed (decodeURIComponent throws), keep the raw pathname.
function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/** Exported for test coverage of the clean-URL cases. */
export function pathnameToSource(pathname: string): string {
  // Strip leading slashes.
  let p = pathname.replace(/^\/+/, "");
  // Empty -> root.
  if (p === "") return "docs/index.html";
  // Trailing slash -> index of that directory.
  if (p.endsWith("/")) return `docs/${p}index.html`;
  // A page served directly keeps its extension; anything else is a Cloudflare
  // Pages clean URL whose backing file is <path>.html. Only a genuine page
  // extension (.html/.htm) counts as "already a file" - matching ANY trailing
  // `.<alnum>` wrongly treated a dotted clean URL like /release-1.0 as having
  // extension ".0", so .html was never appended and editing that page 404'd.
  if (/\.html?$/i.test(p)) return `docs/${p}`;
  // Guard a stray trailing dot so we never synthesize "foo..html" (the ".."
  // would be rejected by every downstream path validator).
  p = p.replace(/\.+$/, "");
  // No extension -> Pages clean URL, backing file has .html.
  return `docs/${p}.html`;
}

/**
 * Map a repo source path back to the site-root-relative pathname of the
 * DEPLOYED page, so an edit card can link to the actual published page rather
 * than the `docs/*.md` source. Roughly the inverse of pathnameToSource / the
 * MkDocs docs_dir mapping. Returns null when the path isn't a docs page.
 *
 *   docs/about.md        -> /about/          (MkDocs directory URLs, the default)
 *   docs/index.md        -> /
 *   docs/guide/intro.md  -> /guide/intro/
 *   docs/about.html      -> /about.html      (hand-authored HTML site)
 *   docs/index.html      -> /
 *
 * The Markdown branch assumes MkDocs' default `use_directory_urls: true` (a
 * `.md` page ships as `<name>/index.html`, served at `/<name>/`). A site that
 * sets it false serves `/<name>.html` instead; we can't tell from the path
 * alone, so we take the common default. HTML sources keep their real filename,
 * which Cloudflare Pages serves directly.
 */
export function sourceToPublishedPath(sourcePath: string): string | null {
  const m = /^docs\/(.+)$/.exec(sourcePath.trim());
  if (!m) return null;
  let rest = m[1];
  const md = /\.(md|mdx)$/i.exec(rest);
  if (md) {
    rest = rest.slice(0, -md[0].length); // strip the .md/.mdx extension
    // `index` (root or per-directory) collapses to the directory itself.
    if (rest === "index") return "/";
    if (rest.endsWith("/index")) return `/${rest.slice(0, -"index".length)}`;
    return `/${rest}/`; // directory URL
  }
  if (/\.html?$/i.test(rest)) {
    if (rest === "index.html" || rest === "index.htm") return "/";
    if (rest.endsWith("/index.html") || rest.endsWith("/index.htm")) {
      return `/${rest.replace(/index\.html?$/i, "")}`;
    }
    return `/${rest}`;
  }
  return null;
}
