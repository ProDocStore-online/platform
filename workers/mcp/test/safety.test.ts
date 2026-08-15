import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  audit,
  dryRun,
  hasScope,
  listAuditEvents,
  requireConfirmation,
  requirePermission,
  type SafetyContext,
} from "../src/safety.js";

/**
 * These run against the real KV binding, so audit writes exercise actual
 * list/get semantics. Each test uses a unique subject to keep prefixes apart.
 */

let subjectCounter = 0;
function ctx(overrides: Partial<SafetyContext> = {}): SafetyContext {
  subjectCounter += 1;
  return {
    auditKv: env.OAUTH_KV,
    subject: `github_test_${subjectCounter}_${crypto.randomUUID()}`,
    scopes: ["read", "write"],
    ...overrides,
  };
}

function textOf(result: { content: Array<{ text: string }> } | null): string {
  return result?.content[0]?.text ?? "";
}

async function eventsFor(context: SafetyContext) {
  return (await listAuditEvents(context, 200)) as Array<Record<string, unknown>>;
}

describe("hasScope", () => {
  it("reads the scopes granted at authorization time", () => {
    expect(hasScope({ scopes: ["read", "write"] }, "write")).toBe(true);
    expect(hasScope({ scopes: ["read"] }, "write")).toBe(false);
    expect(hasScope({ scopes: null }, "read")).toBe(false);
    expect(hasScope({}, "read")).toBe(false);
  });
});

describe("requirePermission", () => {
  it("allows a call that holds the scope, and records nothing", async () => {
    const context = ctx();
    expect(await requirePermission(context, "write", "create_workspace_draft")).toBeNull();
    expect(await eventsFor(context)).toHaveLength(0);
  });

  it("refuses an unauthenticated caller", async () => {
    const context = ctx({ subject: undefined });
    const denied = await requirePermission(context, "write", "create_workspace_draft");
    expect(textOf(denied)).toContain("requires a signed-in ProDocStore account");
  });

  it("refuses and audits a token without the write scope", async () => {
    const context = ctx({ scopes: ["read"] });
    const denied = await requirePermission(context, "write", "create_workspace_draft", { title: "Handbook" });

    expect(textOf(denied)).toContain('requires MCP scope "write"');
    expect(textOf(denied)).toContain("not granted by default");

    const events = await eventsFor(context);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: "create_workspace_draft",
      action: "denied",
      reason: "missing_scope",
      requiredScope: "write",
    });
  });

  it("refuses and audits every write while read-only mode is on", async () => {
    const context = ctx({ readOnly: true });
    const denied = await requirePermission(context, "write", "create_workspace_draft");

    expect(textOf(denied)).toContain("read-only mode");
    const events = await eventsFor(context);
    expect(events[0]).toMatchObject({ action: "denied", reason: "read_only" });
  });

  it("still allows reads while read-only mode is on", async () => {
    const context = ctx({ readOnly: true });
    expect(await requirePermission(context, "read", "list_workspace_drafts")).toBeNull();
  });
});

describe("requireConfirmation", () => {
  it("allows the call when confirm matches exactly", async () => {
    const context = ctx();
    const result = await requireConfirmation(context, "create_workspace_draft", "create_workspace_draft", "create_workspace_draft", "reason");
    expect(result).toBeNull();
    expect(await eventsFor(context)).toHaveLength(0);
  });

  it.each([
    ["a wrong string", "yes"],
    ["a near miss", "create_workspace_drafts"],
    ["nothing at all", undefined],
  ])("refuses and audits %s", async (_label, confirm) => {
    const context = ctx();
    const denied = await requireConfirmation(
      context,
      "create_workspace_draft",
      confirm,
      "create_workspace_draft",
      "It becomes the active KB.",
    );

    expect(textOf(denied)).toContain('requires confirm="create_workspace_draft"');
    expect(textOf(denied)).toContain("It becomes the active KB.");

    const events = await eventsFor(context);
    expect(events[0]).toMatchObject({ action: "denied", reason: "missing_confirmation" });
  });
});

describe("dryRun", () => {
  it("returns the plan, writes nothing, and records the preview", async () => {
    const context = ctx();
    const result = await dryRun(
      context,
      "create_workspace_draft",
      "create_draft",
      { title: "Customer Handbook" },
      { slug: "customer-handbook", files: ["docs/index.md"] },
    );

    const body = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(body).toMatchObject({
      dryRun: true,
      tool: "create_workspace_draft",
      action: "create_draft",
      wouldDo: { slug: "customer-handbook", files: ["docs/index.md"] },
    });

    const events = await eventsFor(context);
    expect(events[0]).toMatchObject({ tool: "create_workspace_draft", action: "dry_run" });
  });
});

describe("audit", () => {
  it("skips writing when there is no authenticated subject", async () => {
    const context = ctx({ subject: undefined });
    await audit(context, { tool: "whoami", action: "created" });
    expect(await listAuditEvents(context)).toEqual([]);
  });

  it("skips writing when no audit KV is bound", async () => {
    const context = ctx({ auditKv: undefined });
    await audit(context, { tool: "whoami", action: "created" });
    expect(await listAuditEvents(context)).toEqual([]);
  });

  it("stamps each row with the time and subject", async () => {
    const context = ctx();
    await audit(context, { tool: "create_workspace_draft", action: "created" });

    const events = await eventsFor(context);
    expect(events[0].subject).toBe(context.subject);
    expect(typeof events[0].time).toBe("string");
  });

  describe("redaction", () => {
    it("masks values under credential-shaped keys", async () => {
      const context = ctx();
      await audit(context, {
        tool: "create_workspace_draft",
        input: { access_token: "plain", client_secret: "plain", cookie: "a=b", title: "Handbook" },
      });

      const input = (await eventsFor(context))[0].input as Record<string, unknown>;
      expect(input.access_token).toBe("[redacted]");
      expect(input.client_secret).toBe("[redacted]");
      expect(input.cookie).toBe("[redacted]");
      expect(input.title).toBe("Handbook");
    });

    it("masks secret-shaped values even under an innocent key", async () => {
      const context = ctx();
      await audit(context, {
        tool: "create_workspace_draft",
        input: { note: "use ghp_abcdefghijklmnopqrstuvwxyz012345 to publish" },
      });

      const input = (await eventsFor(context))[0].input as Record<string, string>;
      expect(input.note).toContain("[redacted]");
      expect(input.note).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    });

    it("masks secrets nested inside arrays and objects", async () => {
      const context = ctx();
      await audit(context, {
        tool: "create_workspace_draft",
        input: { files: [{ path: "docs/index.md", body: "sk-ant-abcdefghijklmnopqrstuvwxyz" }] },
      });

      const serialized = JSON.stringify((await eventsFor(context))[0]);
      expect(serialized).toContain("[redacted]");
      expect(serialized).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");
    });

    it("truncates very long strings", async () => {
      const context = ctx();
      await audit(context, { tool: "create_workspace_draft", input: { prompt: "x".repeat(900) } });

      const input = (await eventsFor(context))[0].input as Record<string, string>;
      expect(input.prompt.length).toBeLessThan(600);
      expect(input.prompt.endsWith("...")).toBe(true);
    });
  });
});

describe("listAuditEvents", () => {
  it("returns this subject's events newest first", async () => {
    const context = ctx();
    await audit(context, { tool: "create_workspace_draft", action: "dry_run" });
    await audit(context, { tool: "create_workspace_draft", action: "denied" });
    await audit(context, { tool: "create_workspace_draft", action: "created" });

    const events = await eventsFor(context);
    expect(events).toHaveLength(3);

    const times = events.map((event) => String(event.time));
    expect(times).toEqual([...times].sort().reverse());
  });

  it("does not leak another subject's events", async () => {
    const mine = ctx();
    const theirs = ctx();
    await audit(theirs, { tool: "create_workspace_draft", action: "created" });

    expect(await eventsFor(mine)).toHaveLength(0);
    expect(await eventsFor(theirs)).toHaveLength(1);
  });

  it("clamps the requested limit", async () => {
    const context = ctx();
    await audit(context, { tool: "create_workspace_draft", action: "created" });
    await audit(context, { tool: "create_workspace_draft", action: "created" });

    expect(await listAuditEvents(context, 1)).toHaveLength(1);
    expect(await listAuditEvents(context, -5)).toHaveLength(1);
    expect(await listAuditEvents(context, 10_000)).toHaveLength(2);
  });

  it("returns nothing for an unauthenticated caller", async () => {
    expect(await listAuditEvents({ auditKv: env.OAUTH_KV })).toEqual([]);
  });
});
