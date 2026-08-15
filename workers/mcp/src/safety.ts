/**
 * Write-safety primitives for the ProDocStore MCP server.
 *
 * Vendored from the PAGS/PAS MCP convention (`pags/platform/workers/mcp/src/safety.ts`)
 * per the stores workspace rule: shared logic is copied between stores, not
 * depended on across them. The gate order every mutating tool follows is:
 *
 *   requirePermission -> dryRun (preview, writes nothing) -> requireConfirmation -> write
 *
 * Every outcome — allowed, previewed, or refused — is written to the audit log,
 * so a refusal leaves as much of a trace as a success.
 *
 * ProDocStore differs from PAGS in one respect: it has two scopes rather than
 * four, and `write` is granted fail-closed (see parseScopes in auth-handler.ts).
 * PAGS can default-grant `write` because its genuinely destructive tools sit
 * behind a separate `destructive` scope; here `write` is itself the gate on the
 * only mutable state the server has, so it has to be asked for.
 */

export const MCP_SCOPES = ["read", "write"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** How long audit rows are retained. */
const AUDIT_TTL_SECONDS = 90 * 86_400;

export interface TextResult {
  // The MCP SDK types tool results as an open record; without this index
  // signature the handlers fail to match its callback overloads.
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

export const txt = (text: string): TextResult => ({ content: [{ type: "text", text }] });
export const jsonTxt = (value: unknown): TextResult => txt(JSON.stringify(value, null, 2));

export interface SafetyContext {
  /** KV namespace audit rows are written to. Audit is skipped when absent. */
  auditKv?: KVNamespace;
  /** The authenticated user id, e.g. `github_4242`. Absent means unauthenticated. */
  subject?: string;
  /** Scopes granted to this token at authorization time. */
  scopes?: string[] | null;
  /** Global kill switch — refuses every non-read operation. */
  readOnly?: boolean;
}

export function hasScope(ctx: SafetyContext, scope: McpScope): boolean {
  return (ctx.scopes ?? []).includes(scope);
}

/**
 * Refuse unless the caller is signed in and holds `scope`. Returns null when the
 * call may proceed, or the refusal to return to the client.
 */
export async function requirePermission(
  ctx: SafetyContext,
  scope: McpScope,
  tool: string,
  input?: Record<string, unknown>,
): Promise<TextResult | null> {
  if (!ctx.subject) {
    await audit(ctx, { tool, action: "denied", reason: "unauthenticated", requiredScope: scope, input });
    return txt(`Error: ${tool} requires a signed-in ProDocStore account. Connect with GitHub OAuth first.`);
  }
  if (scope !== "read" && ctx.readOnly) {
    await audit(ctx, { tool, action: "denied", reason: "read_only", requiredScope: scope, input });
    return txt(`Error: ${tool} requires ${scope} permission, but MCP is in read-only mode.`);
  }
  if (!hasScope(ctx, scope)) {
    await audit(ctx, {
      tool,
      action: "denied",
      reason: "missing_scope",
      requiredScope: scope,
      scopes: ctx.scopes ?? null,
      input,
    });
    return txt(
      `Error: ${tool} requires MCP scope "${scope}". Reconnect requesting that scope — it is not granted by default.`,
    );
  }
  return null;
}

/** Refuse unless `confirm` exactly matches `expected`. */
export async function requireConfirmation(
  ctx: SafetyContext,
  tool: string,
  confirm: string | undefined,
  expected: string,
  reason: string,
  input?: Record<string, unknown>,
): Promise<TextResult | null> {
  if (confirm === expected) return null;
  await audit(ctx, { tool, action: "denied", reason: "missing_confirmation", expected, input });
  return txt(`Error: ${tool} requires confirm="${expected}". ${reason}`);
}

/** Report what a call would do, write nothing, and record the preview. */
export async function dryRun(
  ctx: SafetyContext,
  tool: string,
  action: string,
  input: Record<string, unknown>,
  wouldDo: unknown,
): Promise<TextResult> {
  const body = { dryRun: true, tool, action, wouldDo };
  await audit(ctx, { tool, action: "dry_run", input, result: body });
  return jsonTxt(body);
}

export async function audit(ctx: SafetyContext, event: Record<string, unknown>): Promise<void> {
  if (!ctx.auditKv || !ctx.subject) return;
  const now = new Date().toISOString();
  const key = `audit:${ctx.subject}:${now}:${crypto.randomUUID()}`;
  await ctx.auditKv.put(
    key,
    JSON.stringify({ time: now, subject: ctx.subject, ...(redact(event) as Record<string, unknown>) }),
    { expirationTtl: AUDIT_TTL_SECONDS },
  );
}

export async function listAuditEvents(ctx: SafetyContext, limit = 50): Promise<unknown[]> {
  if (!ctx.auditKv || !ctx.subject) return [];
  const safeLimit = Math.max(1, Math.min(200, limit));
  const listed = await ctx.auditKv.list({ prefix: `audit:${ctx.subject}:`, limit: safeLimit });
  const rows = await Promise.all(
    listed.keys
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, safeLimit)
      .map(async (key) => {
        const raw = await ctx.auditKv?.get(key.name);
        if (!raw) return null;
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return { raw };
        }
      }),
  );
  return rows.filter((row) => row !== null);
}

// Value shapes that look like a live secret even under an innocent key name.
const SECRET_VALUE = new RegExp(
  [
    "sk-(?:ant-)?[A-Za-z0-9_-]{16,}", // OpenAI / Anthropic
    "gh[pousr]_[A-Za-z0-9]{20,}", // GitHub tokens
    "xox[baprs]-[A-Za-z0-9-]{10,}", // Slack
    "AIza[0-9A-Za-z_-]{20,}", // Google API key
    "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{4,}", // JWT
    "Bearer\\s+[A-Za-z0-9._-]{12,}", // bearer header
  ].join("|"),
  "gi",
);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") {
    const masked = value.replace(SECRET_VALUE, "[redacted]");
    return masked.length > 500 ? `${masked.slice(0, 500)}...` : masked;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      /token|secret|password|credential|authorization|auth|api[_-]?key|apikey|access[_-]?(code|token)|refresh[_-]?token|bearer|private[_-]?key|client[_-]?secret|cookie/i.test(
        key,
      )
    ) {
      out[key] = "[redacted]";
    } else {
      out[key] = redact(item, depth + 1);
    }
  }
  return out;
}
