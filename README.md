# FreeDocStore Platform

FreeDocStore is the public knowledge-base publishing layer in the Open Frontier store ecosystem.

It turns GitHub-backed documentation into free public knowledge bases with AI-first editing, reviewable proposals, static publishing, search, `llms.txt`, and agent-readable metadata.

## Product Rule

Editing is AI-first.

Users describe what should change. The AI drafts the change. The user reviews the diff. Manual text editing happens in GitHub, not in a CMS textarea.

## Current Scope

- Static marketing site in `site/`.
- AI-first web workbench at `site/editor.html`.
- Browser extension in `extension/` for editing published docs pages from the side panel.
- Reusable docs templates, deploy workflows, generators, and lint rules in `templates/`.
- Existing Glassdocs engine code used as the starting point for GitHub-backed proposal, PR, and extension workflows.

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
- GitHub-backed source.
- AI proposal workflow.
- Manual edits via GitHub.
- Static search and navigation.
- `llms.txt`, sitemap, and metadata generation.
- Public MCP/read endpoints later.

Free public docs should be cheap to host and easy to mirror.

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
books/                Published knowledge books; each book has a docs/ source folder
docs/                 Product/engine docs copied from the Glassdocs seed
extension/            MV3 Chrome extension for AI-first docs editing
templates/            Reusable docs templates, add-ons, lint, and generators
brand/                Brand assets inherited from the seed repo
.github/workflows/    Deploy, release, lint, and test workflows
```

## Published Books

The first book is `books/true-non-profit/docs`.

GitHub Pages publishes each `books/<slug>/docs` folder under `/books/<slug>/` by assembling a Pages artifact from `site/` plus all book docs folders.

## AI Editor Flow

1. Connect a GitHub file.
2. Describe the desired content change.
3. AI returns a complete replacement proposal.
4. The UI shows a read-only diff.
5. User copies/downloads the proposal or opens GitHub's file editor.

The browser extension has a stronger workflow: it can create proposal previews and apply through GitHub commits/PRs after user approval.

## Near-Term Plan

See `docs/FREEDOCSTORE-PLAN.md`.
