import { useEffect, useMemo, useState } from 'react'
import { initPro, ProShell, useAuth } from '@proappstore/sdk'
import {
  BookOpen,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Github,
  Globe2,
  KeyRound,
  LayoutDashboard,
  Loader2,
  PenLine,
  Plus,
  Rocket,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCircle,
} from 'lucide-react'

const app = initPro({ appId: 'freedocstore-editor' })
const DEFAULT_MODEL = 'gpt-4.1-mini'
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions'
const FDS_MCP = 'https://freedocstore-mcp.serge-the-dev.workers.dev/mcp'
const CONFIG_KEY = 'fds:config:v1'
const KBS_KEY = 'fds:kbs:v1'
const ACTIVE_KB_KEY = 'fds:active-kb:v1'

type AppRoute = 'dashboard' | 'publish' | 'edit' | 'profile'
type StepState = 'idle' | 'busy' | 'ok' | 'error'
type ConnectionState = 'unchecked' | 'checking' | 'ready' | 'needs-setup' | 'error'

interface Settings {
  openaiEndpoint: string
  model: string
}

interface PlatformConnections {
  github: ConnectionState
  openai: ConnectionState
  cloudflare: ConnectionState
  detail: string
}

interface PublishForm {
  title: string
  slug: string
  owner: string
  customDomain: string
  visibility: 'public' | 'private'
  prompt: string
}

interface EditForm {
  repo: string
  branch: string
  path: string
  instruction: string
}

interface RepoFile {
  path: string
  content: string
}

interface Proposal {
  summary: string
  rationale: string
  content: string
}

interface PublishStep {
  id: string
  label: string
  detail: string
  state: StepState
}

interface KnowledgeBaseDraft extends PublishForm {
  id: string
  files: RepoFile[]
  liveUrl: string
  repoUrl: string
  lastStatus: string
  createdAt: string
  updatedAt: string
  steps: PublishStep[]
}

const emptySettings: Settings = {
  openaiEndpoint: DEFAULT_ENDPOINT,
  model: DEFAULT_MODEL,
}

const initialConnections: PlatformConnections = {
  github: 'unchecked',
  openai: 'unchecked',
  cloudflare: 'ready',
  detail: 'Cloudflare deploy credentials are expected to live in platform/org secrets, not KB drafts.',
}

const starterPublish: PublishForm = {
  title: 'True Non-Profit',
  slug: 'true-non-profit',
  owner: 'FreeDocStore',
  customDomain: '',
  visibility: 'public',
  prompt:
    'A first-principles knowledge base about non-profits, what they should be, how to assess trueness, and how to maintain a public evidence register.',
}

const starterEdit: EditForm = {
  repo: 'FreeDocStore/true-non-profit',
  branch: 'main',
  path: 'docs/index.md',
  instruction: 'Make this page clearer for a new reader while preserving the same factual claims.',
}

const initialSteps: PublishStep[] = [
  { id: 'plan', label: 'Plan', detail: 'Create Zensical structure', state: 'idle' },
  { id: 'ai', label: 'Draft', detail: 'Generate Markdown files', state: 'idle' },
  { id: 'repo', label: 'Repo', detail: 'Create GitHub repository', state: 'idle' },
  { id: 'files', label: 'Files', detail: 'Commit Zensical source', state: 'idle' },
  { id: 'secrets', label: 'Platform', detail: 'Use stored Cloudflare deploy connection', state: 'idle' },
  { id: 'deploy', label: 'Deploy', detail: 'GitHub Actions publishes to Cloudflare', state: 'idle' },
]

function cloneSteps() {
  return initialSteps.map((step) => ({ ...step }))
}

function nowIso() {
  return new Date().toISOString()
}

function createKnowledgeBase(form: PublishForm): KnowledgeBaseDraft {
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

function normalizeKnowledgeBase(value: Partial<KnowledgeBaseDraft> & PublishForm): KnowledgeBaseDraft {
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

function toPublishForm(kb: KnowledgeBaseDraft): PublishForm {
  return {
    title: kb.title,
    slug: kb.slug,
    owner: kb.owner,
    customDomain: kb.customDomain,
    visibility: kb.visibility,
    prompt: kb.prompt,
  }
}

function liveTargetFor(form: Pick<PublishForm, 'slug' | 'customDomain'>) {
  return form.customDomain ? `https://${form.customDomain}/` : `https://${form.slug}.pages.dev/`
}

function nextAvailableSlug(kbs: KnowledgeBaseDraft[], desired: string) {
  const base = slugify(desired) || 'knowledge-base'
  const used = new Set(kbs.map((kb) => kb.slug))
  if (!used.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

function routeFromHash(): AppRoute {
  const raw = window.location.hash.replace(/^#\/?/, '')
  return raw === 'publish' || raw === 'edit' || raw === 'profile' ? raw : 'dashboard'
}

function setHashRoute(route: AppRoute) {
  const next = route === 'dashboard' ? '#/' : `#/${route}`
  if (window.location.hash !== next) window.location.hash = next
}

function App() {
  return (
    <ProShell app={app} appName="FreeDocStore Editor" allowFree showThemeToggle>
      <EditorApp />
    </ProShell>
  )
}

function EditorApp() {
  const { user } = useAuth(app)
  const [route, setRoute] = useState<AppRoute>(() => routeFromHash())
  const [settings, setSettings] = useState<Settings>(emptySettings)
  const [kbs, setKbs] = useState<KnowledgeBaseDraft[]>(() => [createKnowledgeBase(starterPublish)])
  const [platformLoaded, setPlatformLoaded] = useState(false)
  const [connections, setConnections] = useState<PlatformConnections>(initialConnections)
  const [activeKbId, setActiveKbId] = useState('')
  const [editForm, setEditForm] = useState<EditForm>(starterEdit)
  const [source, setSource] = useState('')
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [diff, setDiff] = useState('')
  const [activePreview, setActivePreview] = useState<'files' | 'source' | 'proposal' | 'diff'>('files')
  const [status, setStatus] = useState('Ready')
  const [busy, setBusy] = useState(false)

  const activeKb = kbs.find((kb) => kb.id === activeKbId) ?? kbs[0] ?? createKnowledgeBase(starterPublish)
  const publishForm = toPublishForm(activeKb)
  const files = activeKb?.files ?? []
  const steps = activeKb?.steps ?? cloneSteps()
  const liveUrl = activeKb?.liveUrl ?? ''

  useEffect(() => {
    const syncRoute = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', syncRoute)
    syncRoute()
    return () => window.removeEventListener('hashchange', syncRoute)
  }, [])

  function navigate(route: AppRoute) {
    setRoute(route)
    setHashRoute(route)
  }

  useEffect(() => {
    const saved = parseStoredJson<Partial<Settings>>(localStorage.getItem('fds-editor-settings'))
    if (saved) setSettings({ ...emptySettings, ...saved })
    const savedKbs = parseStoredJson<unknown>(localStorage.getItem('fds-kb-drafts'))
    if (savedKbs) {
      const parsed = savedKbs
      if (Array.isArray(parsed) && parsed.length) {
        const normalized = parsed.map(normalizeKnowledgeBase)
        setKbs(normalized)
        const storedActive = localStorage.getItem('fds-active-kb')
        setActiveKbId(normalized.some((kb) => kb.id === storedActive) ? storedActive || normalized[0].id : normalized[0].id)
      }
    } else {
      const pub = parseStoredJson<Partial<PublishForm>>(localStorage.getItem('fds-publish-draft'))
      if (pub) {
        const legacy = createKnowledgeBase({ ...starterPublish, ...pub })
        setKbs([legacy])
        setActiveKbId(legacy.id)
      }
    }
    const edit = parseStoredJson<Partial<EditForm>>(localStorage.getItem('fds-edit-draft'))
    if (edit) setEditForm({ ...starterEdit, ...edit })
  }, [])

  useEffect(() => {
    if (!user) {
      setPlatformLoaded(false)
      return
    }
    let cancelled = false
    async function loadPlatformState() {
      try {
        const [savedSettings, savedKbs, savedActive] = await Promise.all([
          app.kv.get<Partial<Settings>>(CONFIG_KEY),
          app.kv.get<KnowledgeBaseDraft[]>(KBS_KEY),
          app.kv.get<string>(ACTIVE_KB_KEY),
        ])
        if (cancelled) return
        if (savedSettings) setSettings({ ...emptySettings, ...savedSettings })
        if (Array.isArray(savedKbs) && savedKbs.length) {
          const normalized = savedKbs.map(normalizeKnowledgeBase)
          setKbs(normalized)
          setActiveKbId(normalized.some((kb) => kb.id === savedActive) ? savedActive || normalized[0].id : normalized[0].id)
        }
        setStatus('Loaded platform workspace')
      } catch (error) {
        if (!cancelled) setStatus(`Platform workspace unavailable: ${messageOf(error)}`)
      } finally {
        if (!cancelled) setPlatformLoaded(true)
      }
    }
    loadPlatformState()
    return () => {
      cancelled = true
    }
  }, [user])

  useEffect(() => {
    if (kbs[0] && (!activeKbId || !kbs.some((kb) => kb.id === activeKbId))) setActiveKbId(kbs[0].id)
  }, [activeKbId, kbs])

  useEffect(() => {
    localStorage.setItem('fds-editor-settings', JSON.stringify(settings))
    if (user && platformLoaded) app.kv.set(CONFIG_KEY, settings).catch((error) => setStatus(`Could not save platform settings: ${messageOf(error)}`))
  }, [platformLoaded, settings, user])

  useEffect(() => {
    localStorage.setItem('fds-kb-drafts', JSON.stringify(kbs))
    if (user && platformLoaded) app.kv.set(KBS_KEY, kbs).catch((error) => setStatus(`Could not save platform KBs: ${messageOf(error)}`))
  }, [kbs, platformLoaded, user])

  useEffect(() => {
    if (activeKbId) localStorage.setItem('fds-active-kb', activeKbId)
    if (user && platformLoaded && activeKbId) app.kv.set(ACTIVE_KB_KEY, activeKbId).catch(() => {})
  }, [activeKbId, platformLoaded, user])

  useEffect(() => {
    localStorage.setItem('fds-edit-draft', JSON.stringify(editForm))
  }, [editForm])

  const generatedSummary = useMemo(() => {
    if (!files.length) return 'No files generated yet.'
    return `${files.length} file${files.length === 1 ? '' : 's'} ready: ${files.map((f) => f.path).join(', ')}`
  }, [files])

  function updateActiveKb(patch: Partial<KnowledgeBaseDraft>) {
    const id = activeKb?.id
    if (!id) return
    setKbs((current) => current.map((kb) => (kb.id === id ? { ...kb, ...patch, updatedAt: nowIso() } : kb)))
  }

  function updateActiveForm(form: PublishForm) {
    const changedGeneratedContract =
      form.title !== activeKb.title ||
      form.slug !== activeKb.slug ||
      form.owner !== activeKb.owner ||
      form.customDomain !== activeKb.customDomain ||
      form.prompt !== activeKb.prompt
    updateActiveKb({
      ...form,
      ...(changedGeneratedContract
        ? {
            files: [],
            liveUrl: '',
            repoUrl: '',
            lastStatus: 'Draft changed',
            steps: cloneSteps(),
          }
        : {}),
    })
  }

  function setKbSteps(id: string, updater: PublishStep[] | ((current: PublishStep[]) => PublishStep[])) {
    setKbs((current) =>
      current.map((kb) =>
        kb.id === id
          ? { ...kb, steps: typeof updater === 'function' ? updater(kb.steps) : updater, updatedAt: nowIso() }
          : kb,
      ),
    )
  }

  function setKbPatch(id: string, patch: Partial<KnowledgeBaseDraft>) {
    setKbs((current) => current.map((kb) => (kb.id === id ? { ...kb, ...patch, updatedAt: nowIso() } : kb)))
  }

  function createNewKb() {
    const owner = activeKb?.owner || starterPublish.owner
    const next = createKnowledgeBase({
      ...starterPublish,
      title: 'Untitled Knowledge Base',
      slug: nextAvailableSlug(kbs, 'new-knowledge-base'),
      owner,
      customDomain: '',
      prompt: '',
    })
    setKbs((current) => [next, ...current])
    setActiveKbId(next.id)
    navigate('publish')
    setActivePreview('files')
    setStatus('New KB draft ready')
  }

  function duplicateActiveKb() {
    if (!activeKb) return
    const copy = createKnowledgeBase({
      ...toPublishForm(activeKb),
      title: `${activeKb.title} Copy`,
      slug: nextAvailableSlug(kbs, `${activeKb.slug}-copy`),
      customDomain: '',
    })
    setKbs((current) => [copy, ...current])
    setActiveKbId(copy.id)
    navigate('publish')
    setActivePreview('files')
    setStatus('KB draft duplicated')
  }

  function deleteActiveKb() {
    if (!activeKb || kbs.length === 1) return
    const next = kbs.filter((kb) => kb.id !== activeKb.id)
    setKbs(next)
    setActiveKbId(next[0].id)
    setActivePreview('files')
    setStatus('KB draft removed')
  }

  async function generateFiles() {
    if (!activeKb) return
    const kbId = activeKb.id
    const form = toPublishForm(activeKb)
    setBusy(true)
    setStatus('Generating Zensical KB files')
    setKbSteps(kbId, resetSteps('plan', 'busy'))
    setKbPatch(kbId, { lastStatus: 'Generating files' })
    try {
      validatePublishForm(form)
      validatePlatformAccess(user)
      validateAi(settings)
      setKbSteps(kbId, updateStep('plan', 'ok', 'Zensical contract ready'))
      setKbSteps(kbId, updateStep('ai', 'busy', 'Asking AI for source files'))
      const nextFiles = await generateKbFiles(settings, form)
      validateKbFiles(nextFiles)
      setKbPatch(kbId, { files: nextFiles, lastStatus: 'Files generated' })
      setActivePreview('files')
      setKbSteps(kbId, updateStep('ai', 'ok', `${nextFiles.length} files generated`))
      setStatus('Files generated. Review, then publish.')
    } catch (error) {
      setStatus(messageOf(error))
      setKbPatch(kbId, { lastStatus: messageOf(error) })
      setKbSteps(kbId, markCurrentError)
    } finally {
      setBusy(false)
    }
  }

  async function publishToGitHub() {
    if (!activeKb) return
    const kbId = activeKb.id
    const form = toPublishForm(activeKb)
    setBusy(true)
    setStatus('Publishing KB repo')
    setKbPatch(kbId, { lastStatus: 'Publishing' })
    try {
      let readyFiles = activeKb.files
      if (!readyFiles.length) {
        validatePublishForm(form)
        validatePlatformAccess(user)
        validateAi(settings)
        setKbSteps(kbId, resetSteps('plan', 'busy'))
        setKbSteps(kbId, updateStep('plan', 'ok', 'Zensical contract ready'))
        setKbSteps(kbId, updateStep('ai', 'busy', 'Asking AI for source files'))
        readyFiles = await generateKbFiles(settings, form)
        validateKbFiles(readyFiles)
        setKbPatch(kbId, { files: readyFiles })
        setKbSteps(kbId, updateStep('ai', 'ok', `${readyFiles.length} files generated`))
      }
      validatePublishForm(form)
      validateKbFiles(readyFiles)
      validatePlatformAccess(user)

      setKbSteps(kbId, updateStep('repo', 'busy', 'Creating repository'))
      const repo = await createRepo(form)
      setKbSteps(kbId, updateStep('repo', 'ok', repo.html_url))
      setKbPatch(kbId, { repoUrl: repo.html_url })

      setKbSteps(kbId, updateStep('files', 'busy', 'Writing files to main'))
      await writeFiles(repo.full_name, readyFiles)
      setKbSteps(kbId, updateStep('files', 'ok', `${readyFiles.length} files committed`))

      setKbSteps(kbId, updateStep('secrets', 'ok', 'Using stored platform/org deploy secrets'))

      const url = liveTargetFor(form)
      setKbPatch(kbId, { liveUrl: url, lastStatus: 'Published' })
      setKbSteps(kbId, updateStep('deploy', 'ok', 'Workflow started on GitHub'))
      setStatus('Published. GitHub Actions is building the Zensical site.')
      window.open(`${repo.html_url}/actions`, '_blank', 'noopener,noreferrer')
    } catch (error) {
      setStatus(messageOf(error))
      setKbPatch(kbId, { lastStatus: messageOf(error) })
      setKbSteps(kbId, markCurrentError)
    } finally {
      setBusy(false)
    }
  }

  async function loadSource() {
    setBusy(true)
    setStatus('Loading source')
    try {
      validatePlatformAccess(user)
      const content = await readGitHubFile(editForm.repo, editForm.path, editForm.branch)
      setSource(content)
      setProposal(null)
      setDiff('Source loaded. Ask AI for a proposal.')
      setActivePreview('source')
      setStatus('Source loaded')
    } catch (error) {
      setStatus(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  async function askForEditProposal() {
    setBusy(true)
    setStatus('Asking AI for proposal')
    try {
      validatePlatformAccess(user)
      validateAi(settings)
      const current = source || (await readGitHubFile(editForm.repo, editForm.path, editForm.branch))
      setSource(current)
      const next = await generateEditProposal(settings, editForm, current)
      setProposal(next)
      setDiff(buildLineDiff(current, next.content))
      setActivePreview('diff')
      setStatus('Proposal ready')
    } catch (error) {
      setStatus(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const pageTitle = {
    dashboard: 'FreeDocStore Editor',
    publish: 'Publish a knowledge base',
    edit: 'Edit Markdown with AI',
    profile: 'Profile and connections',
  }[route]
  const pageCopy = {
    dashboard: 'Manage your knowledge-base drafts, launch new books, and track published targets.',
    publish: 'Generate a GitHub-backed documentation repo, deploy it to Cloudflare Pages, and attach a custom domain.',
    edit: 'Load an existing Markdown file, ask for a replacement draft, and apply the change through GitHub.',
    profile: 'Review your PAS account and platform-held publishing connections.',
  }[route]

  async function checkConnections() {
    setConnections({ ...initialConnections, github: 'checking', openai: 'checking' })
    setStatus('Checking platform connections')
    try {
      validatePlatformAccess(user)
      const github = await app.proxy.fetch('api.github.com/user', { headers: githubHeaders() })
      const openai = await app.proxy.fetch(proxyTarget(settings.openaiEndpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: settings.model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Return JSON only.' },
            { role: 'user', content: '{"ok":true}' },
          ],
        }),
      })
      setConnections({
        github: github.ok ? 'ready' : 'needs-setup',
        openai: openai.ok ? 'ready' : 'needs-setup',
        cloudflare: 'ready',
        detail: openai.ok && github.ok
          ? 'Platform connections are ready for repo creation and AI generation.'
          : `GitHub ${github.status}; OpenAI ${openai.status}. Configure PAS app secrets or user vault keys.`,
      })
      setStatus(github.ok && openai.ok ? 'Platform connections ready' : 'Some platform connections need setup')
    } catch (error) {
      setConnections({ github: 'error', openai: 'error', cloudflare: 'ready', detail: messageOf(error) })
      setStatus(messageOf(error))
    }
  }

  return (
    <main className="app-shell">
      <header className="workspace-head">
        <div>
          <h1>{pageTitle}</h1>
          <p className="lede">{pageCopy}</p>
        </div>
        <div className="status-block" aria-live="polite">
          <span className={busy ? 'pulse-dot busy' : 'pulse-dot'} />
          <div>
            <strong>{busy ? 'Working' : 'Status'}</strong>
            <p>{status}</p>
            {user?.name && <small>Signed in to PAS as {user.name}</small>}
          </div>
        </div>
      </header>

      <AppNav route={route} navigate={navigate} />

      {route === 'dashboard' ? (
        <DashboardPage
          kbs={kbs}
          activeId={activeKb?.id ?? ''}
          onSelect={(id) => {
            setActiveKbId(id)
            setActivePreview('files')
            navigate('publish')
          }}
          onCreate={createNewKb}
          onDuplicate={duplicateActiveKb}
          onDelete={deleteActiveKb}
          onPublish={() => navigate('publish')}
          onEdit={() => navigate('edit')}
        />
      ) : route === 'publish' ? (
        <div className="workspace-grid">
          <section className="panel control-panel">
            <SelectedKbHeader kb={activeKb} onBack={() => navigate('dashboard')} />
            <SettingsPanel settings={settings} setSettings={setSettings} connections={connections} onCheck={checkConnections} compact />
            <PublishPanel
              form={publishForm}
              setForm={updateActiveForm}
              steps={steps}
              busy={busy}
              onGenerate={generateFiles}
              onPublish={publishToGitHub}
              liveUrl={liveUrl}
            />
          </section>
          <section className="panel preview-panel">
            <PreviewTabs active={activePreview} setActive={setActivePreview} hasProposal={!!proposal} publish />
            <FilesPreview files={files} summary={generatedSummary} />
          </section>
        </div>
      ) : route === 'edit' ? (
        <div className="workspace-grid">
          <section className="panel control-panel">
            <SettingsPanel settings={settings} setSettings={setSettings} connections={connections} onCheck={checkConnections} compact />
            <EditPanel
              form={editForm}
              setForm={setEditForm}
              busy={busy}
              onLoad={loadSource}
              onAsk={askForEditProposal}
              proposal={proposal}
            />
          </section>
          <section className="panel preview-panel">
            <PreviewTabs active={activePreview} setActive={setActivePreview} hasProposal={!!proposal} />
            <EditPreview active={activePreview} source={source} proposal={proposal} diff={diff} path={editForm.path} />
          </section>
        </div>
      ) : (
        <ProfilePage
          user={user}
          settings={settings}
          setSettings={setSettings}
          connections={connections}
          onCheck={checkConnections}
          kbs={kbs}
        />
      )}
      <footer className="pas-footer">
        Built for <a href="https://proappstore.online" target="_blank" rel="noreferrer">proappstore.online</a>
      </footer>
    </main>
  )
}

function AppNav({ route, navigate }: { route: AppRoute; navigate: (route: AppRoute) => void }) {
  return (
    <nav className="app-nav" aria-label="Editor pages">
      <button className={route === 'dashboard' ? 'mode active' : 'mode'} onClick={() => navigate('dashboard')} type="button">
        <LayoutDashboard size={17} />
        Dashboard
      </button>
      <button className={route === 'publish' ? 'mode active' : 'mode'} onClick={() => navigate('publish')} type="button">
        <Rocket size={17} />
        Publish
      </button>
      <button className={route === 'edit' ? 'mode active' : 'mode'} onClick={() => navigate('edit')} type="button">
        <PenLine size={17} />
        Edit
      </button>
      <button className={route === 'profile' ? 'mode active' : 'mode'} onClick={() => navigate('profile')} type="button">
        <UserCircle size={17} />
        Profile
      </button>
      <a className="mode link-mode" href={FDS_MCP} target="_blank" rel="noreferrer">
        <ShieldCheck size={17} />
        MCP
      </a>
    </nav>
  )
}

function DashboardPage({
  kbs,
  activeId,
  onSelect,
  onCreate,
  onDuplicate,
  onDelete,
  onPublish,
  onEdit,
}: {
  kbs: KnowledgeBaseDraft[]
  activeId: string
  onSelect: (id: string) => void
  onCreate: () => void
  onDuplicate: () => void
  onDelete: () => void
  onPublish: () => void
  onEdit: () => void
}) {
  const published = kbs.filter((kb) => kb.liveUrl || kb.repoUrl).length
  return (
    <div className="dashboard-grid">
      <section className="panel">
        <KnowledgeBaseShelf
              kbs={kbs}
          activeId={activeId}
          onSelect={onSelect}
          onCreate={onCreate}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
        />
      </section>
      <section className="panel">
        <div className="section-block">
          <div className="section-title">
            <LayoutDashboard size={18} />
            <div>
              <h2>Workspace</h2>
              <p>Drafts and published targets for this browser session.</p>
            </div>
          </div>
          <div className="metric-grid">
            <div><span>Drafts</span><strong>{kbs.length}</strong></div>
            <div><span>Published</span><strong>{published}</strong></div>
            <div><span>Selected</span><strong>{kbs.find((kb) => kb.id === activeId)?.slug ?? 'None'}</strong></div>
          </div>
          <div className="action-row">
            <button className="primary-action" type="button" onClick={onPublish}>
              <Rocket size={17} />
              Open publisher
            </button>
            <button className="secondary-action" type="button" onClick={onEdit}>
              <PenLine size={17} />
              Edit existing docs
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

function KnowledgeBaseShelf({
  kbs,
  activeId,
  onSelect,
  onCreate,
  onDuplicate,
  onDelete,
}: {
  kbs: KnowledgeBaseDraft[]
  activeId: string
  onSelect: (id: string) => void
  onCreate: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  return (
    <div className="section-block kb-shelf">
      <div className="section-title split-title">
        <div className="title-row">
          <BookOpen size={18} />
          <div>
            <h2>Knowledge bases</h2>
            <p>{kbs.length} draft{kbs.length === 1 ? '' : 's'} in this browser</p>
          </div>
        </div>
        <button className="icon-action" type="button" onClick={onCreate} aria-label="Create KB">
          <Plus size={18} />
        </button>
      </div>
      <div className="kb-list" aria-label="Knowledge base drafts">
        {kbs.map((kb) => {
          const active = kb.id === activeId
          const target = liveTargetFor(kb)
          return (
            <article className={active ? 'kb-card active' : 'kb-card'} key={kb.id}>
              <button className="kb-card-main" type="button" onClick={() => onSelect(kb.id)}>
                <span className="kb-card-title">{kb.title || 'Untitled KB'}</span>
                <span className="kb-card-meta">{kb.owner}/{kb.slug}</span>
                <span className="kb-card-status">{kb.lastStatus || 'Draft'}</span>
              </button>
              <div className="kb-card-links">
                <a href={target} target="_blank" rel="noreferrer" aria-label={`${kb.title} live target`}>
                  <Globe2 size={15} />
                </a>
                {kb.repoUrl && (
                  <a href={kb.repoUrl} target="_blank" rel="noreferrer" aria-label={`${kb.title} GitHub repository`}>
                    <Github size={15} />
                  </a>
                )}
              </div>
            </article>
          )
        })}
      </div>
      <div className="action-row compact-actions">
        <button className="secondary-action" type="button" onClick={onDuplicate}>
          <Copy size={17} />
          Duplicate
        </button>
        <button className="secondary-action danger-action" type="button" onClick={onDelete} disabled={kbs.length === 1}>
          <Trash2 size={17} />
          Delete
        </button>
      </div>
    </div>
  )
}

function SelectedKbHeader({ kb, onBack }: { kb: KnowledgeBaseDraft; onBack: () => void }) {
  return (
    <div className="section-block selected-kb">
      <button className="text-action" type="button" onClick={onBack}>
        Dashboard
      </button>
      <div>
        <span>Selected knowledge base</span>
        <strong>{kb.title || 'Untitled KB'}</strong>
        <p>{kb.owner}/{kb.slug}</p>
      </div>
    </div>
  )
}

function SettingsPanel({
  settings,
  setSettings,
  connections,
  onCheck,
  compact = false,
}: {
  settings: Settings
  setSettings: (s: Settings) => void
  connections: PlatformConnections
  onCheck: () => void
  compact?: boolean
}) {
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings({ ...settings, [key]: value })
  const connectedCount = [connections.github, connections.openai, connections.cloudflare].filter((state) => state === 'ready').length
  return (
    <details className="section-block settings-details" open={!compact || connectedCount < 3}>
      <summary>
        <span className="summary-title">
          <KeyRound size={18} />
          <span>
            <strong>Platform connections</strong>
            <small>{connectedCount}/3 ready. Secrets are stored in PAS/platform, not in KB drafts.</small>
          </span>
        </span>
      </summary>
      <div className="connection-grid">
        <ConnectionBadge label="GitHub" state={connections.github} detail="Repository create/read/write through PAS proxy" />
        <ConnectionBadge label="OpenAI" state={connections.openai} detail="AI generation through PAS proxy or key vault" />
        <ConnectionBadge label="Cloudflare" state={connections.cloudflare} detail="Deploy credentials held by platform/org secrets" />
      </div>
      <p className="connection-detail">{connections.detail}</p>
      <div className="field-grid two">
        <Field label="OpenAI endpoint" value={settings.openaiEndpoint} onChange={(v) => update('openaiEndpoint', v)} />
        <Field label="Model" value={settings.model} onChange={(v) => update('model', v)} />
      </div>
      <div className="action-row compact-actions">
        <button className="secondary-action" type="button" onClick={onCheck}>
          <ShieldCheck size={17} />
          Check platform connections
        </button>
        <a className="secondary-action as-link" href="https://api.proappstore.online/v1/keys?app=freedocstore-editor" target="_blank" rel="noreferrer">
          <KeyRound size={17} />
          PAS key vault
        </a>
      </div>
    </details>
  )
}

function ConnectionBadge({ label, state, detail }: { label: string; state: ConnectionState; detail: string }) {
  const text = {
    unchecked: 'Not checked',
    checking: 'Checking',
    ready: 'Ready',
    'needs-setup': 'Needs setup',
    error: 'Error',
  }[state]
  return (
    <div className={`connection-badge ${state}`}>
      <span>{label}</span>
      <strong>{text}</strong>
      <p>{detail}</p>
    </div>
  )
}

function ProfilePage({
  user,
  settings,
  setSettings,
  connections,
  onCheck,
  kbs,
}: {
  user: unknown
  settings: Settings
  setSettings: (settings: Settings) => void
  connections: PlatformConnections
  onCheck: () => void
  kbs: KnowledgeBaseDraft[]
}) {
  const name = readUserField(user, 'name') || readUserField(user, 'login') || 'Signed-in user'
  const email = readUserField(user, 'email')
  const id = readUserField(user, 'id') || readUserField(user, 'sub')
  return (
    <div className="profile-grid">
      <section className="panel">
        <div className="section-block profile-card">
          <div className="avatar-mark">{name.slice(0, 1).toUpperCase()}</div>
          <div>
            <h2>{name}</h2>
            <p>{email || 'Authenticated with ProAppStore'}</p>
            {id && <small>Account ID: {id}</small>}
          </div>
        </div>
        <div className="section-block">
          <div className="section-title">
            <UserCircle size={18} />
            <div>
              <h2>Account</h2>
              <p>PAS manages sign-in and subscription status for this app.</p>
            </div>
          </div>
          <div className="metric-grid">
            <div><span>Drafts</span><strong>{kbs.length}</strong></div>
            <div><span>App</span><strong>FreeDocStore</strong></div>
            <div><span>Plan</span><strong>Pro</strong></div>
          </div>
        </div>
      </section>
      <section className="panel">
        <SettingsPanel settings={settings} setSettings={setSettings} connections={connections} onCheck={onCheck} />
      </section>
    </div>
  )
}

function PublishPanel({
  form,
  setForm,
  steps,
  busy,
  onGenerate,
  onPublish,
  liveUrl,
}: {
  form: PublishForm
  setForm: (form: PublishForm) => void
  steps: PublishStep[]
  busy: boolean
  onGenerate: () => void
  onPublish: () => void
  liveUrl: string
}) {
  const update = <K extends keyof PublishForm>(key: K, value: PublishForm[K]) => setForm({ ...form, [key]: value })
  return (
    <div className="section-block">
      <div className="section-title">
        <BookOpen size={18} />
        <div>
          <h2>Publish selected KB</h2>
          <p>Generates a Zensical Markdown repo and deploy workflow.</p>
        </div>
      </div>
      <div className="field-grid two">
        <Field label="Title" value={form.title} onChange={(v) => update('title', v)} />
        <Field label="Slug / Pages project" value={form.slug} onChange={(v) => update('slug', slugify(v))} />
        <Field label="GitHub owner" value={form.owner} onChange={(v) => update('owner', v)} />
        <Field label="Custom domain" value={form.customDomain} onChange={(v) => update('customDomain', normalizeDomain(v))} placeholder="docs.example.com" />
      </div>
      <div className="target-grid">
        <div>
          <span>Pages URL</span>
          <strong>https://{form.slug || 'project'}.pages.dev/</strong>
        </div>
        <div className={form.customDomain ? 'target-domain active' : 'target-domain'}>
          <span>Custom domain</span>
          <strong>{form.customDomain ? `https://${form.customDomain}/` : 'Not attached'}</strong>
        </div>
      </div>
      <label className="field">
        <span>Knowledge-base prompt</span>
        <textarea value={form.prompt} onChange={(e) => update('prompt', e.target.value)} rows={8} />
      </label>
      <div className="inline-choice">
        <button type="button" className={form.visibility === 'public' ? 'choice active' : 'choice'} onClick={() => update('visibility', 'public')}>
          Public
        </button>
        <button type="button" className={form.visibility === 'private' ? 'choice active' : 'choice'} onClick={() => update('visibility', 'private')}>
          Private repo
        </button>
      </div>
      <div className="action-row">
        <button className="secondary-action" type="button" onClick={onGenerate} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
          Generate files
        </button>
        <button className="primary-action" type="button" onClick={onPublish} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <Rocket size={17} />}
          Publish repo
        </button>
      </div>
      <div className="steps" aria-label="Publish progress">
        {steps.map((step) => (
          <div className={`step ${step.state}`} key={step.id}>
            <span>{step.state === 'busy' ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}</span>
            <div>
              <strong>{step.label}</strong>
              <p>{step.detail}</p>
            </div>
          </div>
        ))}
      </div>
      {liveUrl && (
        <a className="live-link" href={liveUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={17} />
          Open live KB target
        </a>
      )}
    </div>
  )
}

function EditPanel({
  form,
  setForm,
  busy,
  onLoad,
  onAsk,
  proposal,
}: {
  form: EditForm
  setForm: (form: EditForm) => void
  busy: boolean
  onLoad: () => void
  onAsk: () => void
  proposal: Proposal | null
}) {
  const update = <K extends keyof EditForm>(key: K, value: EditForm[K]) => setForm({ ...form, [key]: value })
  const githubEdit = githubEditUrl(form)
  return (
    <div className="section-block">
      <div className="section-title">
        <FileText size={18} />
        <div>
          <h2>Edit existing Markdown</h2>
          <p>AI drafts a full replacement. Manual edits stay in GitHub.</p>
        </div>
      </div>
      <div className="field-grid two">
        <Field label="Repo" value={form.repo} onChange={(v) => update('repo', v)} placeholder="owner/repo" />
        <Field label="Branch" value={form.branch} onChange={(v) => update('branch', v)} />
      </div>
      <Field label="Path" value={form.path} onChange={(v) => update('path', v)} placeholder="docs/index.md" />
      <label className="field">
        <span>Change request</span>
        <textarea value={form.instruction} onChange={(e) => update('instruction', e.target.value)} rows={8} />
      </label>
      <div className="action-row">
        <button className="secondary-action" type="button" onClick={onLoad} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <Download size={17} />}
          Load source
        </button>
        <button className="primary-action" type="button" onClick={onAsk} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
          Ask AI
        </button>
      </div>
      <div className="action-row compact-actions">
        <a className="secondary-action as-link" href={githubEdit} target="_blank" rel="noreferrer">
          <Github size={17} />
          Open GitHub editor
        </a>
        <button
          className="secondary-action"
          type="button"
          disabled={!proposal}
          onClick={() => proposal && navigator.clipboard.writeText(proposal.content)}
        >
          <Copy size={17} />
          Copy proposal
        </button>
      </div>
    </div>
  )
}

function PreviewTabs({
  active,
  setActive,
  hasProposal,
  publish = false,
}: {
  active: 'files' | 'source' | 'proposal' | 'diff'
  setActive: (tab: 'files' | 'source' | 'proposal' | 'diff') => void
  hasProposal: boolean
  publish?: boolean
}) {
  if (publish) {
    return (
      <div className="preview-tabs">
        <button className="preview-tab active" type="button" onClick={() => setActive('files')}>
          Generated files
        </button>
      </div>
    )
  }
  return (
    <div className="preview-tabs">
      <button className={active === 'diff' ? 'preview-tab active' : 'preview-tab'} type="button" onClick={() => setActive('diff')}>
        Diff
      </button>
      <button className={active === 'proposal' ? 'preview-tab active' : 'preview-tab'} type="button" onClick={() => setActive('proposal')} disabled={!hasProposal}>
        Proposal
      </button>
      <button className={active === 'source' ? 'preview-tab active' : 'preview-tab'} type="button" onClick={() => setActive('source')}>
        Source
      </button>
    </div>
  )
}

function FilesPreview({ files, summary }: { files: RepoFile[]; summary: string }) {
  const [selected, setSelected] = useState('')
  const current = files.find((file) => file.path === selected) ?? files[0]
  useEffect(() => {
    if (files[0] && !files.some((file) => file.path === selected)) setSelected(files[0].path)
  }, [files, selected])
  return (
    <div className="preview-body">
      <div className="preview-summary">
        <strong>{summary}</strong>
        <p>Review before publishing. Generated files must stay Markdown/Zensical source, not committed static output.</p>
      </div>
      {files.length > 0 ? (
        <div className="file-preview-layout">
          <div className="file-list">
            {files.map((file) => (
              <button key={file.path} className={current?.path === file.path ? 'file-row active' : 'file-row'} onClick={() => setSelected(file.path)} type="button">
                {file.path}
              </button>
            ))}
          </div>
          <pre className="code-view">{current?.content}</pre>
        </div>
      ) : (
        <div className="empty-state">
          <Sparkles size={24} />
          <p>Generate a KB to preview the Markdown repo files here.</p>
        </div>
      )}
    </div>
  )
}

function EditPreview({
  active,
  source,
  proposal,
  diff,
  path,
}: {
  active: 'files' | 'source' | 'proposal' | 'diff'
  source: string
  proposal: Proposal | null
  diff: string
  path: string
}) {
  const text = active === 'proposal' ? proposal?.content ?? '' : active === 'source' ? source : diff
  return (
    <div className="preview-body">
      <div className="preview-summary">
        <strong>{proposal?.summary ?? path}</strong>
        <p>{proposal?.rationale ?? 'Load a Markdown file and ask AI for a replacement proposal.'}</p>
      </div>
      <pre className="code-view">{text || 'Nothing to preview yet.'}</pre>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  secret?: boolean
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} type={secret ? 'password' : 'text'} />
    </label>
  )
}

async function generateKbFiles(settings: Settings, form: PublishForm): Promise<RepoFile[]> {
  const workflow = deployWorkflow(form.slug, form.customDomain)
  const system = [
    'You generate FreeDocStore knowledge bases.',
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
    'Required files:',
    '- README.md',
    '- .gitignore',
    '- zensical.toml',
    '- docs/index.md',
    '- docs/first-principles.md',
    '- docs/assessment-method.md',
    '- docs/register.md',
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

async function generateEditProposal(settings: Settings, form: EditForm, current: string): Promise<Proposal> {
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

async function createRepo(form: PublishForm) {
  const viewer = await githubJson('https://api.github.com/user')
  const isUser = viewer.login?.toLowerCase() === form.owner.toLowerCase()
  const url = isUser ? 'https://api.github.com/user/repos' : `https://api.github.com/orgs/${encodeURIComponent(form.owner)}/repos`
  const res = await app.proxy.fetch(proxyTarget(url), {
    method: 'POST',
    headers: githubHeaders(),
    body: JSON.stringify({
      name: form.slug,
      description: `${form.title} - FreeDocStore Zensical knowledge base`,
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

async function writeFiles(repo: string, files: RepoFile[]) {
  for (const file of files) {
    await writeGitHubFile(repo, file.path, file.content)
  }
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

async function readGitHubFile(repo: string, path: string, branch: string) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const res = await app.proxy.fetch(`api.github.com/repos/${repoApiPath(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`, {
    headers: githubHeaders(),
  })
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status} ${await res.text()}`)
  const json = await res.json()
  if (json.encoding !== 'base64' || typeof json.content !== 'string') throw new Error('GitHub path is not a text file.')
  return base64ToText(json.content)
}

function deployWorkflow(project: string, customDomain: string) {
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
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: python -m pip install zensical
      - run: python -m zensical build --strict
      - name: Ensure Cloudflare Pages project
        run: npx wrangler pages project create "${project}" --production-branch=main || true
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - name: Deploy to Cloudflare Pages
        run: npx wrangler pages deploy site --project-name="${project}" --branch=main
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
${domainStep}`
}

function ensureFallbackFiles(files: RepoFile[], form: PublishForm, workflow: string): RepoFile[] {
  let next = [...files]
  const siteUrl = liveTargetFor(form)
  next = upsertFile(next, '.github/workflows/deploy.yml', workflow)
  next = upsertFile(next, '.gitignore', 'site/\n.cache/\n.DS_Store\n')
  if (!next.some((file) => file.path === 'README.md')) {
    next.push({ path: 'README.md', content: `# ${form.title}\n\nFreeDocStore Zensical knowledge base.\n\nSource lives in \`docs/\` and builds with \`python -m zensical build --strict\`.\n` })
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
      content: `site_name = "${form.title.replace(/"/g, '\\"')}"\nsite_url = "${siteUrl}"\nrepo_url = "https://github.com/${form.owner}/${form.slug}"\ndocs_dir = "docs"\nsite_dir = "site"\n\n[nav]\nitems = [\n  { title = "Overview", path = "index.md" },\n  { title = "First Principles", path = "first-principles.md" },\n  { title = "Assessment Method", path = "assessment-method.md" },\n  { title = "Register", path = "register.md" },\n]\n`,
    })
  }
  if (!next.some((file) => file.path === 'docs/index.md')) {
    next.push({ path: 'docs/index.md', content: `# ${form.title}\n\n${form.prompt}\n` })
  }
  return next.sort((a, b) => a.path.localeCompare(b.path))
}

function validateKbFiles(files: RepoFile[]) {
  const paths = new Set(files.map((file) => file.path))
  const failures = [
    ['zensical.toml', !paths.has('zensical.toml')],
    ['docs/index.md', !paths.has('docs/index.md')],
    ['Markdown under docs/', !files.some((file) => file.path.startsWith('docs/') && file.path.endsWith('.md'))],
    ['no generated site output', files.some((file) => file.path.startsWith('site/') || file.path.endsWith('.html'))],
  ].filter(([, failed]) => failed)
  if (failures.length) throw new Error(`Generated files failed Zensical validation: ${failures.map(([name]) => name).join(', ')}`)
}

function validatePublishForm(form: PublishForm) {
  if (!form.title.trim()) throw new Error('Title is required.')
  if (!/^[a-z][a-z0-9-]{1,57}$/.test(form.slug)) throw new Error('Slug must be lowercase letters, numbers, and hyphens.')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(form.owner.trim())) throw new Error('GitHub owner must be a valid user or organization name.')
  if (form.customDomain && !isValidDomain(form.customDomain)) throw new Error('Custom domain must be a valid hostname.')
  if (!form.prompt.trim()) throw new Error('Prompt is required.')
}

function validateAi(settings: Settings) {
  if (!settings.openaiEndpoint.trim()) throw new Error('OpenAI endpoint is required.')
  if (!settings.model.trim()) throw new Error('Model is required.')
}

function validatePlatformAccess(user: unknown) {
  if (!user) throw new Error('Sign in to PAS before publishing or editing.')
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

function proxyTarget(url: string) {
  return url.replace(/^https?:\/\//, '')
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

function parseStoredJson<T>(value: string | null): T | null {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function readUserField(user: unknown, field: string) {
  if (!user || typeof user !== 'object') return ''
  const value = (user as Record<string, unknown>)[field]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 58)
}

function normalizeDomain(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '')
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

function githubEditUrl(form: EditForm) {
  const [owner, repo] = form.repo.split('/')
  const path = form.path.split('/').map(encodeURIComponent).join('/')
  return owner && repo ? `https://github.com/${owner}/${repo}/edit/${encodeURIComponent(form.branch || 'main')}/${path}` : 'https://github.com'
}

function buildLineDiff(before: string, after: string) {
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

function resetSteps(active: string, state: StepState) {
  return initialSteps.map((step) => ({ ...step, state: step.id === active ? state : 'idle' as StepState }))
}

function updateStep(id: string, state: StepState, detail: string) {
  return (prev: PublishStep[]) => prev.map((step) => (step.id === id ? { ...step, state, detail } : step))
}

function markCurrentError(current: PublishStep[]) {
  const busy = current.find((step) => step.state === 'busy')
  if (!busy) return current
  return current.map((step) => (step.id === busy.id ? { ...step, state: 'error' as StepState } : step))
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export default App
