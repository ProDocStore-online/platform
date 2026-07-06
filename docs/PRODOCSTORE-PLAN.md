# ProDocStore Plan

## Goal

Create the paid/private knowledge-base publishing platform for customer and staff documentation.

ProDocStore publishes Zensical Markdown knowledge bases from GitHub repos. It should support closed customer workspaces, private repos, secure staff access, custom domains, BYOK, and MCP-visible account workflows.

## MVP

### Customer KB Registry

Track knowledge bases with:

- id
- title
- owner GitHub repo
- source path
- visibility
- docs engine
- production URL
- custom domains
- last build status
- last published commit

### Supported Sources

Start with one source shape only:

- Zensical-format Markdown repositories
- one GitHub repository per KB
- `docs/` as the source directory
- `zensical.toml` as the build config
- Cloudflare Pages as the publishing target

Do not support copied static HTML folders as source.

### AI-First Editing

Console:

- sign in with Google/GitHub
- save OpenAI BYOK in the Profile page
- create multiple KB drafts
- generate Zensical source files from a prompt
- show source/preview/diff side by side
- publish to a GitHub repo
- record custom domain intent

Extension:

- detect a published page's backing repo
- use page context
- ask/edit threads
- preview proposals
- apply through commit or PR

### Publishing

First pass stays Zensical-only:

- Markdown source in each KB repo
- Zensical build in GitHub Actions
- Cloudflare Pages deploy per KB
- custom domains attached per KB project
- private repo deploy secrets set repo-level unless the GitHub org moves to a paid plan

### Access And Security

ProDocStore needs:

- account workspace state in platform KV
- encrypted per-user BYOK
- repo visibility controls
- private/customer access model
- audit trail for AI proposals and publishes
- scoped MCP tokens
- SSO later

## Boundary

FreeDocStore is the free/public product. ProDocStore is paid/private. They can share Zensical templates and workflow patterns, but they must not share:

- Cloudflare KV namespaces
- OAuth apps
- Chrome Web Store listings
- customer data
- product copy
- production routes

## First Implementation Milestones

1. Keep the ProDocStore platform productized under `ProDocStore-online`.
2. Use ProDocStore-specific Cloudflare KV namespaces and routes.
3. Save ProDocStore secrets in the SOPS repo from day one.
4. Deploy console, API, MCP, and product site to `prodocstore.online`.
5. Create OAuth apps for console and MCP.
6. Add GitHub PAT and Cloudflare token secrets from SOPS to their consumers.
7. Publish the first private/customer KB repo through the console or MCP.
