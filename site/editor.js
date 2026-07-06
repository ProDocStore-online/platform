const $ = (id) => document.getElementById(id);

const repoEl = $("repo");
const branchEl = $("branch");
const pathEl = $("path");
const githubTokenEl = $("github-token");
const openaiKeyEl = $("openai-key");
const openaiEndpointEl = $("openai-endpoint");
const modelEl = $("model");
const instructionEl = $("instruction");
const formEl = $("editor-form");
const statusPill = $("status-pill");
const sourceOutput = $("source-output");
const proposalOutput = $("proposal-output");
const diffOutput = $("diff-output");
const summaryEl = $("proposal-summary");
const openGithubBtn = $("open-github");
const copyBtn = $("copy-proposal");
const downloadBtn = $("download-proposal");

let currentSource = "";
let proposedSource = "";
let currentSha = "";

function setStatus(text, tone = "") {
  statusPill.textContent = text;
  statusPill.dataset.tone = tone;
}

function repoParts() {
  const value = repoEl.value.trim();
  const match = value.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) throw new Error("Repo must be in owner/repo format.");
  return { owner: match[1], repo: match[2] };
}

function githubHeaders() {
  const token = githubTokenEl.value.trim();
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function decodeBase64Unicode(value) {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function githubEditUrl() {
  const { owner, repo } = repoParts();
  const branch = encodeURIComponent(branchEl.value.trim() || "main");
  const path = pathEl.value.trim().split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${owner}/${repo}/edit/${branch}/${path}`;
}

async function loadSource() {
  const { owner, repo } = repoParts();
  const branch = branchEl.value.trim() || "main";
  const path = pathEl.value.trim();
  if (!path) throw new Error("File path is required.");

  setStatus("Loading", "busy");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub read failed: ${res.status} ${body}`);
  }
  const json = await res.json();
  if (json.type !== "file" || typeof json.content !== "string") {
    throw new Error("Target path is not a readable file.");
  }
  currentSha = json.sha || "";
  currentSource = decodeBase64Unicode(json.content);
  proposedSource = "";
  sourceOutput.textContent = currentSource;
  proposalOutput.textContent = "";
  diffOutput.textContent = "Source loaded. Ask AI for a proposal.";
  summaryEl.textContent = `Loaded ${path} from ${owner}/${repo}@${branch}${currentSha ? ` (${currentSha.slice(0, 7)})` : ""}.`;
  openGithubBtn.disabled = false;
  copyBtn.disabled = true;
  downloadBtn.disabled = true;
  setStatus("Loaded", "ok");
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("AI did not return valid JSON.");
  }
}

async function askAiForProposal() {
  if (!currentSource) await loadSource();
  const model = modelEl.value.trim();
  const apiKey = openaiKeyEl.value.trim();
  const endpoint = openaiEndpointEl.value.trim();
  const instruction = instructionEl.value.trim();
  if (!apiKey) throw new Error("OpenAI API key is required.");
  if (!endpoint) throw new Error("AI endpoint is required.");
  if (!model) throw new Error("Model is required.");
  if (!instruction) throw new Error("Change request is required.");

  setStatus("Asking AI", "busy");
  const sourcePath = pathEl.value.trim();
  const system = [
    "You are an AI-first knowledge base editor.",
    "Humans do not manually edit content in this UI.",
    "Return a complete replacement for the source file, not a patch.",
    "Preserve truthful facts, links, front matter, headings, and formatting unless the user asked to change them.",
    "Do not invent policies, metrics, legal claims, prices, dates, or product capabilities.",
    "Return only JSON with keys: summary, rationale, content.",
  ].join(" ");

  const user = [
    `Source path: ${sourcePath}`,
    "",
    "Current source:",
    "```",
    currentSource,
    "```",
    "",
    "Requested change:",
    instruction,
  ].join("\n");

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI request failed: ${res.status} ${body}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenAI returned no message content.");
  const proposal = parseJsonObject(content);
  if (typeof proposal.content !== "string" || !proposal.content.trim()) {
    throw new Error("AI proposal is missing replacement content.");
  }

  proposedSource = proposal.content;
  proposalOutput.textContent = proposedSource;
  diffOutput.textContent = buildLineDiff(currentSource, proposedSource);
  summaryEl.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = proposal.summary || "AI proposal ready";
  const detail = document.createElement("p");
  detail.textContent = proposal.rationale || "Review the diff, then copy the content or open the file in GitHub.";
  summaryEl.append(title, detail);
  copyBtn.disabled = false;
  downloadBtn.disabled = false;
  setStatus("Proposal ready", "ok");
}

function buildLineDiff(before, after) {
  if (before === after) return "No content changes proposed.";
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < m) out.push(`- ${a[i++]}`);
  while (j < n) out.push(`+ ${b[j++]}`);
  return out.join("\n");
}

function restoreSession() {
  const saved = JSON.parse(sessionStorage.getItem("prodocstore-editor") || "{}");
  for (const [id, value] of Object.entries(saved)) {
    const el = $(id);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.value = String(value);
  }
}

function persistSession() {
  const data = {
    repo: repoEl.value,
    branch: branchEl.value,
    path: pathEl.value,
    model: modelEl.value,
    "openai-endpoint": openaiEndpointEl.value,
    "github-token": githubTokenEl.value,
    "openai-key": openaiKeyEl.value,
  };
  sessionStorage.setItem("prodocstore-editor", JSON.stringify(data));
}

function showError(err) {
  const message = err instanceof Error ? err.message : String(err);
  summaryEl.textContent = message;
  setStatus("Error", "error");
}

$("load-source").addEventListener("click", () => {
  persistSession();
  loadSource().catch(showError);
});

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  persistSession();
  askAiForProposal().catch(showError);
});

openGithubBtn.addEventListener("click", () => {
  try {
    window.open(githubEditUrl(), "_blank", "noopener,noreferrer");
  } catch (err) {
    showError(err);
  }
});

copyBtn.addEventListener("click", async () => {
  if (!proposedSource) return;
  await navigator.clipboard.writeText(proposedSource);
  setStatus("Copied", "ok");
});

downloadBtn.addEventListener("click", () => {
  if (!proposedSource) return;
  const blob = new Blob([proposedSource], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = pathEl.value.trim().split("/").pop() || "proposal.txt";
  a.click();
  URL.revokeObjectURL(url);
});

document.querySelectorAll(".review-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.getAttribute("data-tab");
    document.querySelectorAll(".review-tab").forEach((button) => button.classList.toggle("active", button === tab));
    document.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.hidden = panel.getAttribute("data-panel") !== target;
    });
  });
});

restoreSession();
