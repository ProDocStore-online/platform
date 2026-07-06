import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthHandler } from "./auth-handler.js";
import {
  findKnowledgeBase,
  getDeployStatus,
  listRepoFiles,
  readRegistry,
  readRepoFile,
  type KnowledgeBase,
} from "./github.js";

interface Env {
  PUBLIC_BASE_URL: string;
  REGISTRY_URL: string;
  GITHUB_ORG: string;
  PLATFORM_REPO: string;
  DEFAULT_DOMAIN: string;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  FDS_API_KV?: KVNamespace;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

const txt = (text: string) => ({ content: [{ type: "text" as const, text }] });

interface McpProps extends Record<string, unknown> {
  userId?: string;
  provider?: string;
  login?: string;
  name?: string;
  avatarUrl?: string;
  githubUrl?: string;
  scopes?: string[];
}

interface WorkspaceDraft {
  id?: string;
  title?: string;
  slug?: string;
  owner?: string;
  customDomain?: string;
  visibility?: string;
  prompt?: string;
  liveUrl?: string;
  repoUrl?: string;
  lastStatus?: string;
  updatedAt?: string;
  files?: Array<{ path?: string }>;
  steps?: Array<{ id: string; label: string; detail: string; state: string }>;
  createdAt?: string;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function repoFromInput(env: Env, kbOrRepo: string): string {
  return kbOrRepo.includes("/") ? kbOrRepo : `${env.GITHUB_ORG}/${kbOrRepo}`;
}

function renderKb(kb: KnowledgeBase): string {
  const domains = kb.cloudflare?.custom_domains?.length ? kb.cloudflare.custom_domains.join(", ") : "(none)";
  return [
    `**${kb.title}** (${kb.id})`,
    `Status: ${kb.status ?? "unknown"}`,
    `Engine: ${kb.engine}`,
    `Repo: https://github.com/${kb.source.repo}`,
    `Branch: ${kb.source.branch ?? "main"}`,
    `Docs dir: ${kb.source.docs_dir ?? "docs"}`,
    `Config: ${kb.source.config ?? "zensical.toml"}`,
    `Cloudflare project: ${kb.cloudflare?.pages_project ?? kb.id}`,
    `Production: ${kb.cloudflare?.production_url ?? `https://${kb.id}.pages.dev/`}`,
    `Custom domains: ${domains}`,
    kb.description ? `\n${kb.description}` : "",
  ].filter(Boolean).join("\n");
}

function userKvKey(userId: string, key: string): string {
  return `user_kv:${userId}:${key}`;
}

async function readWorkspace<T>(env: Env, userId: string | undefined, key: string): Promise<T | null> {
  if (!userId || !env.FDS_API_KV) return null;
  return env.FDS_API_KV.get<T>(userKvKey(userId, key), "json");
}

function renderDraft(draft: WorkspaceDraft): string {
  const files = draft.files?.map((file) => file.path).filter(Boolean) ?? [];
  return [
    `**${draft.title ?? "Untitled KB"}** (${draft.id ?? draft.slug ?? "unknown"})`,
    `Status: ${draft.lastStatus ?? "Draft"}`,
    `Repo target: ${draft.owner ?? "FreeDocStore"}/${draft.slug ?? "unknown"}`,
    `Visibility: ${draft.visibility ?? "public"}`,
    `Repo URL: ${draft.repoUrl || "(not published)"}`,
    `Live URL: ${draft.liveUrl || (draft.slug ? `https://${draft.slug}.pages.dev/` : "(not set)")}`,
    `Custom domain: ${draft.customDomain || "(none)"}`,
    `Generated files: ${files.length ? files.join(", ") : "(none)"}`,
    `Updated: ${draft.updatedAt ?? "(unknown)"}`,
  ].join("\n");
}

function requireWorkspaceWrite(env: Env, props: McpProps): string {
  if (!props?.userId) throw new Error("Not authenticated. Connect with GitHub OAuth first.");
  if (!props.scopes?.includes("write")) throw new Error("This MCP token does not include the write scope.");
  if (!env.FDS_API_KV) throw new Error("FDS_API_KV is not bound to the MCP worker.");
  return props.userId;
}

function clonePublishSteps() {
  return [
    { id: "plan", label: "Create Zensical structure", detail: "Draft", state: "ok" },
    { id: "ai", label: "Generate Markdown files", detail: "Created by MCP sample tool", state: "ok" },
    { id: "repo", label: "Create GitHub repository", detail: "Not published yet", state: "idle" },
    { id: "files", label: "Commit Zensical source", detail: "Not published yet", state: "idle" },
    { id: "secrets", label: "Use stored Cloudflare deploy connection", detail: "Ready at platform level", state: "idle" },
    { id: "deploy", label: "GitHub Actions publishes to Cloudflare", detail: "Not started", state: "idle" },
  ];
}

function sampleFiles(title: string, prompt: string, slug: string, customDomain = "") {
  const productionUrl = customDomain ? `https://${customDomain}/` : `https://${slug}.pages.dev/`;
  return [
    {
      path: "README.md",
      content: `# ${title}\n\nFreeDocStore sample knowledge base created through MCP.\n\n- Engine: Zensical\n- Source: docs/\n- Production target: ${productionUrl}\n`,
    },
    {
      path: "zensical.toml",
      content: [
        `title = "${title.replace(/"/g, '\\"')}"`,
        `base_url = "${productionUrl}"`,
        'content_dir = "docs"',
        'output_dir = "site"',
        "",
        "[navigation]",
        "items = [",
        '  { title = "Start", path = "index.md" },',
        '  { title = "Assessment", path = "assessment.md" }',
        "]",
      ].join("\n"),
    },
    {
      path: "docs/index.md",
      content: [`# ${title}`, "", prompt, "", "This draft was created through the FreeDocStore MCP server."].join("\n"),
    },
    {
      path: "docs/assessment.md",
      content: [
        "# Assessment",
        "",
        "Use this page to define the rubric, evidence sources, and maintenance process for this knowledge base.",
      ].join("\n"),
    },
  ];
}

function makeWorkspaceDraft(input: {
  title: string;
  prompt: string;
  slug: string;
  owner: string;
  customDomain?: string;
  visibility?: string;
}): WorkspaceDraft {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: input.title,
    slug: input.slug,
    owner: input.owner,
    customDomain: input.customDomain ?? "",
    visibility: input.visibility ?? "public",
    prompt: input.prompt,
    files: sampleFiles(input.title, input.prompt, input.slug, input.customDomain),
    liveUrl: "",
    repoUrl: "",
    lastStatus: "Created via MCP",
    createdAt: now,
    updatedAt: now,
    steps: clonePublishSteps(),
  } as WorkspaceDraft;
}

function nextDraftSlug(existing: WorkspaceDraft[], preferred: string): string {
  const base = slugify(preferred || "sample-knowledge-base") || "sample-knowledge-base";
  const used = new Set(existing.map((draft) => draft.slug).filter(Boolean));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export class FreeDocStoreMcp extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({
    name: "FreeDocStore",
    version: "0.2.0",
  });

  declare props: McpProps;

  async init() {
    this.server.tool(
      "whoami",
      "Show the authenticated FreeDocStore MCP account.",
      {},
      async () => txt(JSON.stringify({
        authenticated: Boolean(this.props?.userId),
        userId: this.props?.userId ?? null,
        provider: this.props?.provider ?? null,
        login: this.props?.login ?? null,
        name: this.props?.name ?? null,
        githubUrl: this.props?.githubUrl ?? null,
        scopes: this.props?.scopes ?? [],
      }, null, 2)),
    );

    this.server.tool(
      "workspace_summary",
      "Show the signed-in FreeDocStore console workspace stored for this account.",
      {},
      async () => {
        if (!this.props?.userId) return txt("Not authenticated. Connect with GitHub OAuth first.");
        if (!this.env.FDS_API_KV) return txt("FDS_API_KV is not bound to the MCP worker.");
        const [settings, drafts, activeId] = await Promise.all([
          readWorkspace<Record<string, unknown>>(this.env, this.props.userId, "fds:config:v1"),
          readWorkspace<WorkspaceDraft[]>(this.env, this.props.userId, "fds:kbs:v1"),
          readWorkspace<string>(this.env, this.props.userId, "fds:active-kb:v1"),
        ]);
        const list = Array.isArray(drafts) ? drafts : [];
        const active = list.find((draft) => draft.id === activeId) ?? list[0];
        return txt(JSON.stringify({
          authenticated: true,
          user: {
            userId: this.props.userId,
            login: this.props.login,
            name: this.props.name,
            provider: this.props.provider,
          },
          workspace: {
            draftCount: list.length,
            activeKnowledgeBase: active ? {
              id: active.id,
              title: active.title,
              slug: active.slug,
              owner: active.owner,
              status: active.lastStatus,
              repoUrl: active.repoUrl || null,
              liveUrl: active.liveUrl || null,
              customDomain: active.customDomain || null,
              generatedFileCount: active.files?.length ?? 0,
            } : null,
            settings: settings ?? null,
          },
        }, null, 2));
      },
    );

    this.server.tool(
      "list_workspace_drafts",
      "List KB drafts saved in the signed-in FreeDocStore console workspace.",
      {},
      async () => {
        if (!this.props?.userId) return txt("Not authenticated. Connect with GitHub OAuth first.");
        if (!this.env.FDS_API_KV) return txt("FDS_API_KV is not bound to the MCP worker.");
        const drafts = await readWorkspace<WorkspaceDraft[]>(this.env, this.props.userId, "fds:kbs:v1");
        const list = Array.isArray(drafts) ? drafts : [];
        if (!list.length) return txt("No KB drafts saved in this FreeDocStore workspace.");
        return txt(`${list.length} workspace draft(s):\n\n${list.map(renderDraft).join("\n\n---\n\n")}`);
      },
    );

    this.server.tool(
      "create_workspace_draft",
      "Create a FreeDocStore KB draft in the signed-in console workspace. This creates Zensical Markdown source files in the draft but does not publish a GitHub repo.",
      {
        title: z.string().describe("Knowledge base title"),
        prompt: z.string().describe("What this KB should cover"),
        slug: z.string().optional().describe("Preferred slug. A suffix is added if it already exists."),
        custom_domain: z.string().optional().describe("Optional custom domain, without scheme"),
        visibility: z.enum(["public", "private"]).optional().describe("Repo visibility to use when published"),
      },
      async ({ title, prompt, slug, custom_domain, visibility }) => {
        const userId = requireWorkspaceWrite(this.env, this.props);
        const current = await readWorkspace<WorkspaceDraft[]>(this.env, userId, "fds:kbs:v1");
        const drafts = Array.isArray(current) ? current : [];
        const draft = makeWorkspaceDraft({
          title,
          prompt,
          slug: nextDraftSlug(drafts, slug ?? title),
          owner: this.env.GITHUB_ORG,
          customDomain: custom_domain ?? "",
          visibility: visibility ?? "public",
        });
        await this.env.FDS_API_KV!.put(userKvKey(userId, "fds:kbs:v1"), JSON.stringify([draft, ...drafts]));
        await this.env.FDS_API_KV!.put(userKvKey(userId, "fds:active-kb:v1"), JSON.stringify(draft.id));
        return txt(`Created FreeDocStore workspace draft via MCP.\n\n${renderDraft(draft)}`);
      },
    );

    this.server.tool(
      "create_sample_knowledge_base",
      "Create a small sample FreeDocStore KB draft through MCP for smoke testing.",
      {},
      async () => {
        const userId = requireWorkspaceWrite(this.env, this.props);
        const current = await readWorkspace<WorkspaceDraft[]>(this.env, userId, "fds:kbs:v1");
        const drafts = Array.isArray(current) ? current : [];
        const title = "MCP Sample Knowledge Base";
        const draft = makeWorkspaceDraft({
          title,
          prompt: "A small sample knowledge base created through MCP to verify FreeDocStore account visibility and draft creation.",
          slug: nextDraftSlug(drafts, "mcp-sample-knowledge-base"),
          owner: this.env.GITHUB_ORG,
        });
        await this.env.FDS_API_KV!.put(userKvKey(userId, "fds:kbs:v1"), JSON.stringify([draft, ...drafts]));
        await this.env.FDS_API_KV!.put(userKvKey(userId, "fds:active-kb:v1"), JSON.stringify(draft.id));
        return txt(`Created sample KB draft via MCP.\n\n${renderDraft(draft)}`);
      },
    );

    this.server.tool(
      "platform_guide",
      "Read the FreeDocStore publishing contract and current launch constraints.",
      {},
      async () => txt(`# FreeDocStore Platform Guide

FreeDocStore publishes knowledge bases from GitHub repositories using Zensical only.

Current contract:
- one GitHub repo per KB
- Markdown source lives in docs/
- zensical.toml config at repo root
- Zensical builds to site/
- each KB has its own Cloudflare Pages project
- each KB can attach custom domains
- the platform repo stores registry metadata only
- no embedded static HTML KB folders in the platform repo

Invite readiness:
- ready for design partners who are comfortable with GitHub-backed repos and reviewable AI proposals
- not ready for broad self-serve until authenticated repo creation, custom-domain automation, and write-scoped MCP tools are finished

Recommended first flow:
1. User gives a topic/prompt.
2. Agent creates a Zensical repo plan with publish_plan.
3. Agent drafts Markdown content in docs/.
4. Repo builds with python3 -m zensical build --strict.
5. Cloudflare Pages publishes the repo.
6. Platform registry records repo, Pages project, production URL, and custom domains.
`),
    );

    this.server.tool(
      "list_knowledge_bases",
      "List public FreeDocStore knowledge bases from the platform registry.",
      {},
      async () => {
        const registry = await readRegistry(this.env.REGISTRY_URL);
        const kbs = registry.knowledge_bases ?? [];
        if (kbs.length === 0) return txt("No knowledge bases are registered yet.");
        return txt(`${kbs.length} knowledge base(s):\n\n${kbs.map(renderKb).join("\n\n---\n\n")}`);
      },
    );

    this.server.tool(
      "knowledge_base_info",
      "Get repository, Zensical, Cloudflare, and domain metadata for one registered KB.",
      { id: z.string().describe("Knowledge base id, e.g. true-non-profit") },
      async ({ id }) => {
        const registry = await readRegistry(this.env.REGISTRY_URL);
        const kb = findKnowledgeBase(registry, id);
        if (!kb) return txt(`No registered KB found for "${id}".`);
        return txt(renderKb(kb));
      },
    );

    this.server.tool(
      "check_zensical_repo",
      "Validate that a public GitHub repo matches the FreeDocStore Zensical contract.",
      {
        repo: z.string().describe("Repo as owner/name, or just name under the FreeDocStore org"),
        branch: z.string().optional().describe("Branch to inspect, default main"),
      },
      async ({ repo, branch }) => {
        const fullRepo = repoFromInput(this.env, repo);
        const files = await listRepoFiles(fullRepo, branch ?? "main");
        if (files.length === 0) return txt(`Could not read ${fullRepo}, or it has no files on ${branch ?? "main"}.`);
        const paths = new Set(files.map((f) => f.path));
        const markdown = files.filter((f) => f.path.startsWith("docs/") && f.path.endsWith(".md")).map((f) => f.path);
        const checks = [
          ["zensical.toml at repo root", paths.has("zensical.toml")],
          ["docs/index.md exists", paths.has("docs/index.md")],
          ["docs/ contains Markdown", markdown.length > 0],
          ["generated site/ is not committed", !files.some((f) => f.path === "site" || f.path.startsWith("site/"))],
          ["no embedded static HTML docs", !files.some((f) => f.path.startsWith("docs/") && f.path.endsWith(".html"))],
        ] as const;
        const passed = checks.filter(([, ok]) => ok).length;
        const lines = checks.map(([label, ok]) => `- ${ok ? "OK" : "FAIL"} ${label}`);
        return txt([
          `Zensical contract check for ${fullRepo}: ${passed}/${checks.length}`,
          "",
          lines.join("\n"),
          "",
          `Markdown pages: ${markdown.length ? markdown.join(", ") : "(none)"}`,
        ].join("\n"));
      },
    );

    this.server.tool(
      "list_files",
      "List files in a public KB repo.",
      {
        repo: z.string().describe("Repo as owner/name, or just name under the FreeDocStore org"),
        branch: z.string().optional().describe("Branch to inspect, default main"),
      },
      async ({ repo, branch }) => {
        const fullRepo = repoFromInput(this.env, repo);
        const files = await listRepoFiles(fullRepo, branch ?? "main");
        if (files.length === 0) return txt(`No files found for ${fullRepo}.`);
        return txt(`Files in ${fullRepo}:\n\n${files.map((f) => `- ${f.path}`).join("\n")}`);
      },
    );

    this.server.tool(
      "read_file",
      "Read one source file from a public KB repo.",
      {
        repo: z.string().describe("Repo as owner/name, or just name under the FreeDocStore org"),
        path: z.string().describe("File path, e.g. docs/index.md"),
        branch: z.string().optional().describe("Branch to inspect, default main"),
      },
      async ({ repo, path, branch }) => {
        const fullRepo = repoFromInput(this.env, repo);
        const content = await readRepoFile(fullRepo, path, branch ?? "main");
        if (content === null) return txt(`Could not read ${path} from ${fullRepo}.`);
        return txt(`File: ${fullRepo}/${path}\n\n\`\`\`\n${content}\n\`\`\``);
      },
    );

    this.server.tool(
      "deploy_status",
      "Check the last five GitHub Actions runs for a KB repo.",
      { repo: z.string().describe("Repo as owner/name, registered KB id, or repo name under FreeDocStore") },
      async ({ repo }) => {
        let fullRepo = repoFromInput(this.env, repo);
        const registry = await readRegistry(this.env.REGISTRY_URL);
        const kb = findKnowledgeBase(registry, repo);
        if (kb) fullRepo = kb.source.repo;
        const runs = await getDeployStatus(fullRepo);
        if (!Array.isArray(runs)) return txt(`Error: ${runs.error}`);
        if (runs.length === 0) return txt(`No workflow runs found for ${fullRepo}.`);
        const lines = runs.map((run) => `- ${run.status} ${run.name} (${run.sha}) - ${run.updatedAt}\n  ${run.url}`);
        return txt(`Deploy history for ${fullRepo}:\n\n${lines.join("\n")}`);
      },
    );

    this.server.tool(
      "publish_plan",
      "Turn a knowledge-base topic/prompt into the concrete FreeDocStore repo, Zensical, Cloudflare, and custom-domain plan. This does not create resources yet.",
      {
        title: z.string().describe("Knowledge base title"),
        prompt: z.string().describe("What the KB should cover"),
        slug: z.string().optional().describe("Preferred repo/project slug"),
        custom_domain: z.string().optional().describe("Optional custom domain for this KB"),
      },
      async ({ title, prompt, slug, custom_domain }) => {
        const id = slugify(slug ?? title);
        const domain = custom_domain ? `https://${custom_domain}/` : `https://${id}.${this.env.DEFAULT_DOMAIN}/`;
        return txt(`# Publish Plan: ${title}

KB id: ${id}
Repo: https://github.com/${this.env.GITHUB_ORG}/${id}
Engine: Zensical
Source: docs/
Config: zensical.toml
Build command: python3 -m pip install zensical && python3 -m zensical build --strict
Build output: site/
Cloudflare Pages project: ${id}
Production URL: ${domain}
Custom domain: ${custom_domain ?? "(none yet)"}

Required repo files:
- README.md
- zensical.toml
- .gitignore
- .github/workflows/deploy.yml
- docs/index.md
- docs/<topic-pages>.md

Suggested first pages:
- docs/index.md - overview, audience, scope
- docs/first-principles.md - first-principles model
- docs/assessment-method.md - how to evaluate evidence
- docs/register.md - public register or index

Prompt to turn into Markdown:
${prompt}

Registry record:
\`\`\`json
{
  "id": "${id}",
  "title": "${title}",
  "description": "${prompt.slice(0, 180).replace(/"/g, '\\"')}",
  "engine": "zensical",
  "source": {
    "repo": "${this.env.GITHUB_ORG}/${id}",
    "branch": "main",
    "docs_dir": "docs",
    "config": "zensical.toml"
  },
  "cloudflare": {
    "pages_project": "${id}",
    "production_url": "${domain}",
    "custom_domains": ${custom_domain ? `["${custom_domain}"]` : "[]"}
  },
  "status": "draft-0.1"
}
\`\`\`
`);
      },
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        [
          "FreeDocStore MCP Server",
          "",
          "Connect: npx mcp-remote https://mcp.freedocstore.online/mcp",
          "",
          "Zensical-only knowledge base publishing:",
          "- one GitHub repo per KB",
          "- Markdown in docs/",
          "- zensical.toml at repo root",
          "- Cloudflare Pages project per KB",
          "- custom domains per KB",
          "",
          "Tools: whoami, workspace_summary, list_workspace_drafts, create_workspace_draft, create_sample_knowledge_base, platform_guide, list_knowledge_bases, knowledge_base_info, check_zensical_repo, list_files, read_file, deploy_status, publish_plan",
          "",
          "Auth: OAuth 2.1 via GitHub sign-in when connected through mcp-remote or Claude.",
        ].join("\n"),
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    return oauthProvider.fetch(request, env, ctx);
  },
};

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: FreeDocStoreMcp.serve("/mcp"),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["read", "write"],
  accessTokenTTL: 86_400,
});
