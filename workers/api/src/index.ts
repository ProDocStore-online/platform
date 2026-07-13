import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import sodium from "libsodium-wrappers-sumo";

import { type Env, type Session, type Variables, type AuthProvider } from "./types";
import { registerKbRoutes } from "./routes/kb";
import { registerPublishRoutes } from "./routes/publish";

interface GitHubUser {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string | null;
  html_url?: string | null;
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

app.get("/api/health", (c) => c.json({ ok: true, service: "prodocstore-api" }));

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
  url.searchParams.set("scope", "read:user");
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
  const session: Session = {
    id: crypto.randomUUID(),
    user: {
      id: `github_${gh.id}`,
      provider: "github",
      login: gh.login,
      name: gh.name || gh.login,
      avatarUrl: gh.avatar_url || "",
      githubUrl: gh.html_url || `https://github.com/${gh.login}`,
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
  requireSession(c);
  requireSecret(c.env.GITHUB_TOKEN, "GITHUB_TOKEN");
  requireSecret(c.env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN");
  requireSecret(c.env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID");

  const body: { repo?: unknown } = await c.req.json<{ repo?: unknown }>().catch(() => ({}));
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return c.json({ error: "Repo must be owner/name" }, 400);

  const results = await Promise.all([
    putGitHubRepoSecret(c.env, repo, "CLOUDFLARE_API_TOKEN", c.env.CLOUDFLARE_API_TOKEN!),
    putGitHubRepoSecret(c.env, repo, "CLOUDFLARE_ACCOUNT_ID", c.env.CLOUDFLARE_ACCOUNT_ID!),
  ]);
  return c.json({ ok: true, repo, secrets: results.map((name) => ({ name, status: "set" })) });
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
// Access-controlled rendering of private KBs (members only).
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

async function putGitHubRepoSecret(env: Env, repo: string, name: string, value: string): Promise<string> {
  const publicKeyRes = await fetch(`https://api.github.com/repos/${encodeURIComponentRepo(repo)}/actions/secrets/public-key`, {
    headers: githubApiHeaders(env),
  });
  if (!publicKeyRes.ok) {
    throwJson(500, `GitHub repo public key lookup failed for ${repo}: ${publicKeyRes.status}`);
  }
  const publicKey = await publicKeyRes.json<{ key?: string; key_id?: string }>();
  if (!publicKey.key || !publicKey.key_id) throwJson(500, `GitHub repo public key response was incomplete for ${repo}`);

  const encrypted = await encryptForGitHub(publicKey.key, value);
  const putRes = await fetch(`https://api.github.com/repos/${encodeURIComponentRepo(repo)}/actions/secrets/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: {
      ...githubApiHeaders(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      encrypted_value: encrypted,
      key_id: publicKey.key_id,
    }),
  });
  if (!putRes.ok) {
    throwJson(500, `GitHub repo secret ${name} write failed for ${repo}: ${putRes.status}`);
  }
  return name;
}

async function cloudflareReadiness(env: Env) {
  const configured = Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID);
  const result = {
    deployConnection: "github-actions-org-secret-and-repo-secret",
    deploySecretsConfigured: configured,
    pagesApiReady: false,
    accessApiReady: false,
    pagesError: "",
    accessError: "",
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

async function encryptForGitHub(publicKey: string, value: string): Promise<string> {
  await sodium.ready;
  const keyBytes = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  const valueBytes = sodium.from_string(value);
  const encryptedBytes = sodium.crypto_box_seal(valueBytes, keyBytes);
  return sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);
}

function githubApiHeaders(env: Env): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN || ""}`,
    "User-Agent": "prodocstore-api",
    "X-GitHub-Api-Version": "2022-11-28",
  };
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
