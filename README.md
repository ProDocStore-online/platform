# FreeDocStore Platform

FreeDocStore is the public knowledge-base publishing layer in the Open Frontier store ecosystem.

It turns GitHub-backed Zensical documentation repositories into free public knowledge bases with AI-first editing, reviewable proposals, Cloudflare publishing, search, and agent-readable metadata.

## Product Rule

Editing is AI-first.

Users describe what should change. The AI drafts the change. The user reviews the diff. Manual text editing happens in GitHub, not in a CMS textarea.

## Current Scope

- Product site in `site/`.
- AI-first web workbench at `site/editor.html`.
- FreeDocStore-owned React editor app in `apps/editor/`.
- Remote MCP Worker in `workers/mcp/`.
- Browser extension in `extension/` for editing published docs pages from the side panel.
- Reusable docs templates, deploy workflows, generators, and lint rules in `templates/`.
- GitHub-backed proposal, PR, and extension workflows inherited from the seed engine and kept under FreeDocStore ownership.
- KB publishing supports Zensical-format Markdown repos only for now.

## Local Preview

The public site is static:

```bash
open site/index.html
open site/editor.html
```

Build the extension:

```bash
cd extension
npm install
npm run build
npm test
```

Load `extension/dist/` as an unpacked extension in Chrome.

## Free Layer

FreeDocStore is for public knowledge bases:

- Public docs hosting.
- One GitHub repo per KB.
- Markdown source in `docs/`.
- Zensical config in `zensical.toml`.
- Cloudflare Pages publishing for each KB.
- Optional custom domains per KB.
- AI proposal workflow.
- Manual edits via GitHub.
- Zensical-generated search, sitemap, and metadata.
- Public MCP/read endpoints later.

Free public docs should be cheap to host and easy to mirror, but FreeDocStore does not host copied HTML folders inside the platform repo.

## Pro Pair

ProDocStore is the future private paid layer:

- Private staff/customer knowledge bases.
- Authenticated access.
- Team roles: owner, editor, viewer.
- Private search.
- Audit logs.
- Scoped MCP tokens.
- Custom domains.
- SSO later.

Do not build Pro-only private access into FreeDocStore first. Keep the Free platform public-first, but define interfaces so ProDocStore can reuse the AI editing and publishing engine.

## Repository Layout

```text
site/                 Public FreeDocStore marketing site and AI web editor
apps/editor/          FreeDocStore-owned React app for prompt-to-KB publishing
workers/mcp/          Cloudflare Worker remote MCP server
docs/                 Product and engine docs
extension/            MV3 Chrome extension for AI-first docs editing
templates/            Reusable docs templates, add-ons, lint, and generators
brand/                Brand assets inherited from the seed repo
.github/workflows/    Deploy, release, lint, and test workflows
```

## Published Knowledge Bases

Each knowledge base is its own GitHub repository. The platform registry records the repo, Zensical source layout, Cloudflare Pages project, production URL, and any custom domains.

Local checkouts follow the same store convention as FAS and FGS: each published KB repo is checked out beside `platform`, not inside it.

```text
~/dev/stores/fdocs/
  platform/           FreeDocStore platform monorepo
  true-non-profit/    Published KB repo: FreeDocStore/true-non-profit
  <kb-slug>/          Future published KB repos
```

The first KB is `FreeDocStore/true-non-profit`:

- Source: <https://github.com/FreeDocStore/true-non-profit>
- Production: <https://true-non-profit.pages.dev/>
- Engine: Zensical
- Source directory: `docs/`
- Config: `zensical.toml`

The platform repo does not contain generated KB pages and does not publish `/books/<slug>/` routes.

## MCP

FreeDocStore has a remote MCP server for agents:

- Current endpoint: <https://freedocstore-mcp.serge-the-dev.workers.dev/mcp>
- Discovery: <https://freedocstore.pages.dev/.well-known/mcp.json>
- Local connector: `.mcp.json`
- Source: `workers/mcp/`

Current MCP tools are public/read and planning tools: list KBs, inspect registered KB metadata, validate Zensical repos, read source files, check deploy status, and create a publish plan from a topic prompt.

Authenticated write tools come next: create KB repo, update Markdown files, register custom domains, and publish from prompt.

## Editor

The production editor is a FreeDocStore app:

- Source: `apps/editor/`
- Production: <https://freedocstore-editor.pages.dev/>
- Deploy target: Cloudflare Pages project `freedocstore-editor`

The editor supports multiple KB drafts in one browser, one GitHub repo per KB, Zensical-only Markdown source, Cloudflare Pages publishing, and optional custom domains per KB.

## AI Editor Flow

1. Connect a GitHub file.
2. Describe the desired content change.
3. AI returns a complete replacement proposal.
4. The UI shows a read-only diff.
5. User copies/downloads the proposal or opens GitHub's file editor.

The browser extension has a stronger workflow: it can create proposal previews and apply through GitHub commits/PRs after user approval.

## Near-Term Plan

See `docs/FREEDOCSTORE-PLAN.md`.
