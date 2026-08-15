import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://mcp.prodocstore.online";

describe("GET /health", () => {
  it("reports service, OAuth and storage configuration", async () => {
    const res = await SELF.fetch(`${ORIGIN}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = await res.json<{
      ok: boolean;
      service: string;
      oauthConfigured: boolean;
      storageConfigured: boolean;
      githubOrg: string;
      callbackUrl: string;
    }>();
    expect(body).toMatchObject({
      ok: true,
      service: "prodocstore-mcp",
      oauthConfigured: true,
      storageConfigured: true,
      githubOrg: "ProDocStore-online",
      callbackUrl: `${ORIGIN}/callback`,
    });
  });
});

describe("origin endpoint", () => {
  it("serves a human-readable banner to a browser GET", async () => {
    const res = await SELF.fetch(ORIGIN, { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const text = await res.text();
    expect(text).toContain("ProDocStore MCP Server");
    expect(text).toContain(`${ORIGIN}/mcp`);
  });

  /**
   * A protocol client pointed at the origin instead of /mcp must be told "wrong
   * endpoint" rather than handed a 200 it will read as an opened-then-dropped
   * stream — that reconnect loop is the failure this guard exists to prevent.
   */
  describe("redirects protocol clients away instead of opening a droppable stream", () => {
    it("answers a JSON-RPC POST with 405", async () => {
      const res = await SELF.fetch(ORIGIN, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      });

      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
      const body = await res.json<{ jsonrpc: string; id: null; error: { code: number; message: string } }>();
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBeNull();
      expect(body.error.code).toBe(-32000);
      expect(body.error.message).toContain(`${ORIGIN}/mcp`);
    });

    it("answers a legacy SSE stream request with 405", async () => {
      const res = await SELF.fetch(ORIGIN, { headers: { accept: "text/event-stream" } });
      expect(res.status).toBe(405);
      expect(res.headers.get("content-type")).toContain("application/json");
    });

    it("answers a mixed accept header containing text/event-stream with 405", async () => {
      const res = await SELF.fetch(ORIGIN, { headers: { accept: "text/html, text/event-stream" } });
      expect(res.status).toBe(405);
    });

    it("leaves HEAD alone so it is not mistaken for a stream request", async () => {
      const res = await SELF.fetch(ORIGIN, { method: "HEAD" });
      expect(res.status).toBe(200);
    });

    it("leaves an OPTIONS preflight alone so CORS is unaffected", async () => {
      const res = await SELF.fetch(ORIGIN, {
        method: "OPTIONS",
        headers: { origin: "https://console.prodocstore.online", "access-control-request-method": "POST" },
      });
      expect(res.status).not.toBe(405);
    });
  });
});

describe("/mcp", () => {
  it("refuses an unauthenticated JSON-RPC call", async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a bearer token it never issued", async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer not-a-real-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});
