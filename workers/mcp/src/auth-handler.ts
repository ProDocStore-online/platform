import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";

type Bindings = {
  OAUTH_KV: KVNamespace;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  OAUTH_PROVIDER: OAuthHelpers;
};

interface GitHubUser {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string | null;
  html_url?: string;
}

const app = new Hono<{ Bindings: Bindings }>();

app.get("/authorize", async (c) => {
  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid OAuth request";
    return c.text(message, 400);
  }
  if (!oauthReqInfo.clientId) return c.text("Invalid OAuth request", 400);
  if (!c.env.GITHUB_CLIENT_ID) return c.text("GitHub OAuth is not configured", 503);

  const nonce = crypto.randomUUID();
  await c.env.OAUTH_KV.put(`authreq:${nonce}`, JSON.stringify(oauthReqInfo), { expirationTtl: 600 });

  const callback = new URL("/callback", c.req.url);
  callback.searchParams.set("nonce", nonce);

  const github = new URL("https://github.com/login/oauth/authorize");
  github.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
  github.searchParams.set("redirect_uri", callback.toString());
  github.searchParams.set("scope", "read:user");
  github.searchParams.set("state", nonce);
  github.searchParams.set("allow_signup", "true");
  return c.redirect(github.toString(), 302);
});

app.get("/callback", async (c) => {
  const nonce = c.req.query("nonce");
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (!nonce || !state || nonce !== state || !code) return c.text("Invalid OAuth callback", 400);
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) return c.text("GitHub OAuth is not configured", 503);

  const raw = await c.env.OAUTH_KV.get(`authreq:${nonce}`);
  if (!raw) return c.text("Expired OAuth request", 400);
  await c.env.OAUTH_KV.delete(`authreq:${nonce}`);
  const oauthReqInfo = JSON.parse(raw) as AuthRequest;
  if (!oauthReqInfo.clientId) return c.text("Invalid stored OAuth request", 400);

  const redirectUri = new URL("/callback", c.req.url);
  redirectUri.searchParams.set("nonce", nonce);
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri.toString(),
    }),
  });
  if (!tokenRes.ok) return c.text(`GitHub token exchange failed: ${tokenRes.status}`, 502);
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!tokenJson.access_token) return c.text(tokenJson.error_description || tokenJson.error || "GitHub returned no access token", 502);

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenJson.access_token}`,
      "User-Agent": "prodocstore-mcp",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!userRes.ok) return c.text(`GitHub user fetch failed: ${userRes.status}`, 502);
  const user = (await userRes.json()) as GitHubUser;
  const userId = `github_${user.id}`;
  const scopes = parseScopes(oauthReqInfo.scope);

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId,
    scope: scopes,
    metadata: { label: user.login },
    props: {
      userId,
      provider: "github",
      login: user.login,
      name: user.name || user.login,
      avatarUrl: user.avatar_url || undefined,
      githubUrl: user.html_url || `https://github.com/${user.login}`,
      scopes,
    },
  });
  return c.redirect(redirectTo, 302);
});

function parseScopes(value: string | string[] | null | undefined): string[] {
  if (!value) return ["read", "write"];
  const parts = Array.isArray(value) ? value : value.split(/[,\s]+/);
  const known = parts.filter((part) => part === "read" || part === "write");
  return known.length ? Array.from(new Set(known)) : ["read", "write"];
}

export { app as AuthHandler };
