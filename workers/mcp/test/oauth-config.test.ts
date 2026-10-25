import { describe, expect, it } from "vitest";
import { MCP_ACCESS_TOKEN_TTL_SECONDS } from "../src/oauth-config.js";

describe("MCP OAuth configuration", () => {
  it("defaults access tokens to 30 days", () => {
    expect(MCP_ACCESS_TOKEN_TTL_SECONDS).toBe(30 * 86_400);
  });
});
