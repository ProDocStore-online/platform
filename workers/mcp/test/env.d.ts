// Bindings the tests reach for on `env` from `cloudflare:test`.
//
// Optionality has to mirror the worker's own Env interface in src/index.ts:
// McpAgent constrains its Env type parameter to Cloudflare.Env, so declaring a
// binding required here that the worker treats as optional fails typecheck.
declare namespace Cloudflare {
  interface Env {
    OAUTH_KV: KVNamespace;
    PDS_API_KV?: KVNamespace;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    MCP_READ_ONLY?: string;
  }
}
