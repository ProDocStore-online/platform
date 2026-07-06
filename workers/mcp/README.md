# ProDocStore MCP Server

Remote MCP server for agents that publish and maintain ProDocStore knowledge bases.

Canonical source: `workers/mcp/` in <https://github.com/ProDocStore-online/platform>.

ProDocStore is Zensical-only for now:

- one GitHub repo per KB
- Markdown source in `docs/`
- Zensical config in `zensical.toml`
- Cloudflare Pages project per KB
- optional custom domains per KB
- no embedded static HTML folders inside the platform repo

## Endpoint

Current deployed endpoint:

```bash
https://mcp.prodocstore.online/mcp
```

Health:

```bash
https://mcp.prodocstore.online/health
```

## Connect

```bash
codex mcp add prodocstore --url https://mcp.prodocstore.online/mcp
```

or:

```bash
claude mcp add --scope user --transport http prodocstore https://mcp.prodocstore.online/mcp
```

## Tools

| Tool | Auth | Description |
| --- | --- | --- |
| `whoami` | GitHub OAuth | Show the signed-in account |
| `workspace_summary` | GitHub OAuth | Show saved console workspace state for the signed-in account |
| `list_workspace_drafts` | GitHub OAuth | List KB drafts saved in the console workspace |
| `create_workspace_draft` | GitHub OAuth + write | Create a console-visible Zensical KB draft |
| `create_sample_knowledge_base` | GitHub OAuth + write | Create a sample KB draft for smoke testing |
| `platform_guide` | none | ProDocStore rules and Zensical publishing contract |
| `list_knowledge_bases` | none | Read the public registry |
| `knowledge_base_info` | none | Show repo, Cloudflare project, URLs, custom domains |
| `check_zensical_repo` | none | Validate a public repo has `zensical.toml` and `docs/` Markdown |
| `list_files` | none | List files in a public KB repo |
| `read_file` | none | Read one source file from a public KB repo |
| `deploy_status` | none | Last GitHub Actions runs for a KB repo |
| `publish_plan` | none | Turn a prompt/topic into a repo, Zensical, Cloudflare, and domain plan |

OAuth sign-in is GitHub-based and uses the same remote MCP flow as the other stores:

```bash
claude mcp add --scope user --transport http prodocstore https://mcp.prodocstore.online/mcp
```

The Worker requires:

- `OAUTH_KV`
- `PDS_API_KV`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`

Production OAuth secrets are stored in SOPS as:

- `pdocs.MCP_GITHUB_CLIENT_ID`
- `pdocs.MCP_GITHUB_CLIENT_SECRET`

The GitHub OAuth callback URL is:

```text
https://mcp.prodocstore.online/callback
```

Current write tools create and update console workspace drafts only. `create_workspace_draft` and `create_sample_knowledge_base` create Zensical Markdown files in the signed-in user's ProDocStore workspace, so they are visible in the console. They do not yet create GitHub repositories, attach domains, or trigger Cloudflare Pages deploys directly from MCP.

Future direct publish tools:

- `create_knowledge_base`
- `update_files`
- `register_custom_domain`
- `publish_from_prompt`

## Development

```bash
npm install
npm run typecheck
npm run dev
npm run deploy
```
