// Shared tool schemas + result types for the multi-turn LLM loop.
//
// The OpenAI chat-completions API and the Anthropic Messages API both
// accept JSON Schema in their tool definitions with almost identical
// shape, so a single source of truth keeps the Claude adapter from
// drifting when it lands. Prompts are NOT here - those differ per
// provider and live next to the adapter that uses them.
//
// Five tools:
//   - list_pages          : discover the site's page set (read).
//   - read_page           : fetch another page's visible text (read).
//   - ask_clarification   : terminal, surface a question to the user.
//   - edit_file           : terminal, propose find/replace edits.
//   - update_nav_config   : terminal, propose a new docs/nav.json.

import type { NavItem } from "../types";

export const MAX_TURNS = 8;

// ── Result shapes returned by the loop driver ────────────────────────

export interface EditProposal {
  /**
   * Optional source path the edit targets. When omitted, the adapter
   * defaults to the page the user is currently viewing. Set this when
   * the user asks for a change to a different page (the model should
   * have called read_page first to see that page's content).
   */
  path?: string;
  edits: Array<{ find: string; replace: string }>;
  summary: string;
  rationale?: string;
}

export interface NavProposal {
  items: NavItem[];
  navSkip?: string[];
  summary: string;
  rationale?: string;
}

export interface CreateProposal {
  /** New file path under docs/, e.g. 'docs/security.md'. Must not exist yet. */
  path: string;
  /** Full content of the new file. */
  content: string;
  summary: string;
  rationale?: string;
}

export interface ClarificationRequest {
  /** Specific question to surface back to the user. */
  question: string;
  /** Optional: what specifically about the prompt was unclear. */
  why?: string;
}

export interface MemoryProposal {
  /** The fact to add to MEMORY.md. */
  entry: string;
  /** Optional ## heading to file under; defaults to "Notes". */
  section?: string;
}

/** Plain free-text assistant reply (no tool call emitted this turn). */
export interface PlainReply {
  kind: "plain";
  content: string;
}

export interface EditResult {
  kind: "edit";
  proposal: EditProposal;
}

export interface NavResult {
  kind: "nav";
  proposal: NavProposal;
}

export interface CreateResult {
  kind: "create";
  proposal: CreateProposal;
}

export interface ClarificationResult {
  kind: "clarification";
  clarification: ClarificationRequest;
}

export interface MemoryResult {
  kind: "memory";
  proposal: MemoryProposal;
}

export type MultiTurnResult =
  | PlainReply
  | EditResult
  | NavResult
  | CreateResult
  | ClarificationResult
  | MemoryResult;

/** Tool call surfaced to the adapter's dispatcher. */
export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments. The loop parses before dispatch. */
  args: unknown;
}

// ── Tool schemas ─────────────────────────────────────────────────────

export const EDIT_FILE_TOOL = {
  type: "function" as const,
  function: {
    name: "edit_file",
    description: "Apply find-and-replace edits to a docs/<name> page (.html/.md/.mdx). By default targets the page the user is currently viewing; set `path` when editing a different page (call read_page first to see that page's content). Do NOT use this to change the site menu/navigation - use update_nav_config for that. edit_file is clamped to docs/<name> and cannot write config files like mkdocs.yml.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Optional. Source path to edit, e.g. 'docs/index.html'. Omit (or set to the current page's path) to edit the current page. When editing a different page, call read_page first so the find strings actually match.",
        },
        edits: {
          type: "array",
          description:
            "Ordered list of find/replace operations. Each 'find' must exist verbatim in the target file.",
          items: {
            type: "object",
            properties: {
              find: { type: "string" },
              replace: { type: "string" },
            },
            required: ["find", "replace"],
            additionalProperties: false,
          },
        },
        summary: {
          type: "string",
          description: "One-line PR title describing the change.",
        },
        rationale: {
          type: "string",
          description: "Optional PR description body explaining the change.",
        },
      },
      required: ["edits", "summary"],
      additionalProperties: false,
    },
  },
};

export const CREATE_PAGE_TOOL = {
  type: "function" as const,
  function: {
    name: "create_page",
    description:
      "Create a BRAND-NEW docs page that does not exist yet. Use this (not edit_file) when the user asks to add/create a new page. Provide the complete file content. The path must be a new file under docs/ that doesn't already exist - if the page exists, use edit_file instead. Adding the new page to the site menu is a SEPARATE step (update_nav_config on HTML sites, or editing the generator's nav config on Markdown sites); mention that in your summary if the user asked for it.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "New file path under docs/, e.g. 'docs/security.md'. Match the site's source format: use .md/.mdx for Markdown sites, .html for hand-authored HTML sites. Must not already exist.",
        },
        content: {
          type: "string",
          description:
            "The COMPLETE content of the new file. For Markdown sites emit Markdown (with front matter if the site uses it); for HTML sites emit a full page consistent with the site's other pages.",
        },
        summary: {
          type: "string",
          description: "One-line PR title, e.g. 'Add security page'.",
        },
        rationale: {
          type: "string",
          description: "Optional PR description body.",
        },
      },
      required: ["path", "content", "summary"],
      additionalProperties: false,
    },
  },
};

export const REMEMBER_TOOL = {
  type: "function" as const,
  function: {
    name: "remember",
    description:
      "Save a durable fact to the team's shared memory at .freedocstore/MEMORY.md. Use sparingly - only for things the team should remember across sessions and users (style decisions, project conventions, things to avoid, durable preferences). The user reviews and approves every memory entry before it's committed. Don't use this for one-off observations or anything visible from git history.",
    parameters: {
      type: "object",
      properties: {
        entry: {
          type: "string",
          description:
            "The fact to remember, written in second person and one to three sentences. Example: 'Headings on this site use sentence case (only the first word capitalised).'",
        },
        section: {
          type: "string",
          description:
            "Optional ## heading to file this entry under. Defaults to 'Notes' when omitted. Reuse existing section names from MEMORY.md when one fits, otherwise pick a short topic name (Style, Voice, Architecture, Ops, etc.).",
        },
      },
      required: ["entry"],
      additionalProperties: false,
    },
  },
};

export const ASK_CLARIFICATION_TOOL = {
  type: "function" as const,
  function: {
    name: "ask_clarification",
    description:
      "Use when the user's request is too vague, ambiguous, or missing detail to safely answer or edit. Returns control to the user instead of inventing placeholder edits or fabricated answers. Choose this over edit_file whenever you would otherwise generate filler content.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "A specific clarifying question. Reference exact page elements (headings, sections, components) where possible. Avoid generic 'what would you like to do?' phrasing.",
        },
        why: {
          type: "string",
          description:
            "Briefly: what specifically about the request was unclear (one sentence).",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
};

export const LIST_PAGES_TOOL = {
  type: "function" as const,
  function: {
    name: "list_pages",
    description:
      "List pages on this docs site. Returns nav entries (from docs/nav.json) plus any *.html files in docs/ not covered by the nav. Use when the user asks what pages are on this site or before deciding which page to read_page.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

export const READ_PAGE_TOOL = {
  type: "function" as const,
  function: {
    name: "read_page",
    description:
      "Read the full visible text of another page on this site. Use to find where something is mentioned or to ground an answer in content other than the current page. Paths are site-relative under docs/. Must come from a prior list_pages result.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Site-relative source path under docs/, e.g. 'docs/components.html'",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

export const LIST_REPO_FILES_TOOL = {
  type: "function" as const,
  function: {
    name: "list_repo_files",
    description:
      "List EVERY file in the GitHub repo backing this docs site (not just docs/). Use when you need to verify a docs page against the source code it describes - e.g. 'is the architecture section in docs/extension.html still accurate?'. Pair with read_repo_file to actually read the source. Distinct from list_pages, which is restricted to docs/*.html.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

export const READ_REPO_FILE_TOOL = {
  type: "function" as const,
  function: {
    name: "read_repo_file",
    description:
      "Read any file in the repo by path (not just docs/*.html that read_page covers). Use to compare what a docs page CLAIMS against what the code actually does. Returns the file's text content, capped at 20KB with head+tail truncation. Path validation rejects traversal (no '..', no leading '/').",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Repo-relative path, e.g. 'extension/src/adapters/openai.ts' or '.github/workflows/deploy-pages.yml'.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

export const UPDATE_NAV_CONFIG_TOOL = {
  type: "function" as const,
  function: {
    name: "update_nav_config",
    description:
      "Change the site menu/navigation. Provide the COMPLETE new top-level items array (and optionally navSkip). The extension targets the right file automatically: docs/nav.json on hand-authored HTML sites, or mkdocs.yml on MkDocs/Material sites. On a MkDocs site the nav isn't in your page context, so call read_repo_file('mkdocs.yml') FIRST to see the current nav, then pass the full item list including your addition/change (paths are docs_dir-relative, e.g. 'credits.md'). This is the ONLY way to edit the menu - edit_file cannot touch mkdocs.yml.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description:
            "Complete new top-level nav items. Each item is either a leaf (href + label) or a dropdown (label + children).",
          items: navItemSchema(2),
        },
        navSkip: {
          type: "array",
          description:
            "Pages that intentionally don't appear in the topbar (e.g. 404.html, index.html).",
          items: { type: "string" },
        },
        summary: {
          type: "string",
          description: "One-line PR title describing the nav change.",
        },
        rationale: {
          type: "string",
          description: "Optional PR description body.",
        },
      },
      required: ["items", "summary"],
      additionalProperties: false,
    },
  },
};

// Recursive schema for nav items. `depth` caps nesting so the JSON Schema
// stays finite - real topbars only ever go one level deep.
function navItemSchema(depth: number): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: "object",
    properties: {
      label: { type: "string" },
      href: { type: "string" },
    },
    required: ["label"],
    additionalProperties: false,
  };
  if (depth > 0) {
    (base.properties as Record<string, unknown>).children = {
      type: "array",
      items: navItemSchema(depth - 1),
    };
  }
  return base;
}
