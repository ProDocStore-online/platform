export type AppRoute = 'dashboard' | 'publish' | 'edit' | 'profile'
export type AuthProvider = 'github' | 'google'
export type StepState = 'idle' | 'busy' | 'ok' | 'error'
export type ConnectionState = 'unchecked' | 'checking' | 'ready' | 'needs-setup' | 'error'

export interface Settings {
  openaiEndpoint: string
  model: string
}

export interface PlatformConnections {
  github: ConnectionState
  openai: ConnectionState
  cloudflare: ConnectionState
  mcp: ConnectionState
  detail: string
}

export interface McpHealth {
  ok: boolean
  oauthConfigured: boolean
  storageConfigured: boolean
  callbackUrl: string
}

export interface PublishForm {
  title: string
  slug: string
  owner: string
  customDomain: string
  companyName: string
  department: string
  audience: string
  knowledgeOwner: string
  reviewCadence: string
  complianceMode: string
  supportChannel: string
  escalationPath: string
  visibility: 'public' | 'private'
  accessEmailDomain: string
  accessAllowedEmails: string
  accessClientDomain: string
  accessOfficeCidrs: string
  accessRulesJson: string
  prompt: string
}

export interface EditForm {
  repo: string
  branch: string
  path: string
  instruction: string
}

export interface RepoFile {
  path: string
  content: string
}

export interface Proposal {
  summary: string
  rationale: string
  content: string
}

export interface PublishStep {
  id: string
  label: string
  detail: string
  state: StepState
}

export interface KnowledgeBaseDraft extends PublishForm {
  id: string
  files: RepoFile[]
  liveUrl: string
  repoUrl: string
  lastStatus: string
  createdAt: string
  updatedAt: string
  steps: PublishStep[]
}
