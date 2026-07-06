const UA = "prodocstore-mcp";

export interface Registry {
  knowledge_bases?: KnowledgeBase[];
}

export interface KnowledgeBase {
  id: string;
  title: string;
  description?: string;
  engine: "zensical" | string;
  source: {
    repo: string;
    branch?: string;
    docs_dir?: string;
    config?: string;
  };
  cloudflare?: {
    pages_project?: string;
    production_url?: string;
    custom_domains?: string[];
  };
  status?: string;
}

export interface RepoFile {
  path: string;
  type: string;
  size?: number;
}

async function gh(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) json.__status = res.status;
  return json;
}

function b64ToText(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function readRegistry(registryUrl: string): Promise<Registry> {
  const res = await fetch(registryUrl, {
    headers: { Accept: "application/json", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`registry fetch failed: ${res.status}`);
  return (await res.json()) as Registry;
}

export async function listRepoFiles(repoFullName: string, branch = "main"): Promise<RepoFile[]> {
  const base = `https://api.github.com/repos/${repoFullName}`;
  const ref = await gh(`${base}/git/ref/heads/${encodeURIComponent(branch)}`);
  const headSha = ref?.object?.sha;
  if (!headSha) return [];
  const tree = await gh(`${base}/git/trees/${headSha}?recursive=1`);
  if (!Array.isArray(tree?.tree)) return [];
  return tree.tree
    .filter((item: any) => item.type === "blob" || item.type === "tree")
    .map((item: any) => ({ path: item.path, type: item.type, size: item.size }));
}

export async function readRepoFile(repoFullName: string, path: string, branch = "main"): Promise<string | null> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${repoFullName}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
  const res = await gh(url);
  if (typeof res?.content !== "string" || res.encoding !== "base64") return null;
  return b64ToText(res.content);
}

export async function getDeployStatus(repoFullName: string) {
  const res = await fetch(`https://api.github.com/repos/${repoFullName}/actions/runs?per_page=5`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) return { error: `GitHub API ${res.status}` };
  const data = (await res.json()) as {
    workflow_runs?: Array<{
      name: string;
      conclusion: string | null;
      status: string;
      updated_at: string;
      html_url: string;
      head_sha: string;
    }>;
  };
  return (data.workflow_runs ?? []).map((run) => ({
    name: run.name,
    status: run.conclusion ?? run.status,
    updatedAt: run.updated_at,
    url: run.html_url,
    sha: run.head_sha?.slice(0, 7),
  }));
}

export function findKnowledgeBase(registry: Registry, id: string): KnowledgeBase | undefined {
  return (registry.knowledge_bases ?? []).find((kb) => kb.id === id);
}

