import { pds as app, type SecretStatus } from './pds'
import type { EditForm, Proposal, PublishForm, PublishStep, RepoFile, Settings, StepState } from '../types'

export async function generateKbFiles(settings: Settings, form: PublishForm): Promise<RepoFile[]> {
  const workflow = deployWorkflow(form)
  const system = [
    'You generate ProDocStore knowledge bases.',
    'Only output GitHub repo source files for a Zensical project.',
    'Do not output generated HTML or static site output.',
    'Use Markdown under docs/, zensical.toml at the repo root, and a concise README.',
    'Return only JSON: {"files":[{"path":"...","content":"..."}]}',
  ].join(' ')
  const user = [
    `Title: ${form.title}`,
    `Slug: ${form.slug}`,
    `Production URL: ${liveTargetFor(form)}`,
    form.customDomain ? `Custom domain: https://${form.customDomain}/` : 'Custom domain: none',
    '',
    'Company context:',
    `- Company: ${form.companyName || 'not specified'}`,
    `- Department: ${form.department || 'not specified'}`,
    `- Audience: ${form.audience || 'not specified'}`,
    `- Knowledge owner: ${form.knowledgeOwner || 'not specified'}`,
    `- Review cadence: ${form.reviewCadence || 'not specified'}`,
    `- Compliance mode: ${form.complianceMode || 'not specified'}`,
    `- Support channel: ${form.supportChannel || 'not specified'}`,
    `- Escalation path: ${form.escalationPath || 'not specified'}`,
    '',
    'Required files:',
    '- README.md',
    '- .gitignore',
    '- zensical.toml',
    '- docs/index.md',
    '- docs/first-principles.md',
    '- docs/assessment-method.md',
    '- docs/governance.md',
    '- docs/operations.md',
    '- docs/support-and-escalation.md',
    '- docs/register.md',
    '- docs/access-policy.md',
    '',
    'Knowledge-base prompt:',
    form.prompt,
  ].join('\n')
  const json = await callOpenAi(settings, system, user)
  const parsed = parseJson(json) as { files?: RepoFile[] }
  const aiFiles = Array.isArray(parsed.files) ? parsed.files : []
  const normalized = aiFiles
    .filter((file) => typeof file.path === 'string' && typeof file.content === 'string')
    .map((file) => ({ path: file.path.replace(/^\/+/, ''), content: file.content }))
    .filter((file) => !file.path.startsWith('site/') && !file.path.endsWith('.html'))
  const withRequired = upsertFile(normalized, '.github/workflows/deploy.yml', workflow)
  return ensureFallbackFiles(withRequired, form, workflow)
}

export async function generateEditProposal(settings: Settings, form: EditForm, current: string): Promise<Proposal> {
  const system = [
    'You are an AI-first Markdown knowledge-base editor.',
    'Return a complete replacement for the file, not a patch.',
    'Preserve truthful facts and formatting unless the request changes them.',
    'Do not invent dates, legal claims, prices, or product capabilities.',
    'Return only JSON: {"summary":"...","rationale":"...","content":"..."}',
  ].join(' ')
  const user = [`Path: ${form.path}`, '', 'Current source:', '```', current, '```', '', 'Request:', form.instruction].join('\n')
  const json = await callOpenAi(settings, system, user)
  const parsed = parseJson(json) as Proposal
  if (!parsed.content?.trim()) throw new Error('AI response did not include replacement content.')
  return parsed
}

export async function createRepo(form: PublishForm) {
  const viewer = await githubJson('https://api.github.com/user')
  const isUser = viewer.login?.toLowerCase() === form.owner.toLowerCase()
  const url = isUser ? 'https://api.github.com/user/repos' : `https://api.github.com/orgs/${encodeURIComponent(form.owner)}/repos`
  const res = await app.proxy.fetch(proxyTarget(url), {
    method: 'POST',
    headers: githubHeaders(),
    body: JSON.stringify({
      name: form.slug,
      description: `${form.title} - ProDocStore Zensical knowledge base`,
      private: form.visibility === 'private',
      auto_init: true,
      homepage: form.customDomain ? `https://${form.customDomain}/` : `https://${form.slug}.pages.dev/`,
    }),
  })
  if (res.status === 422) {
    return githubJson(`https://api.github.com/repos/${encodeURIComponent(form.owner)}/${encodeURIComponent(form.slug)}`)
  }
  if (!res.ok) throw new Error(`GitHub repo create failed: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function writeFiles(repo: string, files: RepoFile[]) {
  for (const file of files) {
    await writeGitHubFile(repo, file.path, file.content)
  }
}

export async function readGitHubFile(repo: string, path: string, branch: string) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const res = await app.proxy.fetch(`api.github.com/repos/${repoApiPath(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`, {
    headers: githubHeaders(),
  })
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status} ${await res.text()}`)
  const json = await res.json()
  if (json.encoding !== 'base64' || typeof json.content !== 'string') throw new Error('GitHub path is not a text file.')
  return base64ToText(json.content)
}

export function validatePublishForm(form: PublishForm) {
  if (!form.title.trim()) throw new Error('Title is required.')
  if (!/^[a-z][a-z0-9-]{1,57}$/.test(form.slug)) throw new Error('Slug must be lowercase letters, numbers, and hyphens.')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(form.owner.trim())) throw new Error('GitHub owner must be a valid user or organization name.')
  if (form.customDomain && !isValidDomain(form.customDomain)) throw new Error('Custom domain must be a valid hostname.')
  if (!form.prompt.trim()) throw new Error('Prompt is required.')
  if (form.visibility === 'private') validatePrivateAccess(form)
}

export function validateKbFiles(files: RepoFile[]) {
  const paths = new Set(files.map((file) => file.path))
  const failures = [
    ['zensical.toml', !paths.has('zensical.toml')],
    ['docs/index.md', !paths.has('docs/index.md')],
    ['Markdown under docs/', !files.some((file) => file.path.startsWith('docs/') && file.path.endsWith('.md'))],
    ['no generated site output', files.some((file) => file.path.startsWith('site/') || file.path.endsWith('.html'))],
  ].filter(([, failed]) => failed)
  if (failures.length) throw new Error(`Generated files failed Zensical validation: ${failures.map(([name]) => name).join(', ')}`)
}

export function validateAi(settings: Settings) {
  if (!settings.openaiEndpoint.trim()) throw new Error('OpenAI endpoint is required.')
  if (!settings.model.trim()) throw new Error('Model is required.')
}

export function validateByok(secrets: SecretStatus) {
  if (!secrets.openai.configured) throw new Error('Save your OpenAI BYOK key in Profile > Platform connections before using AI generation.')
}

export function validatePlatformAccess(user: unknown) {
  if (!user) throw new Error('Sign in to ProDocStore before publishing or editing.')
}

export function liveTargetFor(form: Pick<PublishForm, 'slug' | 'customDomain'>) {
  return form.customDomain ? `https://${form.customDomain}/` : `https://${form.slug}.pages.dev/`
}

export function proxyTarget(url: string) {
  return url.replace(/^https?:\/\//, '')
}

export function parseStoredJson<T>(value: string | null): T | null {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

export function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 58)
}

export function normalizeDomain(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '')
}

export function githubEditUrl(form: EditForm) {
  const [owner, repo] = form.repo.split('/')
  const path = form.path.split('/').map(encodeURIComponent).join('/')
  return owner && repo ? `https://github.com/${owner}/${repo}/edit/${encodeURIComponent(form.branch || 'main')}/${path}` : 'https://github.com'
}

export function buildLineDiff(before: string, after: string) {
  if (before === after) return 'No content changes proposed.'
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  const rows = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1])
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i++]}`)
      j++
    } else if (rows[i + 1][j] >= rows[i][j + 1]) out.push(`- ${a[i++]}`)
    else out.push(`+ ${b[j++]}`)
  }
  while (i < a.length) out.push(`- ${a[i++]}`)
  while (j < b.length) out.push(`+ ${b[j++]}`)
  return out.join('\n')
}

export function resetSteps(initialSteps: PublishStep[], active: string, state: StepState) {
  return initialSteps.map((step) => ({ ...step, state: step.id === active ? state : 'idle' as StepState }))
}

export function updateStep(id: string, state: StepState, detail: string) {
  return (prev: PublishStep[]) => prev.map((step) => (step.id === id ? { ...step, state, detail } : step))
}

export function markCurrentError(current: PublishStep[]) {
  const busy = current.find((step) => step.state === 'busy')
  if (!busy) return current
  return current.map((step) => (step.id === busy.id ? { ...step, state: 'error' as StepState } : step))
}

export function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function callOpenAi(settings: Settings, system: string, user: string): Promise<string> {
  const res = await app.proxy.fetch(proxyTarget(settings.openaiEndpoint), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: settings.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!res.ok) throw new Error(`OpenAI request failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('OpenAI returned no content.')
  return content
}

async function writeGitHubFile(repo: string, path: string, content: string) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const url = `https://api.github.com/repos/${repoApiPath(repo)}/contents/${encodedPath}`
  let sha: string | undefined
  const existing = await app.proxy.fetch(proxyTarget(url), { headers: githubHeaders() })
  if (existing.ok) {
    const json = await existing.json()
    sha = json.sha
  }
  const res = await app.proxy.fetch(proxyTarget(url), {
    method: 'PUT',
    headers: githubHeaders(),
    body: JSON.stringify({
      message: `${sha ? 'Update' : 'Add'} ${path}`,
      content: textToBase64(content),
      sha,
    }),
  })
  if (!res.ok) throw new Error(`GitHub write failed for ${path}: ${res.status} ${await res.text()}`)
}

function deployWorkflow(form: PublishForm) {
  const project = form.slug
  const customDomain = form.customDomain
  const accessEnv = form.visibility === 'private'
    ? `
          ACCESS_EMAIL_DOMAIN: ${yamlString(form.accessEmailDomain)}
          ACCESS_ALLOWED_EMAILS: ${yamlString(form.accessAllowedEmails)}
          ACCESS_CLIENT_DOMAIN: ${yamlString(form.accessClientDomain)}
          ACCESS_OFFICE_CIDRS: ${yamlString(form.accessOfficeCidrs)}
          ACCESS_RULES_JSON: ${yamlString(form.accessRulesJson)}
`
    : ''
  const accessSteps = form.visibility === 'private'
    ? `
      - name: Ensure Cloudflare Access app
        id: access
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
${accessEnv}        run: |
          set -euo pipefail
          DOMAIN="${project}.pages.dev"
          BASE="https://api.cloudflare.com/client/v4/accounts/\${CLOUDFLARE_ACCOUNT_ID}/access"
          APP_ID=""
          PAGE=1
          while true; do
            LIST_RESPONSE=$(curl -sS "\${BASE}/apps?page=\${PAGE}&per_page=50" -H "Authorization: Bearer \${CLOUDFLARE_API_TOKEN}")
            if [ "$(echo "$LIST_RESPONSE" | jq -r '.success // false')" != "true" ]; then
              echo "::error::Failed to list Cloudflare Access apps"
              echo "$LIST_RESPONSE" >&2
              exit 1
            fi
            MATCH=$(echo "$LIST_RESPONSE" | jq -r --arg d "$DOMAIN" '(.result // [])[] | select(.self_hosted_domains[]? == $d or .domain == $d) | .id' | head -1)
            if [ -n "$MATCH" ]; then APP_ID="$MATCH"; break; fi
            TOTAL_PAGES=$(echo "$LIST_RESPONSE" | jq -r '.result_info.total_pages // 1')
            [ "$PAGE" -ge "$TOTAL_PAGES" ] && break
            PAGE=$((PAGE + 1))
          done
          if [ -z "$APP_ID" ]; then
            CREATE_RESPONSE=$(curl -sS -X POST "\${BASE}/apps" \
              -H "Authorization: Bearer \${CLOUDFLARE_API_TOKEN}" \
              -H "Content-Type: application/json" \
              -d "$(jq -nc --arg name "${project}" --arg domain "$DOMAIN" '{name:$name, domain:$domain, type:"self_hosted", session_duration:"24h"}')")
            APP_ID=$(echo "$CREATE_RESPONSE" | jq -r '.result.id // empty')
            if [ -z "$APP_ID" ]; then
              echo "::error::Failed to create Cloudflare Access app for $DOMAIN"
              echo "$CREATE_RESPONSE" >&2
              exit 1
            fi
          fi
          echo "app_id=$APP_ID" >> "$GITHUB_OUTPUT"
      - name: Sync Cloudflare Access policies
        uses: ProDocStore-online/platform/.github/actions/sync-access-policies@main
        with:
          app-id: \${{ steps.access.outputs.app_id }}
          cf-api-token: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          cf-account-id: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          email-domain: ${yamlString(form.accessEmailDomain)}
          client-emails: ${yamlString(form.accessAllowedEmails)}
          client-domain: ${yamlString(form.accessClientDomain)}
          office-cidrs: ${yamlString(form.accessOfficeCidrs)}
          access-rules-json: ${yamlString(form.accessRulesJson)}
`
    : ''
  const verifyAccessStep = form.visibility === 'private'
    ? `
      - name: Verify Cloudflare Access protection
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          set -euo pipefail
          sleep 15
          DOMAIN="${project}.pages.dev"
          HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "https://\${DOMAIN}" || echo "000")
          echo "https://\${DOMAIN} returned HTTP \${HTTP_STATUS}"
          if [ "$HTTP_STATUS" = "200" ]; then
            echo "::error::Private KB is publicly accessible. Rolling back latest deployment."
            DEPLOYMENTS=$(curl -sS "https://api.cloudflare.com/client/v4/accounts/\${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${project}/deployments" -H "Authorization: Bearer \${CLOUDFLARE_API_TOKEN}")
            LATEST_ID=$(echo "$DEPLOYMENTS" | jq -r '.result[0].id // empty')
            if [ -n "$LATEST_ID" ]; then
              curl -sS -X DELETE "https://api.cloudflare.com/client/v4/accounts/\${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${project}/deployments/\${LATEST_ID}?force=true" -H "Authorization: Bearer \${CLOUDFLARE_API_TOKEN}" >/dev/null
            fi
            exit 1
          fi
`
    : ''
  const domainStep = customDomain
    ? `
      - name: Attach custom domain
        run: npx wrangler pages domain add "${customDomain}" --project-name="${project}" || true
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
`
    : ''
  return `name: Deploy Zensical KB

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  deployments: write

concurrency:
  group: deploy-zensical
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - run: python -m pip install zensical
      - run: python -m zensical build --strict
      - name: Inject ProDocStore source metadata
        run: |
          node <<'NODE'
          const fs = require('node:fs');
          const path = require('node:path');

          const repo = process.env.GITHUB_REPOSITORY;
          if (!repo) throw new Error('GITHUB_REPOSITORY is not set');

          const siteDir = 'site';
          const docsDir = 'docs';
          const sourceExts = ['.md', '.mdx', '.markdown', '.html', '.htm'];

          function walk(dir) {
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
              const full = path.join(dir, entry.name);
              return entry.isDirectory() ? walk(full) : [full];
            });
          }

          function escapeAttr(value) {
            return String(value)
              .replace(/&/g, '&amp;')
              .replace(/"/g, '&quot;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');
          }

          function sourceForHtml(file) {
            let rel = path.relative(siteDir, file).split(path.sep).join('/');
            if (rel === 'index.html') rel = 'index';
            else if (rel.endsWith('/index.html')) rel = rel.slice(0, -'/index.html'.length);
            else rel = rel.replace(/\\.html?$/i, '');
            const candidates = sourceExts.map((ext) => path.posix.join(docsDir, rel + ext));
            return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
          }

          for (const file of walk(siteDir).filter((candidate) => /\\.html?$/i.test(candidate))) {
            let html = fs.readFileSync(file, 'utf8');
            html = html.replace(/<meta\\s+[^>]*name=["']source-repo["'][^>]*>\\s*/gi, '');
            html = html.replace(/<meta\\s+[^>]*name=["']source-path["'][^>]*>\\s*/gi, '');
            const sourcePath = sourceForHtml(file);
            const meta = [
              '<meta name="source-repo" content="' + escapeAttr(repo) + '">',
              '<meta name="source-path" content="' + escapeAttr(sourcePath) + '">',
            ].join('\\n      ');
            if (/<head[^>]*>/i.test(html)) {
              html = html.replace(/<head([^>]*)>/i, '<head$1>\\n      ' + meta);
            } else {
              html = meta + '\\n' + html;
            }
            fs.writeFileSync(file, html);
          }
          NODE
      - name: Ensure Cloudflare Pages project
        run: npx wrangler pages project create "${project}" --production-branch=main || true
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
${accessSteps}
      - name: Deploy to Cloudflare Pages
        run: npx wrangler pages deploy site --project-name="${project}" --branch=main
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
${verifyAccessStep}${domainStep}`
}

function ensureFallbackFiles(files: RepoFile[], form: PublishForm, workflow: string): RepoFile[] {
  let next = [...files]
  const siteUrl = liveTargetFor(form)
  next = upsertFile(next, '.github/workflows/deploy.yml', workflow)
  next = upsertFile(next, '.gitignore', 'site/\n.cache/\n.DS_Store\n')
  if (!next.some((file) => file.path === 'README.md')) {
    next.push({ path: 'README.md', content: readmeFor(form) })
  }
  const zensicalIndex = next.findIndex((file) => file.path === 'zensical.toml')
  if (zensicalIndex >= 0) {
    next[zensicalIndex] = {
      ...next[zensicalIndex],
      content: setTomlScalar(setTomlScalar(next[zensicalIndex].content, 'site_url', siteUrl), 'repo_url', `https://github.com/${form.owner}/${form.slug}`),
    }
  } else {
    next.push({
      path: 'zensical.toml',
      content: zensicalTomlFor(form, siteUrl),
    })
  }
  if (!next.some((file) => file.path === 'docs/index.md')) {
    next.push({ path: 'docs/index.md', content: indexDocFor(form) })
  }
  if (!next.some((file) => file.path === 'docs/governance.md')) next.push({ path: 'docs/governance.md', content: governanceDocFor(form) })
  if (!next.some((file) => file.path === 'docs/operations.md')) next.push({ path: 'docs/operations.md', content: operationsDocFor(form) })
  if (!next.some((file) => file.path === 'docs/support-and-escalation.md')) next.push({ path: 'docs/support-and-escalation.md', content: supportDocFor(form) })
  if (!next.some((file) => file.path === 'docs/access-policy.md')) next.push({ path: 'docs/access-policy.md', content: accessPolicyDocFor(form) })
  return next.sort((a, b) => a.path.localeCompare(b.path))
}

function readmeFor(form: PublishForm) {
  return [
    `# ${form.title}`,
    '',
    'ProDocStore Zensical knowledge base.',
    '',
    `- Company: ${form.companyName || 'Not specified'}`,
    `- Department: ${form.department || 'Not specified'}`,
    `- Audience: ${form.audience || 'Not specified'}`,
    `- Knowledge owner: ${form.knowledgeOwner || 'Not specified'}`,
    `- Review cadence: ${form.reviewCadence || 'Not specified'}`,
    `- Compliance mode: ${form.complianceMode || 'Not specified'}`,
    '- Source: `docs/`',
    '- Build: `python -m zensical build --strict`',
  ].join('\n')
}

function zensicalTomlFor(form: PublishForm, siteUrl: string) {
  return [
    `site_name = "${tomlString(form.title)}"`,
    `site_url = "${tomlString(siteUrl)}"`,
    `repo_url = "https://github.com/${tomlString(form.owner)}/${tomlString(form.slug)}"`,
    'docs_dir = "docs"',
    'site_dir = "site"',
    '',
    '[nav]',
    'items = [',
    '  { title = "Overview", path = "index.md" },',
    '  { title = "First Principles", path = "first-principles.md" },',
    '  { title = "Assessment Method", path = "assessment-method.md" },',
    '  { title = "Governance", path = "governance.md" },',
    '  { title = "Operations", path = "operations.md" },',
    '  { title = "Support and Escalation", path = "support-and-escalation.md" },',
    '  { title = "Access Policy", path = "access-policy.md" },',
    '  { title = "Register", path = "register.md" },',
    ']',
    '',
  ].join('\n')
}

function indexDocFor(form: PublishForm) {
  return [
    `# ${form.title}`,
    '',
    form.prompt,
    '',
    '## Company Context',
    '',
    `- Company: ${form.companyName || 'Not specified'}`,
    `- Department: ${form.department || 'Not specified'}`,
    `- Audience: ${form.audience || 'Not specified'}`,
    `- Knowledge owner: ${form.knowledgeOwner || 'Not specified'}`,
    `- Review cadence: ${form.reviewCadence || 'Not specified'}`,
    `- Compliance mode: ${form.complianceMode || 'Not specified'}`,
  ].join('\n')
}

function governanceDocFor(form: PublishForm) {
  return [
    '# Governance',
    '',
    `Knowledge owner: ${form.knowledgeOwner || 'Not assigned'}.`,
    `Review cadence: ${form.reviewCadence || 'Not specified'}.`,
    `Compliance mode: ${form.complianceMode || 'Standard internal controls'}.`,
    '',
    '## Operating Rules',
    '',
    '- Every page should have an accountable owner.',
    '- Material process changes should be reviewed before publishing.',
    '- Stale, disputed, or superseded guidance should be marked clearly.',
    '- Evidence, decisions, and exceptions should link to source records where possible.',
  ].join('\n')
}

function operationsDocFor(form: PublishForm) {
  return [
    '# Operations',
    '',
    `Department: ${form.department || 'Not specified'}.`,
    `Audience: ${form.audience || 'Not specified'}.`,
    '',
    '## Expected Use',
    '',
    '- Use this KB as the first source for routine work.',
    '- Keep procedures short, current, and connected to evidence.',
    '- Prefer checklists and decision records over informal notes.',
  ].join('\n')
}

function supportDocFor(form: PublishForm) {
  return [
    '# Support and Escalation',
    '',
    `Support channel: ${form.supportChannel || 'Not specified'}.`,
    `Escalation path: ${form.escalationPath || 'Not specified'}.`,
    '',
    '## Intake',
    '',
    '- Capture the issue, impacted audience, urgency, and source page.',
    '- Route unclear ownership to the knowledge owner.',
    '- Escalate security, legal, HR, or customer-impacting items before publishing.',
  ].join('\n')
}

function accessPolicyDocFor(form: PublishForm) {
  return [
    '# Access Policy',
    '',
    `Visibility: ${form.visibility}.`,
    `Staff email domain: ${form.accessEmailDomain || 'Not specified'}.`,
    `Allowed emails: ${form.accessAllowedEmails || 'Not specified'}.`,
    `Client email domain: ${form.accessClientDomain || 'Not specified'}.`,
    `Office CIDRs: ${form.accessOfficeCidrs || 'Not specified'}.`,
    '',
    'Private KBs are closed by default and should only expose content through explicit Cloudflare Access rules.',
  ].join('\n')
}

function validatePrivateAccess(form: PublishForm) {
  if (form.customDomain) throw new Error('Private custom domains are blocked until Cloudflare Access custom-domain provisioning is implemented. Clear the custom domain first.')
  const parsedRules = parseAccessRules(form.accessRulesJson)
  const hasIdentityRule = Boolean(form.accessEmailDomain || form.accessAllowedEmails.trim() || form.accessClientDomain || parsedRules.include.length)
  const hasBypassRule = Boolean(form.accessOfficeCidrs.trim())
  if (!hasIdentityRule && !hasBypassRule) throw new Error('Private KBs are closed by default and require at least one Cloudflare Access allow rule: email domain, allowed email, raw include rule, client domain, or office CIDR.')
  if ((parsedRules.require.length || parsedRules.exclude.length) && !hasIdentityRule) throw new Error('Cloudflare Access require/exclude rules need at least one include rule.')
  if (form.accessEmailDomain && !isValidDomain(form.accessEmailDomain)) throw new Error('Staff email domain must be a valid domain.')
  if (form.accessClientDomain && !isValidDomain(form.accessClientDomain)) throw new Error('Client email domain must be a valid domain.')
  for (const email of commaList(form.accessAllowedEmails)) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Allowed email is not valid: ${email}`)
  }
  for (const cidr of commaList(form.accessOfficeCidrs)) {
    if (!/^(\d{1,3}\.){3}\d{1,3}\/([0-9]|[1-2][0-9]|3[0-2])$/.test(cidr)) throw new Error(`Office CIDR is not valid: ${cidr}`)
    const octets = cidr.split('/')[0].split('.').map(Number)
    if (octets.some((octet) => octet > 255)) throw new Error(`Office CIDR is not valid: ${cidr}`)
  }
}

function parseAccessRules(value: string) {
  if (!value.trim()) return { include: [], require: [], exclude: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Additional Cloudflare Access rules must be valid JSON.')
  }
  const source = Array.isArray(parsed) ? { include: parsed } : parsed
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Additional Cloudflare Access rules must be an object with include, require, and/or exclude arrays.')
  }
  const record = source as Record<string, unknown>
  const allowedKeys = new Set(['include', 'require', 'exclude'])
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) throw new Error(`Unsupported Access rules key: ${key}. Use include, require, or exclude.`)
  }
  return {
    include: accessRuleArray(record.include, 'include'),
    require: accessRuleArray(record.require, 'require'),
    exclude: accessRuleArray(record.exclude, 'exclude'),
  }
}

function accessRuleArray(value: unknown, name: string): Record<string, unknown>[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(`Additional Access ${name} rules must be an array.`)
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Each Access ${name} rule must be an object.`)
  }
  return value as Record<string, unknown>[]
}

function githubHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function githubJson(url: string) {
  const res = await app.proxy.fetch(proxyTarget(url), { headers: githubHeaders() })
  if (!res.ok) throw new Error(`GitHub API failed: ${res.status} ${await res.text()}`)
  return res.json()
}

function commaList(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function yamlString(value: string) {
  return JSON.stringify(value)
}

function tomlString(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function repoApiPath(repo: string) {
  return repo.split('/').map(encodeURIComponent).join('/')
}

function upsertFile(files: RepoFile[], path: string, content: string) {
  const without = files.filter((file) => file.path !== path)
  return [...without, { path, content }]
}

function parseJson(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('AI did not return JSON.')
    return JSON.parse(match[0])
  }
}

function isValidDomain(value: string) {
  return /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)
}

function setTomlScalar(content: string, key: string, value: string) {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const line = `${key} = "${escaped}"`
  const pattern = new RegExp(`^${key}\\s*=\\s*(['"]).*\\1$`, 'm')
  return pattern.test(content) ? content.replace(pattern, line) : `${line}\n${content}`
}

function textToBase64(text: string) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToText(value: string) {
  const binary = atob(value.replace(/\n/g, ''))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
