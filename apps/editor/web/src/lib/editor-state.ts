import type { AppRoute, EditForm, KnowledgeBaseDraft, PlatformConnections, PublishForm, PublishStep, Settings } from '../types'
import { normalizeDomain, slugify } from './publishing'

export const DEFAULT_MODEL = 'gpt-4.1-mini'
export const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions'
export const PDS_MCP = 'https://mcp.prodocstore.online/mcp'
export const CONFIG_KEY = 'pds:config:v1'
export const KBS_KEY = 'pds:kbs:v1'
export const ACTIVE_KB_KEY = 'pds:active-kb:v1'

export const emptySettings: Settings = {
  openaiEndpoint: DEFAULT_ENDPOINT,
  model: DEFAULT_MODEL,
}

export const initialConnections: PlatformConnections = {
  github: 'unchecked',
  openai: 'needs-setup',
  cloudflare: 'ready',
  mcp: 'unchecked',
  detail: 'Save your OpenAI BYOK key once in your ProDocStore account. Cloudflare deploy credentials live in platform/org secrets.',
}

export const starterPublish: PublishForm = {
  title: 'Customer Knowledge Base',
  slug: 'customer-knowledge-base',
  owner: 'ProDocStore-online',
  customDomain: '',
  visibility: 'private',
  accessEmailDomain: '',
  accessAllowedEmails: '',
  accessClientDomain: '',
  accessOfficeCidrs: '',
  accessRulesJson: '',
  prompt:
    'A private staff knowledge base for onboarding, operating procedures, policies, and decision records.',
}

export const starterEdit: EditForm = {
  repo: 'ProDocStore-online/customer-knowledge-base',
  branch: 'main',
  path: 'docs/index.md',
  instruction: 'Make this page clearer for a new reader while preserving the same factual claims.',
}

export const initialSteps: PublishStep[] = [
  { id: 'plan', label: 'Plan', detail: 'Create Zensical structure', state: 'idle' },
  { id: 'ai', label: 'Draft', detail: 'Generate Markdown files', state: 'idle' },
  { id: 'repo', label: 'Repo', detail: 'Create GitHub repository', state: 'idle' },
  { id: 'secrets', label: 'Secrets', detail: 'Install Cloudflare deploy secrets', state: 'idle' },
  { id: 'files', label: 'Files', detail: 'Commit Zensical source', state: 'idle' },
  { id: 'deploy', label: 'Deploy', detail: 'GitHub Actions publishes to Cloudflare', state: 'idle' },
]

export function cloneSteps() {
  return initialSteps.map((step) => ({ ...step }))
}

export function nowIso() {
  return new Date().toISOString()
}

export function createKnowledgeBase(form: PublishForm): KnowledgeBaseDraft {
  const timestamp = nowIso()
  return {
    ...form,
    customDomain: normalizeDomain(form.customDomain),
    id: crypto.randomUUID(),
    files: [],
    liveUrl: '',
    repoUrl: '',
    lastStatus: 'Draft',
    createdAt: timestamp,
    updatedAt: timestamp,
    steps: cloneSteps(),
  }
}

export function normalizeSettings(value: Partial<Settings> | null | undefined): Settings {
  return {
    openaiEndpoint: typeof value?.openaiEndpoint === 'string' && value.openaiEndpoint.trim()
      ? value.openaiEndpoint
      : DEFAULT_ENDPOINT,
    model: typeof value?.model === 'string' && value.model.trim() ? value.model : DEFAULT_MODEL,
  }
}

export function normalizeKnowledgeBase(value: Partial<KnowledgeBaseDraft> & PublishForm): KnowledgeBaseDraft {
  const base = createKnowledgeBase({ ...starterPublish, ...value })
  return {
    ...base,
    id: value.id || base.id,
    files: Array.isArray(value.files) ? value.files : [],
    liveUrl: value.liveUrl || '',
    repoUrl: value.repoUrl || '',
    lastStatus: value.lastStatus || 'Draft',
    createdAt: value.createdAt || base.createdAt,
    updatedAt: value.updatedAt || base.updatedAt,
    steps: Array.isArray(value.steps) && value.steps.length ? value.steps : cloneSteps(),
  }
}

export function toPublishForm(kb: KnowledgeBaseDraft): PublishForm {
  return {
    title: kb.title,
    slug: kb.slug,
    owner: kb.owner,
    customDomain: kb.customDomain,
    visibility: kb.visibility,
    accessEmailDomain: kb.accessEmailDomain,
    accessAllowedEmails: kb.accessAllowedEmails,
    accessClientDomain: kb.accessClientDomain,
    accessOfficeCidrs: kb.accessOfficeCidrs,
    accessRulesJson: kb.accessRulesJson,
    prompt: kb.prompt,
  }
}

export function nextAvailableSlug(kbs: KnowledgeBaseDraft[], desired: string) {
  const base = slugify(desired) || 'knowledge-base'
  const used = new Set(kbs.map((kb) => kb.slug))
  if (!used.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

export function displayName(user: { id?: string; login?: string; name?: string }) {
  return user.name || user.login || user.id || 'User'
}

export function normalizeRoute(raw: string): AppRoute {
  const route = raw.replace(/^#?\/?/, '').replace(/^\/+|\/+$/g, '')
  if (route === 'publish' || route === 'edit' || route === 'profile') return route
  return 'dashboard'
}

export function routeFromLocation(): AppRoute {
  const hashRoute = normalizeRoute(window.location.hash)
  if (hashRoute !== 'dashboard') return hashRoute
  const path = window.location.pathname.replace(/^\/+|\/+$/g, '')
  return normalizeRoute(path)
}

export function pathForRoute(route: AppRoute) {
  return route === 'dashboard' ? '/' : `/${route}`
}

export function pushRoute(route: AppRoute) {
  const next = pathForRoute(route)
  if (window.location.pathname !== next || window.location.hash) window.history.pushState(null, '', next)
}
