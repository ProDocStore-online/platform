import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);
const WEB_ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(WEB_ROOT, "src", "lib", "publishing.ts");

function loadPublishingModule() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pds-publishing-test-"));
  try {
    const source = readFileSync(SOURCE, "utf8").replace(/^import .+$/gm, "");
    const output = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
      fileName: SOURCE,
    }).outputText;
    const modulePath = path.join(tmp, "publishing.cjs");
    writeFileSync(modulePath, output);
    return { mod: require(modulePath), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

function baseForm(overrides = {}) {
  return {
    title: "Customer Knowledge Base",
    slug: "customer-knowledge-base",
    owner: "ProDocStore-online",
    customDomain: "",
    companyName: "Acme Inc.",
    department: "Operations",
    audience: "Internal staff",
    knowledgeOwner: "Ops Enablement",
    reviewCadence: "Quarterly",
    complianceMode: "Standard internal controls",
    supportChannel: "helpdesk@example.com",
    escalationPath: "Manager, security, legal, HR",
    visibility: "private",
    accessEmailDomain: "ozai.digital",
    accessAllowedEmails: "admin@ozai.digital, ops@client.com",
    accessClientDomain: "client.com",
    accessOfficeCidrs: "203.0.113.0/24",
    accessRulesJson: '{"include":[{"github_organization":{"name":"org","identity_provider_id":"id"}}]}',
    prompt: "A private staff knowledge base.",
    ...overrides,
  };
}

function workflowFor(form) {
  const { mod, cleanup } = loadPublishingModule();
  try {
    const files = mod.buildStarterKbFiles(form);
    const workflow = files.find((file) => file.path === ".github/workflows/deploy.yml");
    assert.ok(workflow, "expected generated deploy workflow");
    return workflow.content;
  } finally {
    cleanup();
  }
}

test("private KB workflow is a thin caller to the reusable Zensical publisher", () => {
  const workflow = workflowFor(baseForm());
  assert.match(workflow, /uses: ProDocStore-online\/platform\/\.github\/workflows\/deploy-zensical-kb\.yml@publisher-v2/);
  assert.match(workflow, /project-name: "customer-knowledge-base"/);
  assert.match(workflow, /public: false/);
  assert.match(workflow, /email-domain: "ozai\.digital"/);
  assert.match(workflow, /allowed-emails: "admin@ozai\.digital, ops@client\.com"/);
  assert.match(workflow, /client-domain: "client\.com"/);
  assert.match(workflow, /office-cidrs: "203\.0\.113\.0\/24"/);
  assert.match(workflow, /access-rules-json: "{\\"include\\":\[\{\\"github_organization\\":\{\\"name\\":\\"org\\",\\"identity_provider_id\\":\\"id\\"\}\}\]}"/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
  assert.doesNotMatch(workflow, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(workflow, /python -m zensical build --strict/);
  assert.ok(workflow.split("\n").length < 60, "expected generated workflow to stay small");
});

test("public KB workflow opts into public mode and passes custom domain", () => {
  const workflow = workflowFor(baseForm({
    visibility: "public",
    customDomain: "docs.example.com",
    accessEmailDomain: "",
    accessAllowedEmails: "",
    accessClientDomain: "",
    accessOfficeCidrs: "",
    accessRulesJson: "",
  }));
  assert.match(workflow, /public: true/);
  assert.match(workflow, /custom-domain: "docs\.example\.com"/);
  assert.match(workflow, /email-domain: ""/);
  assert.match(workflow, /access-rules-json: ""/);
});
