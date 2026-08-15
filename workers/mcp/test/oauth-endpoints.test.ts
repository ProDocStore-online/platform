import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Covers the endpoints OAuthProvider itself owns — discovery, dynamic client
 * registration, and the token endpoint — end to end through the deployed fetch
 * handler. The GitHub-facing half of the flow is covered in auth-handler.test.ts.
 */

const ORIGIN = "https://mcp.prodocstore.online";

interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
}

async function registerClient(redirectUri = "https://client.example/callback"): Promise<RegisteredClient> {
  const res = await SELF.fetch(`${ORIGIN}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test MCP Client",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBeLessThan(300);
  return res.json<RegisteredClient>();
}

async function pkce() {
  const verifier = `verifier-${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

describe("discovery", () => {
  it("advertises the authorization server metadata clients need", async () => {
    const res = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);

    const doc = await res.json<{
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      scopes_supported: string[];
      response_types_supported: string[];
      code_challenge_methods_supported?: string[];
    }>();

    expect(doc.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(doc.token_endpoint).toBe(`${ORIGIN}/token`);
    expect(doc.registration_endpoint).toBe(`${ORIGIN}/register`);
    expect(doc.response_types_supported).toContain("code");
    // Both scopes are advertised; write is only ever *granted* on explicit request.
    expect(doc.scopes_supported).toEqual(["read", "write"]);
  });
});

describe("dynamic client registration", () => {
  it("registers a client and returns a usable client id", async () => {
    const client = await registerClient();
    expect(client.client_id).toBeTruthy();
    expect(client.redirect_uris).toEqual(["https://client.example/callback"]);
  });

  it("rejects a registration with no redirect_uris", async () => {
    const res = await SELF.fetch(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "No Redirects" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("GET /authorize", () => {
  it("hands a registered client off to GitHub", async () => {
    const client = await registerClient();
    const { challenge } = await pkce();

    const url = new URL(`${ORIGIN}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.client_id);
    url.searchParams.set("redirect_uri", "https://client.example/callback");
    url.searchParams.set("scope", "read");
    url.searchParams.set("state", "client-state");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    const res = await SELF.fetch(url, { redirect: "manual" });
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("scope")).toBe("read:user");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("rejects an authorize call for an unregistered client", async () => {
    const url = new URL(`${ORIGIN}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "never-registered");
    url.searchParams.set("redirect_uri", "https://client.example/callback");

    const res = await SELF.fetch(url, { redirect: "manual" });
    expect(res.status).toBe(400);
  });
});

describe("POST /token", () => {
  it("rejects an authorization code that was never issued", async () => {
    const client = await registerClient();
    const { verifier } = await pkce();

    const res = await SELF.fetch(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "fabricated-code",
        client_id: client.client_id,
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
      }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBeTruthy();
  });

  it("rejects an unsupported grant type", async () => {
    const client = await registerClient();
    const res = await SELF.fetch(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: client.client_id,
      }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects a refresh token it never issued", async () => {
    const client = await registerClient();
    const res = await SELF.fetch(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "fabricated-refresh-token",
        client_id: client.client_id,
      }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
