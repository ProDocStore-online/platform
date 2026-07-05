# FreeDocStore Plan

## Goal

Create a free public knowledge-base publishing platform with AI-first content updates.

FreeDocStore should publish public docs for projects, products, communities, courses, and open knowledge bases. It should not become a generic CMS or a private intranet product in the first pass.

## FreeDocStore MVP

### Public KB Registry

Track public knowledge bases with:

- id
- name
- owner GitHub repo
- source path
- docs engine
- public URL
- last build status
- last published commit

### Supported Sources

Start with one source shape only:

- Zensical-format Markdown repositories
- one GitHub repository per KB
- `docs/` as the source directory
- `zensical.toml` as the build config
- Cloudflare Pages as the publishing target

Later:

- MkDocs
- Astro/Starlight
- Docusaurus

### AI-First Editing

Web workbench:

- load source file from GitHub
- ask AI for a replacement proposal
- show read-only diff
- open GitHub editor for manual edits

Extension:

- detect published page's backing repo
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

Do not build a multi-tenant hosted backend until the workflow proves useful.

### Agent Metadata

Each published KB should expose:

- `llms.txt`
- sitemap
- search index
- MCP discovery document later

## ProDocStore Boundary

ProDocStore is paid and private:

- staff/customer access
- auth and RBAC
- private search
- audit logs
- scoped MCP tokens
- custom domains
- SSO later

Do not mix these into the Free MVP except where shared abstractions are obvious.

## First Implementation Milestones

1. Keep the FreeDocStore platform productized under FreeDocStore ownership.
2. Add a public KB registry JSON file and render it on the site.
3. Add one example KB import/publish workflow.
4. Make the AI editor able to open a PR, not only copy/open GitHub.
5. Add `llms.txt` generation for registered KBs.
6. Document the ProDocStore split.
