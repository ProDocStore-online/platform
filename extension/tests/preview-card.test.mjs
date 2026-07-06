// Tests for the proposal preview card renderer (diff + Apply/Cancel).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";
import { installDom, reset, fire } from "./_dom-shim.mjs";

installDom();
const { renderPreview } = await import(await bundle("src/sidepanel/preview-card.ts"));

beforeEach(reset);

const editProposal = (over = {}) => ({
  proposalId: "p1",
  kind: "edit",
  path: "docs/a.md",
  commitMode: "pr",
  outcomes: [{ find: "old", replace: "new text", applied: true }],
  ...over,
});

test("edit preview shows the target path and the final replacement text", () => {
  const container = document.createElement("div");
  const wrap = renderPreview(editProposal(), container, { onApply: () => {}, onCancel: () => {} });
  assert.equal(wrap.querySelector(".preview-header").textContent, "docs/a.md");
  assert.equal(wrap.dataset.proposalId, "p1");
  assert.ok(wrap.querySelector(".preview-edit.applied"));
  assert.match(wrap.textContent, /new text/);
});

test("apply button label reflects commit mode", () => {
  const c1 = document.createElement("div");
  const pr = renderPreview(editProposal({ commitMode: "pr" }), c1, { onApply: () => {}, onCancel: () => {} });
  assert.equal(pr.querySelector(".preview-apply").textContent, "Apply (open PR)");
  const c2 = document.createElement("div");
  const direct = renderPreview(editProposal({ commitMode: "direct" }), c2, { onApply: () => {}, onCancel: () => {} });
  assert.equal(direct.querySelector(".preview-apply").textContent, "Apply (push to main)");
});

test("clicking Apply fires onApply once and flips the button to a disabled 'Applying…'", () => {
  const container = document.createElement("div");
  let calls = [];
  const wrap = renderPreview(editProposal(), container, {
    onApply: (id, c) => calls.push([id, c]),
    onCancel: () => {},
  });
  const btn = wrap.querySelector(".preview-apply");
  fire(btn, "click");
  assert.deepEqual(calls, [["p1", container]]);
  assert.equal(btn.textContent, "Applying…");
  assert.equal(btn.disabled, true);
  // A second click is a no-op (already disabled).
  fire(btn, "click");
  assert.equal(calls.length, 1);
});

test("clicking Cancel fires onCancel with the proposalId + container", () => {
  const container = document.createElement("div");
  let got = null;
  const wrap = renderPreview(editProposal(), container, {
    onApply: () => {},
    onCancel: (id, c) => { got = [id, c]; },
  });
  fire(wrap.querySelector(".preview-cancel"), "click");
  assert.deepEqual(got, ["p1", container]);
});

test("a skipped outcome renders a diagnostic note instead of a body", () => {
  const container = document.createElement("div");
  const wrap = renderPreview(
    editProposal({ outcomes: [{ find: "x", replace: "y", applied: false, reason: "not_found" }] }),
    container,
    { onApply: () => {}, onCancel: () => {} },
  );
  assert.ok(wrap.querySelector(".preview-edit.skipped"));
  assert.match(wrap.querySelector(".preview-note").textContent, /skipped: not_found/);
});

test("memory proposal renders the entry under its section", () => {
  const container = document.createElement("div");
  const wrap = renderPreview(
    { proposalId: "m1", kind: "memory", entry: "Deploys are gated on CI", section: "Ops", commitMode: "pr" },
    container,
    { onApply: () => {}, onCancel: () => {} },
  );
  assert.equal(wrap.querySelector(".preview-header").textContent, ".prodocstore/MEMORY.md");
  assert.match(wrap.textContent, /Ops/);
  assert.match(wrap.textContent, /Deploys are gated on CI/);
});

test("nav proposal renders the proposed content verbatim", () => {
  const container = document.createElement("div");
  const wrap = renderPreview(
    { proposalId: "n1", kind: "nav", path: "docs/nav.json", newContent: '{"items":[]}', commitMode: "pr" },
    container,
    { onApply: () => {}, onCancel: () => {} },
  );
  assert.equal(wrap.querySelector(".preview-header").textContent, "docs/nav.json");
  assert.equal(wrap.querySelector(".diff-replace").textContent, '{"items":[]}');
});
