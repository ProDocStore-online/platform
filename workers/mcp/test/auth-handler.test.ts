import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHandler, parseScopes } from "../src/auth-handler.js";

/**
 * These drive the Hono auth app directly rather than through SELF, so the
 * OAuthHelpers binding can be a spy and the GitHub calls can be stubbed on the
 * global fetch. The OAuthProvider-owned endpoints (discovery, registration,
 * token) are covered against the real provider in oauth-endpoints.test.ts.
 */

interface CompleteAuthorizationCall {
  request: { clientId?: string; scope?: string | string[] };
  userId: string;
  scope: string[];
  metadata?: Record<string, unknown>;
  props?: Record<string, unknown>;
}

function makeKv() {
  const store = new Map<string, string>();
  const puts: Array<{ key: string; options?: { expirationTtl?: number } }> = [];
  return {
    store,
    puts,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, value);
      puts.push({ key, options });
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  const kv = makeKv();
  const completeAuthorizationCalls: CompleteAuthorizationCall[] = [];
  const env = {
    OAUTH_KV: kv,
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    OAUTH_PROVIDER: {
      parseAuthRequest: vi.fn(async () => ({
        clientId: "client-123",
        redirectUri: "https://client.example/callback",
        scope: "read write",
        state: "client-state",
      })),
      completeAuthorization: vi.fn(async (call: CompleteAuthorizationCall) => {
        completeAuthorizationCalls.push(call);
        return { redirectTo: "https://client.example/callback?code=granted" };
      }),
    },
    ...overrides,
  };
  return { env, kv, completeAuthorizationCalls };
}

/** Seed KV as if /authorize had already run, and return the nonce. */
async function seedAuthRequest(kv: ReturnType<typeof makeKv>, scope?: string | string[]) {
  const nonce = "nonce-under-test";
  await kv.put(`authreq:${nonce}`, JSON.stringify({ clientId: "client-123", scope }));
  return nonce;
}

function githubStub(options: {
  tokenResponse?: Response;
  userResponse?: Response;
} = {}) {
  const calls: string[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.includes("login/oauth/access_token")) {
      return options.tokenResponse ?? Response.json({ access_token: "gho_test_token" });
    }
    if (url.includes("api.github.com/user")) {
      return options.userResponse ?? Response.json({ id: 4242, login: "octocat", name: "Octo Cat", html_url: "https://github.com/octocat" });
    }
    throw new Error(`unexpected outbound fetch: ${url}`);
  });
  vi.stubGlobal("fetch", stub);
  return { stub, calls };
}

// Hono's generics don't know about our hand-rolled test doubles.
const asEnv = (env: unknown) => env as never;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseScopes", () => {
  it("grants read-only when no scope is requested", () => {
    expect(parseScopes(undefined)).toEqual(["read"]);
    expect(parseScopes(null)).toEqual(["read"]);
    expect(parseScopes("")).toEqual(["read"]);
  });

  it("grants read-only when only unknown scopes are requested", () => {
    expect(parseScopes("admin")).toEqual(["read"]);
    expect(parseScopes("openid profile")).toEqual(["read"]);
  });

  it("grants write only when write is explicitly requested", () => {
    expect(parseScopes("write")).toEqual(["read", "write"]);
    expect(parseScopes("read write")).toEqual(["read", "write"]);
    expect(parseScopes("read,write")).toEqual(["read", "write"]);
    expect(parseScopes(["write"])).toEqual(["read", "write"]);
  });

  it("never returns duplicates or an empty grant", () => {
    expect(parseScopes("read read write write")).toEqual(["read", "write"]);
    expect(parseScopes("read")).toEqual(["read"]);
  });
});

describe("GET /authorize", () => {
  it("redirects to GitHub with the configured client id and a nonce-bound callback", async () => {
    const { env, kv } = makeEnv();
    const res = await AuthHandler.request("https://mcp.prodocstore.online/authorize?client_id=client-123", {}, asEnv(env));

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("scope")).toBe("read:user");

    const state = location.searchParams.get("state")!;
    const callback = new URL(location.searchParams.get("redirect_uri")!);
    expect(callback.pathname).toBe("/callback");
    expect(callback.searchParams.get("nonce")).toBe(state);

    // The pending request is parked in KV under the nonce, with a bounded TTL.
    expect(kv.store.has(`authreq:${state}`)).toBe(true);
    expect(kv.puts[0].options?.expirationTtl).toBe(600);
  });

  it("returns 503 when GitHub OAuth is not configured", async () => {
    const { env } = makeEnv({ GITHUB_CLIENT_ID: undefined });
    const res = await AuthHandler.request("https://mcp.prodocstore.online/authorize", {}, asEnv(env));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("GitHub OAuth is not configured");
  });

  it("returns 400 when the OAuth request cannot be parsed", async () => {
    const { env } = makeEnv();
    env.OAUTH_PROVIDER.parseAuthRequest = vi.fn(async () => {
      throw new Error("missing response_type");
    }) as never;
    const res = await AuthHandler.request("https://mcp.prodocstore.online/authorize", {}, asEnv(env));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("missing response_type");
  });

  it("returns 400 when the parsed request carries no client id", async () => {
    const { env } = makeEnv();
    env.OAUTH_PROVIDER.parseAuthRequest = vi.fn(async () => ({ clientId: "" })) as never;
    const res = await AuthHandler.request("https://mcp.prodocstore.online/authorize", {}, asEnv(env));
    expect(res.status).toBe(400);
  });
});

describe("GET /callback", () => {
  it("completes authorization and redirects back to the client", async () => {
    const { env, kv, completeAuthorizationCalls } = makeEnv();
    const nonce = await seedAuthRequest(kv, "read write");
    const { calls } = githubStub();

    const res = await AuthHandler.request(
      `https://mcp.prodocstore.online/callback?nonce=${nonce}&state=${nonce}&code=gh-code`,
      {},
      asEnv(env),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://client.example/callback?code=granted");
    expect(calls.some((url) => url.includes("login/oauth/access_token"))).toBe(true);
    expect(calls.some((url) => url.includes("api.github.com/user"))).toBe(true);

    const call = completeAuthorizationCalls[0];
    expect(call.userId).toBe("github_4242");
    expect(call.props?.login).toBe("octocat");
    expect(call.props?.provider).toBe("github");
  });

  it("consumes the nonce so a callback cannot be replayed", async () => {
    const { env, kv } = makeEnv();
    const nonce = await seedAuthRequest(kv, "read");
    githubStub();

    const first = await AuthHandler.request(
      `https://mcp.prodocstore.online/callback?nonce=${nonce}&state=${nonce}&code=gh-code`,
      {},
      asEnv(env),
    );
    expect(first.status).toBe(302);
    expect(kv.store.has(`authreq:${nonce}`)).toBe(false);

    const replay = await AuthHandler.request(
      `https://mcp.prodocstore.online/callback?nonce=${nonce}&state=${nonce}&code=gh-code`,
      {},
      asEnv(env),
    );
    expect(replay.status).toBe(400);
    expect(await replay.text()).toBe("Expired OAuth request");
  });

  describe("grants the scope the client asked for", () => {
    it("grants read-only when the stored request had no scope", async () => {
      const { env, kv, completeAuthorizationCalls } = makeEnv();
      const nonce = await seedAuthRequest(kv, undefined);
      githubStub();

      await AuthHandler.request(
        `https://mcp.prodocstore.online/callback?nonce=${nonce}&state=${nonce}&code=gh-code`,
        {},
        asEnv(env),
      );

      // Regression guard: this used to hand out ["read", "write"], which made
      // requireWorkspaceWrite() in index.ts unenforceable.
      expect(completeAuthorizationCalls[0].scope).toEqual(["read"]);
      expect(completeAuthorizationCalls[0].props?.scopes).toEqual(["read"]);
    });

    it("grants read+write when the stored request asked for write", async () => {
      const { env, kv, completeAuthorizationCalls } = makeEnv();
      const nonce = await seedAuthRequest(kv, "read write");
      githubStub();

      await AuthHandler.request(
        `https://mcp.prodocstore.online/callback?nonce=${nonce}&state=${nonce}&code=gh-code`,
        {},
        asEnv(env),
      );

      expect(completeAuthorizationCalls[0].scope).toEqual(["read", "write"]);
    });
  });

  describe("rejects malformed callbacks", () => {
    it.each([
      ["missing code", "?nonce=n&state=n"],
      ["missing nonce", "?state=n&code=c"],
      ["missing state", "?nonce=n&code=c"],
      ["state that does not match the nonce", "?nonce=n&state=other&code=c"],
    ])("returns 400 for %s", async (_label, query) => {
      const { env } = makeEnv();
      const res = await AuthHandler.request(`https://mcp.prodocstore.online/callback${query}`, {}, asEnv(env));
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("Invalid OAuth callback");
    });

    it("returns 503 when GitHub OAuth is not configured", async () => {
      const { env } = makeEnv({ GITHUB_CLIENT_SECRET: undefined });
      const res = await AuthHandler.request(
        "https://mcp.prodocstore.online/callback?nonce=n&state=n&code=c",
        {},
        asEnv(env),
      );
      expect(res.status).toBe(503);
    });

    it("returns 400 when the nonce is unknown or expired", async () => {
      const { env } = makeEnv();
      const res = await AuthHandler.request(
        "https://mcp.prodocstore.online/callback?nonce=gone&state=gone&code=c",
        {},
        asEnv(env),
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("Expired OAuth request");
    });
  });

  describe("surfaces GitHub token-exchange failures", () => {
    it("returns 502 when the token endpoint errors", async () => {
      const { env, kv } = makeEnv();
      const nonce = await seedAuthRequest(kv, "read");
      githubStub({ tokenResponse: new Response("nope", { status: 500 }) });

      const res = await AuthHandler.request(
        `https://mcp.prodocstore.online/callback?nonce=${nonce}&state=${nonce}&code=c`,
        {},
        asEnv(env),
      );
      expect(res.status).toBe(502);
      expect(await res.text()).toContain("GitHub token exchange failed: 500");
    });

    it("returns 502 with GitHub's description when no access token comes back", async () => {
      const { env, kv } = makeEnv();
      const nonce = await seedAuthRequest(kv, "read");
      githubStub({
        tokenResponse: Response.json({ error: "bad_verification_code", error_description: "The code is incorrect." }),
      });

      const res = await AuthHandler.request(
        `https://mcp.prodocstore.online/callback?nonce=${nonce}&state=${nonce}&code=c`,
        {},
        asEnv(env),
      );
      expect(res.status).toBe(502);
      expect(await res.text()).toBe("The code is incorrect.");
    });

    it("returns 502 when the user lookup fails", async () => {
      const { env, kv } = makeEnv();
      const nonce = await seedAuthRequest(kv, "read");
      githubStub({ userResponse: new Response("unauthorized", { status: 401 }) });

      const res = await AuthHandler.request(
        `https://mcp.prodocstore.online/callback?nonce=${nonce}&state=${nonce}&code=c`,
        {},
        asEnv(env),
      );
      expect(res.status).toBe(502);
      expect(await res.text()).toContain("GitHub user fetch failed: 401");
    });
  });
});
