import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import sealedbox from "tweetnacl-sealedbox-js";

import { type Env, type Session, type Variables, type AuthProvider } from "./types";
import { registerKbRoutes } from "./routes/kb";
import { registerPublishRoutes } from "./routes/publish";

interface GitHubUser {
  id: number;
  login: string;
  email?: string | null;
  name?: string | null;
  avatar_url?: string | null;
  html_url?: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility?: string | null;
}

interface GoogleUser {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  profile?: string;
}

interface StoredSecret {
  v: number;
  alg: "AES-GCM";
  iv: string;
  ciphertext: string;
  label: string;
}

interface GitHubToken {
  source: "platform" | "session";
  value: string;
}

interface PublishFormInput {
  title?: unknown;
  slug?: unknown;
  owner?: unknown;
  customDomain?: unknown;
  visibility?: unknown;
  prompt?: unknown;
}

interface RepoFileInput {
  path?: unknown;
  content?: unknown;
}

interface GitHubRepo {
  full_name: string;
  html_url: string;
  default_branch?: string;
}

interface GitHubRef {
  object?: {
    sha?: string;
  };
}

interface GitHubCommit {
  sha?: string;
  tree?: {
    sha?: string;
  };
}

interface GitHubTree {
  sha?: string;
}

const SESSION_COOKIE = "pds_session";
const STATE_PREFIX = "oauth_state:";
const SESSION_PREFIX = "session:";
const USER_SESSION_PREFIX = "user_session:";
const USER_KV_PREFIX = "user_kv:";
const USER_SECRET_PREFIX = "user_secret:";
const OPENAI_SECRET_KEY = "openai_api_key";
const SECRET_ENVELOPE_VERSION = 1;
const SESSION_TTL = 60 * 60 * 24 * 30;
const STATE_TTL = 60 * 10;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", async (c, next) => {
  const origin = c.req.header("Origin");
  const allowed = allowedOrigin(c.env, origin);
  if (allowed) {
    c.header("Access-Control-Allow-Origin", allowed);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Vary", "Origin");
  }
  c.header("Access-Control-Allow-Headers", "Content-Type, Accept, X-GitHub-Api-Version");
  c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  c.set("session", await readSession(c.env, getCookie(c, SESSION_COOKIE)));
  await next();
});

app.get("/", (c) => c.json({
  ok: true,
  name: "ProDocStore API",
  publicBaseUrl: c.env.PUBLIC_BASE_URL,
  editorBaseUrl: c.env.EDITOR_BASE_URL,
}));

app.get("/api/health", (c) => c.json({
  ok: true,
  service: "prodocstore-api",
  github: {
    oauthConfigured: Boolean(c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET),
    clientId: c.env.GITHUB_CLIENT_ID || null,
    callbackUrl: new URL("/auth/github/callback", c.req.url).toString(),
  },
  google: {
    oauthConfigured: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
    clientId: c.env.GOOGLE_CLIENT_ID || null,
    callbackUrl: new URL("/auth/google/callback", c.req.url).toString(),
  },
}));

app.get("/api/health/oauth/github", async (c) => {
  const callbackUrl = new URL("/auth/github/callback", c.req.url).toString();
  return c.json(await githubOAuthCredentialDiagnostic(c.env.GITHUB_CLIENT_ID, c.env.GITHUB_CLIENT_SECRET, callbackUrl));
});

app.get("/api/platform/status", async (c) => {
  requireSession(c);
  const cloudflare = await cloudflareReadiness(c.env);
  return c.json({
    ok: true,
    github: {
      oauthConfigured: Boolean(c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET),
      publishingTokenConfigured: Boolean(c.env.GITHUB_TOKEN),
      org: c.env.GITHUB_ORG,
    },
    google: {
      oauthConfigured: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
    },
    openai: {
      byok: true,
    },
    cloudflare,
  });
});

app.get("/api/me", (c) => {
  const session = c.get("session");
  return c.json({
    authenticated: Boolean(session),
    user: session?.user ?? null,
  });
});

app.get("/auth/github/start", async (c) => {
  requireSecret(c.env.GITHUB_CLIENT_ID, "GITHUB_CLIENT_ID");
  const state = crypto.randomUUID();
  const next = safeNext(c.req.query("next"), c.env.EDITOR_BASE_URL);
  await c.env.PDS_API_KV.put(`${STATE_PREFIX}${state}`, JSON.stringify({ provider: "github", next }), { expirationTtl: STATE_TTL });
  const callback = new URL("/auth/github/callback", c.req.url);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID!);
  url.searchParams.set("redirect_uri", callback.toString());
  url.searchParams.set("scope", "read:user user:email repo workflow");
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");
  return c.redirect(url.toString(), 302);
});

app.get("/auth/github/callback", async (c) => {
  requireSecret(c.env.GITHUB_CLIENT_ID, "GITHUB_CLIENT_ID");
  requireSecret(c.env.GITHUB_CLIENT_SECRET, "GITHUB_CLIENT_SECRET");
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("Missing OAuth code or state", 400);
  const stateRaw = await c.env.PDS_API_KV.get(`${STATE_PREFIX}${state}`);
  if (!stateRaw) return c.text("OAuth state expired", 400);
  await c.env.PDS_API_KV.delete(`${STATE_PREFIX}${state}`);
  const { next } = JSON.parse(stateRaw) as { next?: string };
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/auth/github/callback", c.req.url).toString(),
    }),
  });
  const tokenData = await tokenRes.json<{ access_token?: string; error?: string; error_description?: string }>();
  if (!tokenData.access_token) return c.text(tokenData.error_description || tokenData.error || "GitHub OAuth failed", 401);

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenData.access_token}`,
      "User-Agent": "prodocstore-api",
    },
  });
  if (!userRes.ok) return c.text(`GitHub user lookup failed: ${userRes.status}`, 401);
  const gh = await userRes.json<GitHubUser>();
  const email = gh.email || await primaryGitHubEmail(tokenData.access_token);
  const session: Session = {
    id: crypto.randomUUID(),
    user: {
      id: `github_${gh.id}`,
      provider: "github",
      login: gh.login,
      name: gh.name || gh.login,
      avatarUrl: gh.avatar_url || "",
      githubUrl: gh.html_url || `https://github.com/${gh.login}`,
      email,
    },
    githubAccessToken: tokenData.access_token,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeSession(c.env, session);
  setSessionCookie(c, session.id);
  return c.redirect(safeNext(next, c.env.EDITOR_BASE_URL), 302);
});

app.get("/auth/google/start", async (c) => {
  requireSecret(c.env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
  const state = crypto.randomUUID();
  const next = safeNext(c.req.query("next"), c.env.EDITOR_BASE_URL);
  await c.env.PDS_API_KV.put(`${STATE_PREFIX}${state}`, JSON.stringify({ provider: "google", next }), { expirationTtl: STATE_TTL });
  const callback = new URL("/auth/google/callback", c.req.url);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", callback.toString());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return c.redirect(url.toString(), 302);
});

app.get("/auth/google/callback", async (c) => {
  requireSecret(c.env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
  requireSecret(c.env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET");
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("Missing OAuth code or state", 400);
  const stateRaw = await c.env.PDS_API_KV.get(`${STATE_PREFIX}${state}`);
  if (!stateRaw) return c.text("OAuth state expired", 400);
  await c.env.PDS_API_KV.delete(`${STATE_PREFIX}${state}`);
  const { next } = JSON.parse(stateRaw) as { next?: string };
  const callback = new URL("/auth/google/callback", c.req.url);
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID!,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      code,
      grant_type: "authorization_code",
      redirect_uri: callback.toString(),
    }),
  });
  const tokenData = await tokenRes.json<{ access_token?: string; error?: string; error_description?: string }>();
  if (!tokenData.access_token) return c.text(tokenData.error_description || tokenData.error || "Google OAuth failed", 401);

  const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${tokenData.access_token}`,
    },
  });
  if (!userRes.ok) return c.text(`Google user lookup failed: ${userRes.status}`, 401);
  const google = await userRes.json<GoogleUser>();
  const login = google.email?.split("@")[0] || `google-${google.sub.slice(0, 8)}`;
  const session: Session = {
    id: crypto.randomUUID(),
    user: {
      id: `google_${google.sub}`,
      provider: "google",
      login,
      name: google.name || login,
      avatarUrl: google.picture || "",
      githubUrl: google.profile || "",
      email: google.email,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeSession(c.env, session);
  setSessionCookie(c, session.id);
  return c.redirect(safeNext(next, c.env.EDITOR_BASE_URL), 302);
});

app.post("/api/logout", async (c) => {
  const session = c.get("session");
  if (session) await c.env.PDS_API_KV.delete(`${SESSION_PREFIX}${session.id}`);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.delete("/api/account", async (c) => {
  const session = requireSession(c);
  await c.env.PDS_API_KV.delete(`${USER_KV_PREFIX}${session.user.id}:pds:config:v1`);
  await c.env.PDS_API_KV.delete(`${USER_KV_PREFIX}${session.user.id}:pds:kbs:v1`);
  await c.env.PDS_API_KV.delete(`${USER_KV_PREFIX}${session.user.id}:pds:active-kb:v1`);
  await c.env.PDS_API_KV.delete(userSecretKey(session, OPENAI_SECRET_KEY));
  await c.env.PDS_API_KV.delete(`${SESSION_PREFIX}${session.id}`);
  await c.env.PDS_API_KV.delete(`${USER_SESSION_PREFIX}${session.user.id}`);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.get("/api/billing", (c) => {
  return c.json({
    plan: "prodocstore-launch",
    status: "trial",
    billingEnabled: false,
  });
});

app.get("/api/kv/*", async (c) => {
  const session = requireSession(c);
  const key = kvKeyFromPath(c.req.path);
  const value = await c.env.PDS_API_KV.get(userKvKey(session, key), "json");
  return c.json({ key, value });
});

app.put("/api/kv/*", async (c) => {
  const session = requireSession(c);
  const key = kvKeyFromPath(c.req.path);
  const value = (await c.req.json<{ value: unknown }>()).value;
  await c.env.PDS_API_KV.put(userKvKey(session, key), JSON.stringify(value));
  return c.json({ ok: true });
});

app.delete("/api/kv/*", async (c) => {
  const session = requireSession(c);
  const key = kvKeyFromPath(c.req.path);
  await c.env.PDS_API_KV.delete(userKvKey(session, key));
  return c.json({ ok: true });
});

app.get("/api/secrets", async (c) => {
  const session = requireSession(c);
  const openaiSecret = await readStoredSecret(c.env, session, OPENAI_SECRET_KEY);
  return c.json({
    openai: openaiSecret
      ? { configured: true, label: openaiSecret.label }
      : { configured: false, label: "" },
  });
});

app.put("/api/secrets/openai", async (c) => {
  const session = requireSession(c);
  const body: { value?: unknown } = await c.req.json<{ value?: unknown }>().catch(() => ({}));
  const value = typeof body.value === "string" ? body.value.trim() : "";
  if (!value) return c.json({ error: "OpenAI API key is required" }, 400);
  if (!/^sk-[A-Za-z0-9_-]{12,}$/.test(value)) return c.json({ error: "OpenAI API key format is not valid" }, 400);
  const encrypted = await encryptSecret(c.env, value);
  await c.env.PDS_API_KV.put(userSecretKey(session, OPENAI_SECRET_KEY), JSON.stringify({
    ...encrypted,
    label: redactSecret(value),
  }));
  return c.json({ ok: true, openai: { configured: true, label: redactSecret(value) } });
});

app.delete("/api/secrets/openai", async (c) => {
  const session = requireSession(c);
  await c.env.PDS_API_KV.delete(userSecretKey(session, OPENAI_SECRET_KEY));
  return c.json({ ok: true, openai: { configured: false, label: "" } });
});

app.post("/api/github/deploy-secrets", async (c) => {
  const session = requireSession(c);
  requireSecret(c.env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN");
  requireSecret(c.env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID");

  const body: { repo?: unknown } = await c.req.json<{ repo?: unknown }>().catch(() => ({}));
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return c.json({ error: "Repo must be owner/name" }, 400);

  const tokens = githubTokens(c.env, session);
  if (!tokens.length) throwJson(500, "No GitHub token is configured for repo secret installation.");
  const results = await Promise.all([
    putGitHubRepoSecret(tokens, repo, "CLOUDFLARE_API_TOKEN", c.env.CLOUDFLARE_API_TOKEN!),
    putGitHubRepoSecret(tokens, repo, "CLOUDFLARE_ACCOUNT_ID", c.env.CLOUDFLARE_ACCOUNT_ID!),
  ]);
  return c.json({ ok: true, repo, secrets: results.map((result) => ({ name: result.name, status: "set", source: result.source })) });
});

app.post("/api/publish/github", async (c) => {
  const session = requireSession(c);
  requireSecret(c.env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN");
  requireSecret(c.env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID");

  const body: { form?: PublishFormInput; files?: RepoFileInput[] } = await c.req.json<{ form?: PublishFormInput; files?: RepoFileInput[] }>().catch(() => ({}));
  const form = validatePublishBody(body.form);
  const files = validateRepoFiles(body.files);
  const tokens = githubTokens(c.env, session);
  if (!tokens.length) throwJson(500, "No GitHub token is configured for publishing.");

  const published = await publishRepoWithTokens(tokens, form, files);
  const secrets = await Promise.all([
    putGitHubRepoSecret(tokens, published.repo.full_name, "CLOUDFLARE_API_TOKEN", c.env.CLOUDFLARE_API_TOKEN!),
    putGitHubRepoSecret(tokens, published.repo.full_name, "CLOUDFLARE_ACCOUNT_ID", c.env.CLOUDFLARE_ACCOUNT_ID!),
  ]);
  const commit = await commitRepoFiles(published.token.value, published.repo.full_name, files);
  const liveUrl = form.customDomain ? `https://${form.customDomain}/` : `https://${form.slug}.pages.dev/`;

  return c.json({
    ok: true,
    repo: {
      full_name: published.repo.full_name,
      html_url: published.repo.html_url,
      default_branch: published.repo.default_branch || "main",
    },
    commit,
    liveUrl,
    actionsUrl: `${published.repo.html_url}/actions`,
    secrets: secrets.map((result) => ({ name: result.name, status: "set", source: result.source })),
  });
});

app.all("/api/proxy", async (c) => {
  const session = requireSession(c);
  const target = c.req.query("target");
  if (!target) return c.json({ error: "Missing target" }, 400);
  const url = normalizeProxyTarget(target);
  const headers = new Headers();
  const accept = c.req.header("Accept");
  const contentType = c.req.header("Content-Type");
  if (accept) headers.set("Accept", accept);
  if (contentType) headers.set("Content-Type", contentType);

  if (url.hostname === "api.github.com") {
    headers.set("Authorization", `Bearer ${c.env.GITHUB_TOKEN || session.githubAccessToken || ""}`);
    headers.set("User-Agent", "prodocstore-api");
    headers.set("X-GitHub-Api-Version", c.req.header("X-GitHub-Api-Version") || "2022-11-28");
  } else if (url.hostname === "api.openai.com") {
    const openaiSecret = await readStoredSecret(c.env, session, OPENAI_SECRET_KEY);
    if (!openaiSecret) return c.json({ error: "OpenAI BYOK key is not configured. Add your OpenAI key in Profile > Platform connections." }, 400);
    const openaiKey = await decryptSecret(c.env, openaiSecret);
    headers.set("Authorization", `Bearer ${openaiKey}`);
  } else {
    return c.json({ error: "Proxy target is not allowed" }, 403);
  }

  const body = c.req.method === "GET" || c.req.method === "HEAD" ? undefined : await c.req.arrayBuffer();
  const upstream = await fetch(url, { method: c.req.method, headers, body });
  const responseHeaders = proxyResponseHeaders(upstream.headers);
  applyCorsHeaders(c, responseHeaders);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
});

// Platform-native private KB store (D1): orgs, RBAC, KBs, pages, proposals.
registerKbRoutes(app);
// Access-controlled rendering of private KBs (members or allowed email domains).
registerPublishRoutes(app);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return corsErrorResponse(c, err.getResponse());
  console.error(err);
  return corsErrorResponse(c, c.json({ error: "Internal server error" }, 500));
});

export default app;

function allowedOrigin(env: Env, origin: string | undefined): string | null {
  if (!origin) return null;
  const originUrl = safeUrl(origin);
  if (originUrl?.hostname === "prodocstore-editor.pages.dev" || originUrl?.hostname.endsWith(".prodocstore-editor.pages.dev")) return origin;
  const allowed = new Set([
    env.EDITOR_BASE_URL,
    env.PUBLIC_BASE_URL,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:4220",
  ]);
  return allowed.has(origin) ? origin : null;
}

function safeUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function applyCorsHeaders(c: Parameters<Parameters<typeof app.onError>[0]>[1], headers: Headers) {
  const origin = c.req.header("Origin");
  const allowed = allowedOrigin(c.env, origin);
  if (!allowed) return;
  headers.set("Access-Control-Allow-Origin", allowed);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Vary", "Origin");
}

function corsErrorResponse(c: Parameters<Parameters<typeof app.onError>[0]>[1], response: Response): Response {
  const origin = c.req.header("Origin");
  const allowed = allowedOrigin(c.env, origin);
  if (!allowed) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowed);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readSession(env: Env, id: string | undefined): Promise<Session | null> {
  if (!id) return null;
  return env.PDS_API_KV.get<Session>(`${SESSION_PREFIX}${id}`, "json");
}

async function writeSession(env: Env, session: Session) {
  await Promise.all([
    env.PDS_API_KV.put(`${SESSION_PREFIX}${session.id}`, JSON.stringify(session), { expirationTtl: SESSION_TTL }),
    env.PDS_API_KV.put(`${USER_SESSION_PREFIX}${session.user.id}`, session.id, { expirationTtl: SESSION_TTL }),
  ]);
}

function setSessionCookie(c: Parameters<typeof setCookie>[0], id: string) {
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    secure: true,
    sameSite: "None",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

function clearSessionCookie(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, SESSION_COOKIE, {
    secure: true,
    sameSite: "None",
    path: "/",
  });
}

function requireSession(c: Parameters<typeof app.fetch>[0] extends never ? never : any): Session {
  const session = c.get("session") as Session | null;
  if (!session) throwJson(401, "Authentication required");
  return session;
}

function requireSecret(value: string | undefined, name: string) {
  if (!value) throwJson(500, `${name} is not configured`);
}

async function githubOAuthCredentialDiagnostic(clientId: string | undefined, clientSecret: string | undefined, redirectUri: string) {
  const configured = Boolean(clientId && clientSecret);
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      configured,
      clientId: clientId || null,
      callbackUrl: redirectUri,
      secretAccepted: false,
      providerError: "not_configured",
    };
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code: `diagnostic-${crypto.randomUUID()}`,
      redirect_uri: redirectUri,
    }),
  });
  const tokenJson = await tokenRes.json<{ error?: string; error_description?: string }>();
  const secretAccepted = tokenJson.error === "bad_verification_code";

  return {
    ok: secretAccepted,
    configured,
    clientId,
    callbackUrl: redirectUri,
    secretAccepted,
    providerStatus: tokenRes.status,
    providerError: tokenJson.error || null,
    providerErrorDescription: tokenJson.error_description || null,
  };
}

async function primaryGitHubEmail(accessToken: string): Promise<string | undefined> {
  const res = await fetch("https://api.github.com/user/emails", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "prodocstore-api",
    },
  });
  if (!res.ok) return undefined;
  const emails = await res.json<GitHubEmail[]>().catch(() => []);
  return emails.find((email) => email.primary && email.verified)?.email
    || emails.find((email) => email.verified)?.email;
}

function validatePublishBody(input: PublishFormInput | undefined) {
  const form = input ?? {};
  const title = stringField(form.title).trim();
  const slug = stringField(form.slug).trim().toLowerCase();
  const owner = stringField(form.owner).trim();
  const customDomain = normalizeDomain(stringField(form.customDomain));
  const visibility = stringField(form.visibility);
  const prompt = stringField(form.prompt).trim();

  if (!title) throwJson(400, "Title is required.");
  if (!/^[a-z][a-z0-9-]{1,57}$/.test(slug)) throwJson(400, "Slug must be lowercase letters, numbers, and hyphens.");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) throwJson(400, "GitHub owner must be a valid user or organization name.");
  if (customDomain && !isValidHostname(customDomain)) throwJson(400, "Custom domain must be a valid hostname.");
  if (visibility !== "public" && visibility !== "private") throwJson(400, "Visibility must be public or private.");
  if (!prompt) throwJson(400, "Prompt is required.");

  return { title, slug, owner, customDomain, visibility, prompt };
}

function validateRepoFiles(input: RepoFileInput[] | undefined): Array<{ path: string; content: string }> {
  if (!Array.isArray(input) || input.length === 0) throwJson(400, "Files are required.");
  const files = input.map((file) => ({
    path: stringField(file.path).replace(/^\/+/, ""),
    content: stringField(file.content),
  }));
  for (const file of files) {
    if (!isSafeRepoPath(file.path)) throwJson(400, `Unsafe repo path: ${file.path || "(empty)"}`);
    if (file.path.startsWith("site/") || file.path.endsWith(".html")) throwJson(400, `Generated site output is not allowed: ${file.path}`);
  }
  const paths = new Set(files.map((file) => file.path));
  for (const required of [".github/workflows/deploy.yml", "zensical.toml", "docs/index.md"]) {
    if (!paths.has(required)) throwJson(400, `Missing required file: ${required}`);
  }
  if (![...paths].some((path) => path.startsWith("docs/") && path.endsWith(".md"))) throwJson(400, "At least one Markdown file under docs/ is required.");
  return files;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
}

function isValidHostname(value: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);
}

function isSafeRepoPath(value: string): boolean {
  if (!value || value.length > 240 || value.startsWith("/") || value.includes("\\")) return false;
  return value.split("/").every((part) => part && part !== "." && part !== "..");
}

async function publishRepoWithTokens(tokens: GitHubToken[], form: ReturnType<typeof validatePublishBody>, files: Array<{ path: string; content: string }>): Promise<{ token: GitHubToken; repo: GitHubRepo }> {
  const failures: string[] = [];
  for (const token of tokens) {
    try {
      const repo = await createOrFetchGitHubRepo(token.value, form, files.length);
      return { token, repo };
    } catch (error) {
      failures.push(`${token.source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throwJson(500, `GitHub repository publish setup failed. ${failures.join(" ")}`);
}

async function createOrFetchGitHubRepo(token: string, form: ReturnType<typeof validatePublishBody>, fileCount: number): Promise<GitHubRepo> {
  const viewer = await githubJsonWithToken<{ login?: string }>(token, "https://api.github.com/user");
  const isUser = viewer.login?.toLowerCase() === form.owner.toLowerCase();
  const url = isUser ? "https://api.github.com/user/repos" : `https://api.github.com/orgs/${encodeURIComponent(form.owner)}/repos`;
  const createRes = await fetch(url, {
    method: "POST",
    headers: {
      ...githubApiHeaders(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: form.slug,
      description: `${form.title} - ProDocStore Zensical knowledge base`,
      private: form.visibility === "private",
      auto_init: true,
      homepage: form.customDomain ? `https://${form.customDomain}/` : `https://${form.slug}.pages.dev/`,
    }),
  });
  if (createRes.ok) return createRes.json<GitHubRepo>();
  if (createRes.status !== 422) throw new Error(`repo create failed: ${createRes.status} ${await githubErrorDetail(createRes)}`);

  const repo = await githubJsonWithToken<GitHubRepo>(token, `https://api.github.com/repos/${encodeURIComponentRepo(`${form.owner}/${form.slug}`)}`);
  if (repo.full_name?.toLowerCase() !== `${form.owner}/${form.slug}`.toLowerCase()) throw new Error("GitHub returned the wrong repository.");
  console.log(`Publishing ${fileCount} file(s) to existing repo ${repo.full_name}.`);
  return repo;
}

async function commitRepoFiles(token: string, repo: string, files: Array<{ path: string; content: string }>): Promise<{ sha: string; html_url: string }> {
  const repoMeta = await githubJsonWithToken<GitHubRepo>(token, `https://api.github.com/repos/${encodeURIComponentRepo(repo)}`);
  const branch = repoMeta.default_branch || "main";
  const ref = await githubJsonWithToken<GitHubRef>(token, `https://api.github.com/repos/${encodeURIComponentRepo(repo)}/git/ref/heads/${encodeURIComponent(branch)}`);
  const headSha = ref.object?.sha;
  if (!headSha) throw new Error(`GitHub ref heads/${branch} has no sha.`);
  const headCommit = await githubJsonWithToken<GitHubCommit>(token, `https://api.github.com/repos/${encodeURIComponentRepo(repo)}/git/commits/${encodeURIComponent(headSha)}`);
  const baseTree = headCommit.tree?.sha;
  if (!baseTree) throw new Error(`GitHub commit ${headSha} has no tree sha.`);

  const tree = await githubFetchJson<GitHubTree>(token, `https://api.github.com/repos/${encodeURIComponentRepo(repo)}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseTree,
      tree: files.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.content,
      })),
    }),
  });
  if (!tree.sha) throw new Error("GitHub create tree returned no sha.");

  const commit = await githubFetchJson<GitHubCommit & { html_url?: string }>(token, `https://api.github.com/repos/${encodeURIComponentRepo(repo)}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: "Publish ProDocStore knowledge base",
      tree: tree.sha,
      parents: [headSha],
    }),
  });
  if (!commit.sha) throw new Error("GitHub create commit returned no sha.");

  await githubFetchJson(token, `https://api.github.com/repos/${encodeURIComponentRepo(repo)}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });

  return {
    sha: commit.sha,
    html_url: `https://github.com/${repo}/commit/${commit.sha}`,
  };
}

async function githubJsonWithToken<T>(token: string, url: string): Promise<T> {
  return githubFetchJson<T>(token, url, { method: "GET" });
}

async function githubFetchJson<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...githubApiHeaders(token),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await githubErrorDetail(res)}`);
  return res.json<T>();
}

function safeNext(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  try {
    const next = new URL(input, fallback);
    const allowed = new URL(fallback);
    return next.origin === allowed.origin ? next.toString() : fallback;
  } catch {
    return fallback;
  }
}

function kvKeyFromPath(path: string): string {
  const key = decodeURIComponent(path.replace(/^\/api\/kv\/?/, ""));
  if (!key || key.includes("..") || key.length > 256) throwJson(400, "Invalid key");
  return key;
}

function userKvKey(session: Session, key: string) {
  return `${USER_KV_PREFIX}${session.user.id}:${key}`;
}

function userSecretKey(session: Session, key: string) {
  return `${USER_SECRET_PREFIX}${session.user.id}:${key}`;
}

function redactSecret(value: string) {
  if (value.length <= 10) return "configured";
  return `${value.slice(0, 7)}...${value.slice(-4)}`;
}

async function readStoredSecret(env: Env, session: Session, key: string): Promise<StoredSecret | null> {
  const raw = await env.PDS_API_KV.get(userSecretKey(session, key));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSecret>;
    if (parsed.v === SECRET_ENVELOPE_VERSION && parsed.alg === "AES-GCM" && parsed.iv && parsed.ciphertext) {
      return {
        v: SECRET_ENVELOPE_VERSION,
        alg: "AES-GCM",
        iv: parsed.iv,
        ciphertext: parsed.ciphertext,
        label: parsed.label || "configured",
      };
    }
  } catch {
    // Legacy raw values are handled below so old dev data can still be used once.
  }
  return {
    v: 0,
    alg: "AES-GCM",
    iv: "",
    ciphertext: raw,
    label: redactSecret(raw),
  };
}

async function encryptSecret(env: Env, value: string): Promise<Omit<StoredSecret, "label">> {
  const key = await importVaultKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(value);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(encoded));
  return {
    v: SECRET_ENVELOPE_VERSION,
    alg: "AES-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptSecret(env: Env, secret: StoredSecret): Promise<string> {
  if (secret.v === 0) return secret.ciphertext;
  const key = await importVaultKey(env);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(secret.iv)) },
    key,
    toArrayBuffer(base64ToBytes(secret.ciphertext)),
  );
  return new TextDecoder().decode(plaintext);
}

async function putGitHubRepoSecret(tokens: GitHubToken[], repo: string, name: string, value: string): Promise<{ name: string; source: GitHubToken["source"] }> {
  const failures: string[] = [];
  for (const token of tokens) {
    try {
      await putGitHubRepoSecretWithToken(token.value, repo, name, value);
      return { name, source: token.source };
    } catch (error) {
      failures.push(`${token.source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throwJson(500, `GitHub repo secret ${name} write failed for ${repo}. ${failures.join(" ")}`);
}

async function putGitHubRepoSecretWithToken(token: string, repo: string, name: string, value: string): Promise<void> {
  const publicKey = await retryGitHubSecretRequest(`public key lookup for ${repo}`, async () => {
    const publicKeyRes = await fetch(`https://api.github.com/repos/${encodeURIComponentRepo(repo)}/actions/secrets/public-key`, {
      headers: githubApiHeaders(token),
    });
    if (!publicKeyRes.ok) {
      throw new RetryableGitHubError(publicKeyRes.status, await githubErrorDetail(publicKeyRes));
    }
    return publicKeyRes.json<{ key?: string; key_id?: string }>();
  });
  if (!publicKey.key || !publicKey.key_id) throw new Error("public key response was incomplete");

  const encrypted = await encryptForGitHub(publicKey.key, value);
  await retryGitHubSecretRequest(`secret write for ${repo}/${name}`, async () => {
    const putRes = await fetch(`https://api.github.com/repos/${encodeURIComponentRepo(repo)}/actions/secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: {
        ...githubApiHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        encrypted_value: encrypted,
        key_id: publicKey.key_id,
      }),
    });
    if (!putRes.ok) {
      throw new RetryableGitHubError(putRes.status, await githubErrorDetail(putRes));
    }
  });
}

async function cloudflareReadiness(env: Env) {
  const configured = Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID);
  const result = {
    deployConnection: "github-actions-org-secret-and-repo-secret",
    deploySecretsConfigured: configured,
    pagesApiReady: false,
    accessApiReady: false,
    identityProvidersApiReady: false,
    otpIdentityProviderReady: false,
    pagesError: "",
    accessError: "",
    identityProvidersError: "",
  };
  if (!configured) {
    result.pagesError = "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be configured on the API Worker.";
    result.accessError = result.pagesError;
    return result;
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  const pages = await cloudflareProbe(`${base}/pages/projects?per_page=1`, env.CLOUDFLARE_API_TOKEN!);
  result.pagesApiReady = pages.ok;
  result.pagesError = pages.error;
  const access = await cloudflareProbe(`${base}/access/apps?per_page=1`, env.CLOUDFLARE_API_TOKEN!);
  result.accessApiReady = access.ok;
  result.accessError = access.error;
  const identityProviders = await cloudflareIdentityProviderReadiness(`${base}/access/identity_providers`, env.CLOUDFLARE_API_TOKEN!);
  result.identityProvidersApiReady = identityProviders.ok;
  result.otpIdentityProviderReady = identityProviders.otpReady;
  result.identityProvidersError = identityProviders.error;
  return result;
}

async function cloudflareProbe(url: string, token: string): Promise<{ ok: boolean; error: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    const data: { success?: boolean; errors?: Array<{ code?: number; message?: string }> } = await res.json<{ success?: boolean; errors?: Array<{ code?: number; message?: string }> }>().catch(() => ({}));
    if (res.ok && data.success !== false) return { ok: true, error: "" };
    const detail = data.errors?.map((item) => item.message || item.code).filter(Boolean).join("; ");
    return { ok: false, error: detail || `Cloudflare API returned ${res.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Cloudflare API probe failed" };
  }
}

async function cloudflareIdentityProviderReadiness(url: string, token: string): Promise<{ ok: boolean; otpReady: boolean; error: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    const data: { success?: boolean; result?: Array<{ type?: string }>; errors?: Array<{ code?: number; message?: string; error?: string }> } =
      await res.json<{ success?: boolean; result?: Array<{ type?: string }>; errors?: Array<{ code?: number; message?: string; error?: string }> }>().catch(() => ({}));
    if (res.ok && data.success !== false) {
      const otpReady = Boolean(data.result?.some((item) => item.type === "onetimepin"));
      return {
        ok: true,
        otpReady,
        error: otpReady ? "" : "One-time PIN Access identity provider is not configured.",
      };
    }
    const detail = data.errors?.map((item) => item.message || item.error || item.code).filter(Boolean).join("; ");
    return { ok: false, otpReady: false, error: detail || `Cloudflare identity provider API returned ${res.status}` };
  } catch (error) {
    return { ok: false, otpReady: false, error: error instanceof Error ? error.message : "Cloudflare identity provider probe failed" };
  }
}

async function encryptForGitHub(publicKey: string, value: string): Promise<string> {
  const keyBytes = base64ToBytes(publicKey);
  const valueBytes = new TextEncoder().encode(value);
  return bytesToBase64(sealedbox.seal(valueBytes, keyBytes));
}

function githubTokens(env: Env, session: Session): GitHubToken[] {
  const tokens: GitHubToken[] = [];
  if (env.GITHUB_TOKEN) tokens.push({ source: "platform", value: env.GITHUB_TOKEN });
  if (session.githubAccessToken && session.githubAccessToken !== env.GITHUB_TOKEN) tokens.push({ source: "session", value: session.githubAccessToken });
  return tokens;
}

function githubApiHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "prodocstore-api",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubErrorDetail(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return res.statusText || "empty response";
  try {
    const data = JSON.parse(text) as { message?: string; documentation_url?: string };
    return [data.message, data.documentation_url].filter(Boolean).join(" ");
  } catch {
    return text.slice(0, 500);
  }
}

class RetryableGitHubError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`${status}: ${detail}`);
  }
}

async function retryGitHubSecretRequest<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const delays = [400, 900, 1600, 2600, 4200];
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableGitHubSecretError(error) || attempt === delays.length) break;
      await sleep(delays[attempt]);
    }
  }
  throw new Error(`${label} failed after retry: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function isRetryableGitHubSecretError(error: unknown): boolean {
  if (!(error instanceof RetryableGitHubError)) return false;
  return [404, 409, 422, 429, 500, 502, 503, 504].includes(error.status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeURIComponentRepo(repo: string): string {
  return repo.split("/").map(encodeURIComponent).join("/");
}

async function importVaultKey(env: Env): Promise<CryptoKey> {
  requireSecret(env.PDS_KEY_ENCRYPTION_KEY, "PDS_KEY_ENCRYPTION_KEY");
  const raw = decodeKeyMaterial(env.PDS_KEY_ENCRYPTION_KEY!);
  if (![16, 24, 32].includes(raw.byteLength)) throwJson(500, "PDS_KEY_ENCRYPTION_KEY must decode to 16, 24, or 32 bytes");
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function decodeKeyMaterial(value: string): Uint8Array {
  const trimmed = value.trim();
  if (/^[A-Fa-f0-9]{32}$|^[A-Fa-f0-9]{48}$|^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    const bytes = new Uint8Array(trimmed.length / 2);
    for (let i = 0; i < trimmed.length; i += 2) bytes[i / 2] = Number.parseInt(trimmed.slice(i, i + 2), 16);
    return bytes;
  }
  return base64ToBytes(trimmed);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function normalizeProxyTarget(target: string): URL {
  const withScheme = /^https?:\/\//i.test(target) ? target : `https://${target}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:") throwJson(400, "Proxy target must use HTTPS");
  return url;
}

function throwJson(status: 400 | 401 | 500, error: string): never {
  throw new HTTPException(status, {
    res: new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  });
}

function proxyResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of ["content-type", "etag", "last-modified", "cache-control"]) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}
