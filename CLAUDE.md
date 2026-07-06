# ProDocStore

ProDocStore is the paid/private knowledge-base publisher for customer and staff documentation.

## Identity

| Key | Value |
| --- | --- |
| Store code | PDOCS |
| Domain | prodocstore.online |
| GitHub org | ProDocStore-online |
| Local path | `~/dev/stores/pdocs/platform` |
| Free pair | FreeDocStore |

## Product Thesis

Private teams should be able to prompt, review, and publish secure knowledge bases without leaving GitHub as the source of truth.

ProDocStore is not a generic CMS. It is an AI-first Zensical publishing platform:

- content changes start as prompts
- AI drafts Markdown source or replacement proposals
- users review files and diffs
- GitHub remains the manual editing and review surface
- each KB is its own repo and Cloudflare Pages project
- private/customer controls belong here, not in FreeDocStore

## Editing Rule

Do not add in-app rich text editors or Markdown body editors.

The product rule is:

```text
prompt -> proposal -> diff/source files -> GitHub commit/PR -> Zensical publish
```

Manual edits happen in GitHub.

## Architecture Direction

- GitHub is the source of truth.
- Zensical Markdown is the only supported source format for now.
- The console is a React/PWA app under `apps/editor/`.
- The API owns OAuth, user workspace state, and encrypted BYOK.
- The MCP server uses the same account workspace as the console.
- Cloudflare Pages/Workers/KV are independent from FreeDocStore.
- Private repo deploy secrets need repo-level secrets unless the GitHub org has a paid plan.

## Commands

```bash
pnpm test
pnpm --dir apps/editor build
npm --prefix workers/api run typecheck
npm --prefix workers/mcp run typecheck

cd extension
npm run build
npm run typecheck
npm test
```
