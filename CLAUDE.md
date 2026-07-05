# FreeDocStore

FreeDocStore is the free public knowledge-base publisher for the OFO store ecosystem.

## Identity

| Key | Value |
| --- | --- |
| Store code | FDOCS |
| Domain | freedocstore.online |
| GitHub org | FreeDocStore |
| Local path | `~/dev/stores/fdocs/platform` |
| Pro pair | ProDocStore |

## Product Thesis

Public knowledge should be free to publish, easy for AI agents to read, and safe to update through reviewable proposals.

FreeDocStore is not a generic CMS. It is an AI-first docs publishing platform:

- content changes start as prompts
- AI drafts a proposal
- users review diffs
- GitHub remains the manual editing and review surface
- published output is static, searchable, and agent-readable

## Editing Rule

Do not add in-app rich text editors or Markdown body editors to FreeDocStore.

The product rule is:

```text
prompt -> proposal -> diff -> GitHub commit/PR
```

Manual edits happen in GitHub.

## Current State

This platform is the FreeDocStore-owned knowledge-base publishing monorepo. Keep useful engine internals, but product-facing copy should say FreeDocStore.

Important inherited pieces:

- `extension/` has the mature Chrome side-panel proposal workflow.
- `site/editor.html` is the lightweight AI-first web workbench.
- `templates/` has reusable docs generation and lint tooling.
- `docs/` contains product and engine docs and should stay aligned with the Zensical-only publishing direction.

## Architecture Direction

FreeDocStore should stay public-first:

- GitHub is the source of truth.
- Static builds are the publication artifact.
- Cloudflare Pages/Workers/R2 can host public output.
- D1 may hold registry/build metadata later.
- MCP should expose read/search/propose tools before write tools.

Private KB features belong in ProDocStore, not the first FreeDocStore MVP.

## Commands

```bash
open site/index.html
open site/editor.html

cd extension
npm install
npm run build
npm run typecheck
npm test
```

## Near-Term Work

1. Keep the product docs aligned with the FreeDocStore publishing model.
2. Add a registry model for public knowledge bases.
3. Add a build/publish path for Zensical Markdown docs.
4. Decide Cloudflare hosting topology.
5. Then create the ProDocStore plan for private customer/staff KBs.
