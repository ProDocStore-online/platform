import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubError, listRepoFiles } from "../src/github.js";
import { ProDocStoreMcp } from "../src/index.js";

const REPO = "ProDocStore-online/handbook";
const SHA = "abc123";

/** Stubs GitHub: the ref lookup answers `refResponse`, the tree lookup `treeResponse`. */
function stubGitHub(options: { refResponse?: () => Response; treeResponse?: () => Response }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/git/ref/heads/")) {
        return options.refResponse?.() ?? Response.json({ object: { sha: SHA } });
      }
      if (url.includes(`/git/trees/${SHA}`)) {
        return options.treeResponse?.() ?? Response.json({ tree: [{ path: "docs/index.md", type: "blob", size: 10 }] });
      }
      throw new Error(`unexpected outbound fetch: ${url}`);
    }),
  );
}

const failure = (status: number, message: string) => () => Response.json({ message }, { status });

/**
 * Runs the real tool handlers in-process: init() registers them on a fresh
 * McpServer, skipping the Durable Object / OAuth plumbing around the agent.
 */
async function callTool(name: string, args: Record<string, unknown>) {
  const agent = Object.create(ProDocStoreMcp.prototype) as ProDocStoreMcp;
  Object.assign(agent, {
    server: new McpServer({ name: "test", version: "0.0.0" }),
    env,
    props: {},
  });
  await agent.init();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await agent.server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await client.close();
  return { isError: result.isError ?? false, text: result.content[0]?.text ?? "" };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("listRepoFiles", () => {
  it("throws the GitHub status and message when the ref lookup fails", async () => {
    stubGitHub({ refResponse: failure(404, "Not Found") });
    const err = await listRepoFiles(REPO).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("GitHub API 404: Not Found");
  });

  it("throws when the tree lookup fails", async () => {
    stubGitHub({ treeResponse: failure(502, "Bad Gateway") });
    await expect(listRepoFiles(REPO)).rejects.toMatchObject({ status: 502 });
  });
});

for (const tool of ["check_zensical_repo", "list_files"]) {
  describe(`${tool} surfaces GitHub failures`, () => {
    it("reports a 4xx as an error, not an empty repo", async () => {
      stubGitHub({ refResponse: failure(403, "API rate limit exceeded") });
      const result = await callTool(tool, { repo: REPO });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("GitHub API 403: API rate limit exceeded");
      expect(result.text).not.toContain("no files");
      expect(result.text).not.toContain("No files");
    });

    it("reports a 5xx as an error, not an empty repo", async () => {
      stubGitHub({ treeResponse: failure(500, "Server Error") });
      const result = await callTool(tool, { repo: REPO });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("GitHub API 500: Server Error");
    });

    it("still succeeds when GitHub answers", async () => {
      stubGitHub({});
      const result = await callTool(tool, { repo: REPO });
      expect(result.isError).toBe(false);
      expect(result.text).toContain(REPO);
    });
  });
}
