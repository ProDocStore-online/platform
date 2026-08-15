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
| `mcp_audit_log` | GitHub OAuth | Read this account's write attempts, dry runs, and refusals |
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

## Scopes and write safety

Two scopes exist, `read` and `write`, and **`write` is granted only when the
client explicitly asks for it**. A connection that requests no scope gets
read-only access, so the write tools refuse until you reconnect asking for
`write`. This is deliberately stricter than PAGS, which can default-grant
`write` because its destructive tools sit behind a separate `destructive`
scope; here `write` is itself the gate on the only mutable state the server has.

Every mutating tool follows the PAGS/PAS gate order:

```text
requirePermission -> dry_run (previews, writes nothing) -> confirm -> write
```

- **`dry_run: true`** returns the exact draft, file list, and whether the write
  would displace the active KB. It writes nothing, and needs no confirmation.
- **`confirm`** is required once the workspace already holds drafts, because a
  new draft becomes the console's active KB. Pass the tool's own name, e.g.
  `confirm="create_workspace_draft"`.
- **Everything is audited** — grants, dry runs, and refusals alike — to
  `OAUTH_KV` under `audit:<userId>:`, retained 90 days, with credential-shaped
  keys and values redacted. Read it back with `mcp_audit_log`.

Set the `MCP_READ_ONLY = "1"` var to refuse every mutating tool without
deploying new code.

## Configuration

The Worker requires:

- `OAUTH_KV` — OAuth state and the audit log
- `PDS_API_KV` — the per-user console workspace
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`

ProDocStore owns its **own** GitHub OAuth app, registered under the
`ProDocStore-online` org, with callback:

```text
https://mcp.prodocstore.online/callback
```

It is a different app from the console's — that one is consumed by
`prodocstore-api` with callback `https://api.prodocstore.online/auth/github/callback` —
and unrelated to the dormant FreeDocStore MCP app. This worker must never be
pointed at either.

Production OAuth secrets are stored in SOPS as:

- `pdocs.MCP_GITHUB_CLIENT_ID`
- `pdocs.MCP_GITHUB_CLIENT_SECRET`

When neither is set, `/authorize` and `/callback` return `503 GitHub OAuth is
not configured` and `/health` reports `oauthConfigured: false`. Nothing falls
back to another store's OAuth app.

## Smoke test

Confirm configuration before connecting anything:

```bash
curl -s https://mcp.prodocstore.online/health | jq
# expect: ok true, oauthConfigured true, storageConfigured true,
#         callbackUrl https://mcp.prodocstore.online/callback
```

The origin is not the MCP endpoint; a protocol client pointed at it is turned
away rather than handed a stream it would reconnect to forever:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mcp.prodocstore.online/
# expect: 405
```

Connect a live client. Either the native transport:

```bash
claude mcp add --scope user --transport http prodocstore https://mcp.prodocstore.online/mcp
```

or `mcp-remote`, which is the path to use when a client cannot speak HTTP
transport directly, and the one to reach for when debugging the OAuth
round-trip because it prints each step:

```bash
npx mcp-remote https://mcp.prodocstore.online/mcp
```

Either way a browser opens for GitHub sign-in. Then, in the client:

1. `whoami` — expect `authenticated: true`, your GitHub login, and
   `scopes: ["read"]` on a default connection.
2. `create_sample_knowledge_base` with `dry_run: true` — expect a JSON preview
   with `dryRun: true` and no change in the console.
3. `create_sample_knowledge_base` with no arguments — on a read-only
   connection this **should refuse** with `requires MCP scope "write"`. That
   refusal is the gate working, not a broken connection.
4. `mcp_audit_log` — expect the dry run and the refusal both recorded.

To exercise the write path, reconnect requesting the `write` scope, then repeat
step 3; if the workspace already holds drafts it will ask for
`confirm="create_sample_knowledge_base"`. A successful create appears in the
console at <https://console.prodocstore.online> as the active KB.

Reconnect behaviour: tokens last 24h (`accessTokenTTL`), and a client
reconnecting after expiry re-runs the GitHub round trip. Scopes are re-evaluated
at that point — a token minted before the fail-closed change carried `write`
implicitly and will come back read-only.

Current write tools create and update console workspace drafts only. `create_workspace_draft` and `create_sample_knowledge_base` create Zensical Markdown files in the signed-in user's ProDocStore workspace, so they are visible in the console. They do not yet create GitHub repositories, attach domains, or trigger Cloudflare Pages deploys directly from MCP.

Future direct publish tools:

- `create_knowledge_base`
- `update_files`
- `register_custom_domain`
- `publish_from_prompt`

These will be genuinely destructive in a way today's draft tools are not — they
overwrite repository content and DNS. Each must go through the same gates in
`src/safety.ts`, and unlike the draft tools should require `confirm`
unconditionally rather than only when displacing existing state.

## Development

```bash
npm install
npm run typecheck
npm run test
npm run dev
npm run deploy
```

Tests run in workerd via `@cloudflare/vitest-pool-workers`, against the real
`wrangler.toml` bindings:

- `test/auth-handler.test.ts` — scope grants, the GitHub authorize/callback
  round trip, callback and token-exchange failures, nonce replay
- `test/oauth-endpoints.test.ts` — discovery, dynamic client registration, and
  the token endpoint, against the real OAuthProvider
- `test/safety.test.ts` — permission, confirmation, dry-run, audit, redaction
- `test/transport.test.ts` — `/health`, the origin banner, and the wrong-endpoint
  405 that stops protocol clients reconnect-looping

`npm run test` from the repo root runs these after the three typechecks.
