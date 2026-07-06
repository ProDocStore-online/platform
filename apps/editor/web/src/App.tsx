import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  BookOpen,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Github,
  Globe2,
  Home,
  KeyRound,
  LibraryBig,
  LayoutDashboard,
  Loader2,
  PenLine,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCircle,
  Wifi,
} from 'lucide-react'
import { pds as app, useAuth, useSubscription, useTheme, type SecretStatus, type Subscription, type User } from './lib/pds'
import {
  buildLineDiff,
  createRepo,
  generateEditProposal,
  generateKbFiles,
  githubEditUrl,
  liveTargetFor,
  markCurrentError,
  messageOf,
  normalizeDomain,
  parseStoredJson,
  proxyTarget,
  readGitHubFile,
  resetSteps,
  slugify,
  updateStep,
  validateAi,
  validateByok,
  validateKbFiles,
  validatePlatformAccess,
  validatePublishForm,
  writeFiles,
} from './lib/publishing'
import {
  ACTIVE_KB_KEY,
  CONFIG_KEY,
  KBS_KEY,
  PDS_MCP,
  cloneSteps,
  createKnowledgeBase,
  displayName,
  emptySettings,
  initialConnections,
  initialSteps,
  nextAvailableSlug,
  normalizeKnowledgeBase,
  normalizeSettings,
  nowIso,
  pathForRoute,
  pushRoute,
  routeFromLocation,
  starterEdit,
  starterPublish,
  toPublishForm,
} from './lib/editor-state'
import { EditPreview, Field, FilesPreview, PreviewTabs } from './components/previews'
import type {
  AppRoute,
  AuthProvider,
  ConnectionState,
  EditForm,
  KnowledgeBaseDraft,
  McpHealth,
  PlatformConnections,
  Proposal,
  PublishForm,
  PublishStep,
  Settings,
} from './types'

type PwaInstallPrompt = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const emptySecrets: SecretStatus = {
  openai: {
    configured: false,
    label: '',
  },
}

function App() {
  return <EditorApp />
}

function EditorApp() {
  const { user, loading: authLoading, signIn, signOut, deleteAccount } = useAuth()
  const { subscription, isPro, loading: subLoading, upgrade, manageBilling } = useSubscription()
  const { preference, setPreference } = useTheme()
  const [route, setRoute] = useState<AppRoute>(() => routeFromLocation())
  const [settings, setSettings] = useState<Settings>(emptySettings)
  const [secrets, setSecrets] = useState<SecretStatus>(emptySecrets)
  const [openAiKeyInput, setOpenAiKeyInput] = useState('')
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
  const [installPrompt, setInstallPrompt] = useState<PwaInstallPrompt | null>(null)
  const [pwaReady, setPwaReady] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const connectionCheckStarted = useRef(false)

  const activeKb = kbs.find((kb) => kb.id === activeKbId) ?? kbs[0] ?? createKnowledgeBase(starterPublish)
  const publishForm = toPublishForm(activeKb)
  const files = activeKb?.files ?? []
  const steps = activeKb?.steps ?? cloneSteps()
  const liveUrl = activeKb?.liveUrl ?? ''

  useEffect(() => {
    const syncRoute = () => {
      const next = routeFromLocation()
      if (window.location.hash) window.history.replaceState(null, '', pathForRoute(next))
      setRoute(next)
    }
    window.addEventListener('popstate', syncRoute)
    window.addEventListener('hashchange', syncRoute)
    syncRoute()
    return () => {
      window.removeEventListener('popstate', syncRoute)
      window.removeEventListener('hashchange', syncRoute)
    }
  }, [])

  function navigate(route: AppRoute) {
    setRoute(route)
    pushRoute(route)
  }

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as PwaInstallPrompt)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    let cancelled = false
    navigator.serviceWorker.ready.then(() => {
      if (!cancelled) setPwaReady(true)
    }).catch(() => {})
    navigator.serviceWorker.getRegistration().then((registration) => {
      if (!registration || cancelled) return
      if (registration.waiting) setUpdateAvailable(true)
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing
        if (!worker) return
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) setUpdateAvailable(true)
        })
      })
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  async function installApp() {
    if (!installPrompt) return
    await installPrompt.prompt()
    setInstallPrompt(null)
  }

  async function activateUpdate() {
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null
    registration?.waiting?.postMessage({ type: 'SKIP_WAITING' })
    window.location.reload()
  }

  useEffect(() => {
    const saved = parseStoredJson<Partial<Settings>>(localStorage.getItem('pds-editor-settings'))
    sessionStorage.removeItem('pds-editor-settings')
    if (saved) setSettings(normalizeSettings(saved))
    const savedKbs = parseStoredJson<unknown>(localStorage.getItem('pds-kb-drafts'))
    if (savedKbs) {
      const parsed = savedKbs
      if (Array.isArray(parsed) && parsed.length) {
        const normalized = parsed.map(normalizeKnowledgeBase)
        setKbs(normalized)
        const storedActive = localStorage.getItem('pds-active-kb')
        setActiveKbId(normalized.some((kb) => kb.id === storedActive) ? storedActive || normalized[0].id : normalized[0].id)
      }
    } else {
      const pub = parseStoredJson<Partial<PublishForm>>(localStorage.getItem('pds-publish-draft'))
      if (pub) {
        const legacy = createKnowledgeBase({ ...starterPublish, ...pub })
        setKbs([legacy])
        setActiveKbId(legacy.id)
      }
    }
    const edit = parseStoredJson<Partial<EditForm>>(localStorage.getItem('pds-edit-draft'))
    if (edit) setEditForm({ ...starterEdit, ...edit })
  }, [])

  useEffect(() => {
    if (!user) {
      setPlatformLoaded(false)
      setSecrets(emptySecrets)
      setOpenAiKeyInput('')
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
        if (savedSettings) setSettings(normalizeSettings(savedSettings))
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
    if (!user) return
    refreshSecrets().catch((error) => setStatus(`Could not load BYOK key status: ${messageOf(error)}`))
  }, [user])

  useEffect(() => {
    if (kbs[0] && (!activeKbId || !kbs.some((kb) => kb.id === activeKbId))) setActiveKbId(kbs[0].id)
  }, [activeKbId, kbs])

  useEffect(() => {
    localStorage.setItem('pds-editor-settings', JSON.stringify(normalizeSettings(settings)))
    if (user && platformLoaded) app.kv.set(CONFIG_KEY, normalizeSettings(settings)).catch((error) => setStatus(`Could not save platform settings: ${messageOf(error)}`))
  }, [platformLoaded, settings, user])

  useEffect(() => {
    localStorage.setItem('pds-kb-drafts', JSON.stringify(kbs))
    if (user && platformLoaded) app.kv.set(KBS_KEY, kbs).catch((error) => setStatus(`Could not save platform KBs: ${messageOf(error)}`))
  }, [kbs, platformLoaded, user])

  useEffect(() => {
    if (activeKbId) localStorage.setItem('pds-active-kb', activeKbId)
    if (user && platformLoaded && activeKbId) app.kv.set(ACTIVE_KB_KEY, activeKbId).catch(() => {})
  }, [activeKbId, platformLoaded, user])

  useEffect(() => {
    localStorage.setItem('pds-edit-draft', JSON.stringify(editForm))
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
    const changedGeneratedContract = JSON.stringify(form) !== JSON.stringify(toPublishForm(activeKb))
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
      companyName: '',
      knowledgeOwner: '',
      supportChannel: '',
      escalationPath: '',
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
    setKbSteps(kbId, resetSteps(initialSteps, 'plan', 'busy'))
    setKbPatch(kbId, { lastStatus: 'Generating files' })
    try {
      validatePublishForm(form)
      validatePlatformAccess(user)
      validateAi(settings)
      validateByok(secrets)
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
        validateByok(secrets)
        setKbSteps(kbId, resetSteps(initialSteps, 'plan', 'busy'))
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

      if (form.visibility === 'private') {
        setKbSteps(kbId, updateStep('secrets', 'busy', 'Installing repo-level deploy secrets'))
        await app.platform.installDeploySecrets(repo.full_name)
        setKbSteps(kbId, updateStep('secrets', 'ok', 'Repo-level deploy secrets installed'))
      } else {
        setKbSteps(kbId, updateStep('secrets', 'ok', 'Using public-org deploy secrets'))
      }

      setKbSteps(kbId, updateStep('files', 'busy', 'Writing files to main'))
      await writeFiles(repo.full_name, readyFiles)
      setKbSteps(kbId, updateStep('files', 'ok', `${readyFiles.length} files committed`))

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
      validateByok(secrets)
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
    dashboard: 'ProDocStore Console',
    publish: 'Publish a knowledge base',
    edit: 'Edit Markdown with AI',
    profile: 'Profile and connections',
  }[route]
  const pageCopy = {
    dashboard: 'See every knowledge base, prompt new drafts, and publish GitHub-backed Zensical books.',
    publish: 'Generate a GitHub-backed documentation repo, deploy it to Cloudflare Pages, and attach a custom domain.',
    edit: 'Load an existing Markdown file, ask for a replacement draft, and apply the change through GitHub.',
    profile: 'Manage your ProDocStore account, workspace, and publishing connections.',
  }[route]

  async function refreshSecrets() {
    const next = await app.secrets.get()
    setSecrets(next)
    setConnections((current) => ({
      ...current,
      openai: next.openai.configured ? current.openai : 'needs-setup',
      detail: next.openai.configured
        ? current.detail
        : 'OpenAI generation uses your BYOK key. Save it once in your ProDocStore account before prompting KBs.',
    }))
  }

  async function saveOpenAiKey() {
    const value = openAiKeyInput.trim()
    if (!value) {
      setStatus('Paste your OpenAI API key before saving.')
      return
    }
    setBusy(true)
    setStatus('Saving OpenAI BYOK key')
    try {
      const next = await app.secrets.setOpenAiKey(value)
      setSecrets(next)
      setOpenAiKeyInput('')
      setConnections((current) => ({ ...current, openai: 'unchecked', detail: 'OpenAI BYOK key saved. Check platform connections to verify it.' }))
      setStatus('OpenAI BYOK key saved')
    } catch (error) {
      setStatus(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  async function clearOpenAiKey() {
    setBusy(true)
    setStatus('Removing OpenAI BYOK key')
    try {
      const next = await app.secrets.clearOpenAiKey()
      setSecrets(next)
      setConnections((current) => ({ ...current, openai: 'needs-setup', detail: 'OpenAI BYOK key removed. Save a key before prompting KBs.' }))
      setStatus('OpenAI BYOK key removed')
    } catch (error) {
      setStatus(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  async function checkConnections() {
    setConnections({ ...initialConnections, github: 'checking', openai: secrets.openai.configured ? 'checking' : 'needs-setup', mcp: 'checking' })
    setStatus('Checking platform connections')
    try {
      validatePlatformAccess(user)
      const [platform, mcp] = await Promise.all([
        app.platform.status(),
        fetch('https://mcp.prodocstore.online/health').then((res) => res.ok ? res.json() as Promise<McpHealth> : null).catch(() => null),
      ])
      const githubReady = platform.github.oauthConfigured && platform.github.publishingTokenConfigured
      const cloudflareReady = platform.cloudflare.deploySecretsConfigured && platform.cloudflare.pagesApiReady && platform.cloudflare.accessApiReady
      const mcpReady = Boolean(mcp?.oauthConfigured && mcp.storageConfigured)
      let currentSecrets = secrets
      if (!currentSecrets.openai.configured) {
        currentSecrets = await app.secrets.get()
        setSecrets(currentSecrets)
      }
      const openai = currentSecrets.openai.configured
        ? await app.proxy.fetch(proxyTarget(settings.openaiEndpoint), {
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
        : null
      const openaiError = openai && !openai.ok ? await openai.text() : ''
      const detailParts = [
        githubReady ? `GitHub publishing is configured for ${platform.github.org}.` : 'GitHub publishing needs the platform OAuth app and publishing token.',
        openai?.ok ? 'OpenAI BYOK is valid.' : currentSecrets.openai.configured ? `OpenAI ${openai?.status ?? 'not checked'}${openaiError ? `: ${openaiError}` : ''}.` : 'OpenAI needs your BYOK key.',
        cloudflareReady
          ? 'Cloudflare Pages and Access APIs are ready.'
          : `Cloudflare needs setup${platform.cloudflare.accessError ? `: ${platform.cloudflare.accessError}` : platform.cloudflare.pagesError ? `: ${platform.cloudflare.pagesError}` : '.'}`,
        mcpReady ? 'MCP OAuth is configured.' : `MCP OAuth is not configured${mcp?.callbackUrl ? `; create its GitHub OAuth app with callback ${mcp.callbackUrl}.` : '.'}`,
      ]
      setConnections({
        github: githubReady ? 'ready' : 'needs-setup',
        openai: openai?.ok ? 'ready' : 'needs-setup',
        cloudflare: cloudflareReady ? 'ready' : 'needs-setup',
        mcp: mcpReady ? 'ready' : 'needs-setup',
        detail: detailParts.join(' '),
      })
      setStatus(githubReady && openai?.ok && cloudflareReady && mcpReady ? 'Platform connections ready' : 'Some platform connections need setup')
    } catch (error) {
      setConnections({ github: 'error', openai: secrets.openai.configured ? 'error' : 'needs-setup', cloudflare: 'error', mcp: 'error', detail: messageOf(error) })
      setStatus(messageOf(error))
    }
  }

  useEffect(() => {
    if (!user || !platformLoaded || connectionCheckStarted.current) return
    connectionCheckStarted.current = true
    checkConnections()
  }, [platformLoaded, user])

  if (authLoading) return <LoadingScreen />
  if (!user) return <SignedOutLanding signIn={signIn} />

  const content = route === 'dashboard' ? (
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
        <SettingsPanel
          settings={settings}
          setSettings={setSettings}
          secrets={secrets}
          connections={connections}
          onCheck={checkConnections}
          onOpenProfile={() => navigate('profile')}
          compact
        />
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
        <FilesPreview files={files} summary={generatedSummary} form={publishForm} />
      </section>
    </div>
  ) : route === 'edit' ? (
    <div className="workspace-grid">
      <section className="panel control-panel">
        <SettingsPanel
          settings={settings}
          setSettings={setSettings}
          secrets={secrets}
          connections={connections}
          onCheck={checkConnections}
          onOpenProfile={() => navigate('profile')}
          compact
        />
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
      settings={settings}
      setSettings={setSettings}
      secrets={secrets}
      openAiKeyInput={openAiKeyInput}
      setOpenAiKeyInput={setOpenAiKeyInput}
      onSaveOpenAiKey={saveOpenAiKey}
      onClearOpenAiKey={clearOpenAiKey}
      connections={connections}
      onCheck={checkConnections}
      kbs={kbs}
      user={user}
      signOut={signOut}
      deleteAccount={deleteAccount}
      subscription={subscription}
      isPro={isPro}
      subLoading={subLoading}
      upgrade={upgrade}
      manageBilling={manageBilling}
      themePreference={preference}
      setThemePreference={setPreference}
      installAvailable={!!installPrompt}
      pwaReady={pwaReady}
      updateAvailable={updateAvailable}
      onInstall={installApp}
      onUpdate={activateUpdate}
    />
  )

  return (
    <div className="app-frame">
      <StoreHeader
        route={route}
        navigate={navigate}
        user={user}
        signOut={signOut}
        pwaReady={pwaReady}
        updateAvailable={updateAvailable}
        onUpdate={activateUpdate}
      />
      <main className="app-shell">
        <header className="workspace-head">
          <div>
            <p className="eyebrow">ProDocStore workspace</p>
            <h1>{pageTitle}</h1>
            <p className="lede">{pageCopy}</p>
          </div>
          <div className="status-block" aria-live="polite">
            <span className={busy ? 'pulse-dot busy' : 'pulse-dot'} />
            <div>
              <strong>{busy ? 'Working' : 'Status'}</strong>
              <p>{status}</p>
              <small>Signed in as {displayName(user)}</small>
            </div>
          </div>
        </header>
        {content}
        <footer className="store-footer">
          ProDocStore publishes Markdown knowledge bases as Zensical books from GitHub repos.
        </footer>
      </main>
      <MobileTabBar route={route} navigate={navigate} />
    </div>
  )
}

function LoadingScreen() {
  return (
    <div className="auth-screen">
      <Loader2 className="spin" size={22} />
      <p>Checking session...</p>
    </div>
  )
}

function SignedOutLanding({ signIn }: { signIn: (provider?: AuthProvider) => void }) {
  return (
    <main className="auth-screen auth-landing">
      <div className="auth-card">
        <span className="brand-mark large">P</span>
        <p className="eyebrow">ProDocStore Console</p>
        <h1>Prompt and publish knowledge bases.</h1>
        <p className="lede">Sign in to see your KBs, prompt new Zensical Markdown books, publish them on Cloudflare Pages, and manage custom domains.</p>
        <div className="auth-actions">
          <button className="primary-action" type="button" onClick={() => signIn('google')}>
            <span className="provider-mark" aria-hidden="true">G</span>
            Continue with Google
          </button>
          <button className="secondary-action" type="button" onClick={() => signIn('github')}>
            <Github size={17} />
            Continue with GitHub
          </button>
          <a className="secondary-action as-link" href="https://prodocstore.online/" target="_blank" rel="noreferrer">
            <ExternalLink size={17} />
            Open ProDocStore
          </a>
        </div>
      </div>
    </main>
  )
}

function StoreHeader({
  route,
  navigate,
  user,
  signOut,
  pwaReady,
  updateAvailable,
  onUpdate,
}: {
  route: AppRoute
  navigate: (route: AppRoute) => void
  user: User
  signOut: () => void
  pwaReady: boolean
  updateAvailable: boolean
  onUpdate: () => void
}) {
  return (
    <header className="store-topbar">
      <div className="store-topbar-inner">
        <button className="brand-lockup" type="button" onClick={() => navigate('dashboard')} aria-label="ProDocStore dashboard">
          <span className="brand-mark">P</span>
          <span>
            <strong>ProDocStore</strong>
            <small>Console</small>
          </span>
        </button>
        <AppNav route={route} navigate={navigate} />
        <div className="account-strip">
          <span className={pwaReady ? 'pwa-chip ready' : 'pwa-chip'}>
            <Wifi size={14} />
            <span>{pwaReady ? 'Offline ready' : 'Web app'}</span>
          </span>
          {updateAvailable && (
            <button className="pwa-chip update" type="button" onClick={onUpdate}>
              <RefreshCw size={14} />
              <span>Update</span>
            </button>
          )}
          <button className="account-pill" type="button" onClick={() => navigate('profile')} aria-label="Open profile">
            {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span>{displayName(user).slice(0, 1).toUpperCase()}</span>}
            <strong>{displayName(user)}</strong>
          </button>
          <button className="text-action signout-action" type="button" onClick={signOut}>Sign out</button>
        </div>
      </div>
    </header>
  )
}

function AppNav({ route, navigate }: { route: AppRoute; navigate: (route: AppRoute) => void }) {
  return (
    <nav className="app-nav" aria-label="Console pages">
      <button className={route === 'dashboard' ? 'mode active' : 'mode'} onClick={() => navigate('dashboard')} type="button">
        <Home size={17} />
        Console
      </button>
      <button className={route === 'publish' ? 'mode active' : 'mode'} onClick={() => navigate('publish')} type="button">
        <LibraryBig size={17} />
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
      <a className="mode link-mode" href={PDS_MCP} target="_blank" rel="noreferrer">
        <ShieldCheck size={17} />
        MCP
      </a>
    </nav>
  )
}

function MobileTabBar({ route, navigate }: { route: AppRoute; navigate: (route: AppRoute) => void }) {
  const items: { route: AppRoute; label: string; icon: ReactNode }[] = [
    { route: 'dashboard', label: 'Console', icon: <LayoutDashboard size={18} /> },
    { route: 'publish', label: 'Publish', icon: <LibraryBig size={18} /> },
    { route: 'edit', label: 'Edit', icon: <PenLine size={18} /> },
    { route: 'profile', label: 'Profile', icon: <UserCircle size={18} /> },
  ]
  return (
    <nav className="mobile-tabbar" aria-label="Primary">
      {items.map((item) => (
        <button key={item.route} className={route === item.route ? 'mobile-tab active' : 'mobile-tab'} type="button" onClick={() => navigate(item.route)}>
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
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
              <p>Prompt, publish, and manage the KBs saved to your ProDocStore account.</p>
            </div>
          </div>
          <div className="metric-grid">
            <div><span>Drafts</span><strong>{kbs.length}</strong></div>
            <div><span>Published</span><strong>{published}</strong></div>
            <div><span>Selected</span><strong>{kbs.find((kb) => kb.id === activeId)?.slug ?? 'None'}</strong></div>
          </div>
          <div className="action-row">
            <button className="primary-action" type="button" onClick={onPublish}>
              <LibraryBig size={17} />
              Prompt a KB
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
            <p>{kbs.length} knowledge-base draft{kbs.length === 1 ? '' : 's'}</p>
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
        Console
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
  secrets,
  openAiKeyInput = '',
  setOpenAiKeyInput,
  onSaveOpenAiKey,
  onClearOpenAiKey,
  connections,
  onCheck,
  onOpenProfile,
  compact = false,
  manageKeys = false,
}: {
  settings: Settings
  setSettings: (s: Settings) => void
  secrets: SecretStatus
  openAiKeyInput?: string
  setOpenAiKeyInput?: (value: string) => void
  onSaveOpenAiKey?: () => void
  onClearOpenAiKey?: () => void
  connections: PlatformConnections
  onCheck: () => void
  onOpenProfile?: () => void
  compact?: boolean
  manageKeys?: boolean
}) {
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings({ ...settings, [key]: value })
  const connectedCount = [connections.github, connections.openai, connections.cloudflare, connections.mcp].filter((state) => state === 'ready').length
  const connectionTotal = 4
  const openAiKeyStatus = secrets.openai.configured ? `Saved as ${secrets.openai.label}` : 'No OpenAI key saved'
  return (
    <details className="section-block settings-details" open={!compact || connectedCount < connectionTotal}>
      <summary>
        <span className="summary-title">
          <KeyRound size={18} />
          <span>
            <strong>Platform connections</strong>
            <small>{connectedCount}/{connectionTotal} ready. API keys are managed from Profile.</small>
          </span>
        </span>
      </summary>
      <div className="connection-grid">
        <ConnectionBadge label="GitHub" state={connections.github} detail="Repository create/read/write through the platform proxy" />
        <ConnectionBadge label="OpenAI" state={connections.openai} detail="AI generation through your saved BYOK key" />
        <ConnectionBadge label="Cloudflare" state={connections.cloudflare} detail="Deploy credentials held by platform/org secrets" />
        <ConnectionBadge label="MCP" state={connections.mcp} detail="Claude/Codex remote MCP sign-in and KB draft tools" />
      </div>
      <p className="connection-detail">{connections.detail}</p>
      <div className="byok-strip">
        <div>
          <span>OpenAI API key</span>
          <strong>{openAiKeyStatus}</strong>
          <p>Encrypted in your ProDocStore account and used server-side for all KB generation and AI edits.</p>
        </div>
        {manageKeys && secrets.openai.configured && onClearOpenAiKey ? (
          <button className="secondary-action danger-action" type="button" onClick={onClearOpenAiKey}>
            Remove key
          </button>
        ) : !manageKeys && onOpenProfile ? (
          <button className="secondary-action" type="button" onClick={onOpenProfile}>
            <UserCircle size={17} />
            Manage in Profile
          </button>
        ) : null}
      </div>
      {manageKeys && (
        <div className="field-grid two">
          <Field label="OpenAI API key" value={openAiKeyInput} onChange={setOpenAiKeyInput ?? (() => {})} placeholder="sk-..." secret />
          <Field label="OpenAI endpoint" value={settings.openaiEndpoint} onChange={(v) => update('openaiEndpoint', v)} />
          <Field label="Model" value={settings.model} onChange={(v) => update('model', v)} />
        </div>
      )}
      {!manageKeys && (
        <div className="field-grid two">
          <Field label="OpenAI endpoint" value={settings.openaiEndpoint} onChange={(v) => update('openaiEndpoint', v)} />
          <Field label="Model" value={settings.model} onChange={(v) => update('model', v)} />
        </div>
      )}
      <div className="action-row compact-actions">
        {manageKeys && onSaveOpenAiKey && (
          <button className="primary-action" type="button" onClick={onSaveOpenAiKey} disabled={!openAiKeyInput.trim()}>
            <KeyRound size={17} />
            Save API key
          </button>
        )}
        <button className="secondary-action" type="button" onClick={onCheck}>
          <ShieldCheck size={17} />
          Check platform connections
        </button>
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
  settings,
  setSettings,
  secrets,
  openAiKeyInput,
  setOpenAiKeyInput,
  onSaveOpenAiKey,
  onClearOpenAiKey,
  connections,
  onCheck,
  kbs,
  user,
  signOut,
  deleteAccount,
  subscription,
  isPro,
  subLoading,
  upgrade,
  manageBilling,
  themePreference,
  setThemePreference,
  installAvailable,
  pwaReady,
  updateAvailable,
  onInstall,
  onUpdate,
}: {
  settings: Settings
  setSettings: (settings: Settings) => void
  secrets: SecretStatus
  openAiKeyInput: string
  setOpenAiKeyInput: (value: string) => void
  onSaveOpenAiKey: () => void
  onClearOpenAiKey: () => void
  connections: PlatformConnections
  onCheck: () => void
  kbs: KnowledgeBaseDraft[]
  user: User
  signOut: () => void
  deleteAccount: () => Promise<void>
  subscription: Subscription | null
  isPro: boolean
  subLoading: boolean
  upgrade: (priceId?: string) => Promise<void>
  manageBilling: () => Promise<void>
  themePreference: 'light' | 'dark' | 'system'
  setThemePreference: (preference: 'light' | 'dark' | 'system') => void
  installAvailable: boolean
  pwaReady: boolean
  updateAvailable: boolean
  onInstall: () => void
  onUpdate: () => void
}) {
  async function confirmDeleteAccount() {
    const first = window.confirm('Delete your ProDocStore account data across platform apps? This cannot be undone.')
    if (!first) return
    const second = window.confirm('Last confirmation: permanently delete this account?')
    if (!second) return
    await deleteAccount()
  }

  return (
    <div className="profile-grid">
      <section className="panel">
        <div className="section-block pds-profile-card">
          {user.avatarUrl ? (
            <img className="profile-avatar" src={user.avatarUrl} alt="" />
          ) : (
            <div className="avatar-mark">{displayName(user).slice(0, 1).toUpperCase()}</div>
          )}
          <div>
            <h2>{displayName(user)}</h2>
            <p>ProDocStore account</p>
            <small>Account ID: {user.id}</small>
          </div>
        </div>
        <div className="section-block">
          <div className="section-title">
            <UserCircle size={18} />
            <div>
              <h2>Account</h2>
              <p>Profile, billing, appearance, and account controls.</p>
            </div>
          </div>
          <div className="profile-action-stack">
            <div className="target-grid">
              <div>
                <span>Plan</span>
                <strong>{subLoading ? 'Checking' : isPro ? 'Pro' : 'Free'}</strong>
              </div>
              <div>
                <span>Status</span>
                <strong>{subscription?.status ?? (isPro ? 'active' : 'free')}</strong>
              </div>
            </div>
            <div className="inline-choice theme-choice" aria-label="Theme preference">
              {(['system', 'light', 'dark'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={themePreference === option ? 'choice active' : 'choice'}
                  onClick={() => setThemePreference(option)}
                >
                  {option[0].toUpperCase() + option.slice(1)}
                </button>
              ))}
            </div>
            <div className="action-row">
              {isPro ? (
                <button className="secondary-action" type="button" onClick={() => manageBilling()}>
                  Manage billing
                </button>
              ) : (
                <button className="secondary-action" type="button" onClick={() => upgrade()}>
                  Upgrade
                </button>
              )}
              <button className="secondary-action" type="button" onClick={signOut}>
                Sign out
              </button>
            </div>
            <button className="secondary-action danger-action full-action" type="button" onClick={confirmDeleteAccount}>
              Delete account
            </button>
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="section-block">
          <div className="section-title">
            <UserCircle size={18} />
            <div>
              <h2>ProDocStore workspace</h2>
              <p>Knowledge-base publishing data stored for this ProDocStore account.</p>
            </div>
          </div>
          <div className="metric-grid">
            <div><span>Drafts</span><strong>{kbs.length}</strong></div>
            <div><span>App</span><strong>ProDocStore</strong></div>
            <div><span>Engine</span><strong>Zensical</strong></div>
          </div>
        </div>
        <PwaPanel
          installAvailable={installAvailable}
          pwaReady={pwaReady}
          updateAvailable={updateAvailable}
          onInstall={onInstall}
          onUpdate={onUpdate}
        />
        <SettingsPanel
          settings={settings}
          setSettings={setSettings}
          secrets={secrets}
          openAiKeyInput={openAiKeyInput}
          setOpenAiKeyInput={setOpenAiKeyInput}
          onSaveOpenAiKey={onSaveOpenAiKey}
          onClearOpenAiKey={onClearOpenAiKey}
          connections={connections}
          onCheck={onCheck}
          manageKeys
        />
      </section>
    </div>
  )
}

function PwaPanel({
  installAvailable,
  pwaReady,
  updateAvailable,
  onInstall,
  onUpdate,
}: {
  installAvailable: boolean
  pwaReady: boolean
  updateAvailable: boolean
  onInstall: () => void
  onUpdate: () => void
}) {
  return (
    <div className="section-block">
      <div className="section-title">
        <Wifi size={18} />
        <div>
          <h2>Web app</h2>
          <p>Installable PWA shell, offline cache, and update status.</p>
        </div>
      </div>
      <div className="target-grid">
        <div>
          <span>Offline cache</span>
          <strong>{pwaReady ? 'Ready' : 'Preparing'}</strong>
        </div>
        <div>
          <span>Updates</span>
          <strong>{updateAvailable ? 'Available' : 'Current'}</strong>
        </div>
      </div>
      <div className="action-row">
        <button className="secondary-action" type="button" onClick={onInstall} disabled={!installAvailable}>
          Install app
        </button>
        <button className="secondary-action" type="button" onClick={onUpdate} disabled={!updateAvailable}>
          Apply update
        </button>
      </div>
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
      <div className="section-title split-title company-scope-title">
        <div>
          <h2>Company scope</h2>
          <p>These fields shape the generated governance, operations, and support docs.</p>
        </div>
      </div>
      <div className="field-grid two">
        <Field label="Company name" value={form.companyName} onChange={(v) => update('companyName', v)} placeholder="Acme Inc." />
        <Field label="Department" value={form.department} onChange={(v) => update('department', v)} placeholder="Operations" />
        <Field label="Audience" value={form.audience} onChange={(v) => update('audience', v)} placeholder="Internal staff, client admins" />
        <Field label="Knowledge owner" value={form.knowledgeOwner} onChange={(v) => update('knowledgeOwner', v)} placeholder="Ops Enablement" />
        <Field label="Review cadence" value={form.reviewCadence} onChange={(v) => update('reviewCadence', v)} placeholder="Quarterly" />
        <Field label="Compliance mode" value={form.complianceMode} onChange={(v) => update('complianceMode', v)} placeholder="SOC 2, ISO 27001, HIPAA, internal controls" />
        <Field label="Support channel" value={form.supportChannel} onChange={(v) => update('supportChannel', v)} placeholder="helpdesk@company.com or #kb-support" />
        <Field label="Escalation path" value={form.escalationPath} onChange={(v) => update('escalationPath', v)} placeholder="Manager, security, legal, HR" />
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
      {form.visibility === 'private' && (
        <div className="access-box">
          <div>
            <strong>Cloudflare Access</strong>
            <p>Private KBs are closed by default. Add allow rules here; ProDocStore protects the Pages URL before deployment and rolls back if it is public.</p>
          </div>
          <div className="field-grid two">
            <Field label="Staff email domain" value={form.accessEmailDomain} onChange={(v) => update('accessEmailDomain', normalizeDomain(v))} placeholder="company.com" />
            <Field label="Allowed emails" value={form.accessAllowedEmails} onChange={(v) => update('accessAllowedEmails', v)} placeholder="admin@company.com, ops@client.com" />
            <Field label="Client email domain" value={form.accessClientDomain} onChange={(v) => update('accessClientDomain', normalizeDomain(v))} placeholder="client.com" />
            <Field label="Office CIDRs" value={form.accessOfficeCidrs} onChange={(v) => update('accessOfficeCidrs', v)} placeholder="203.0.113.0/24" />
          </div>
          <label className="field access-rules-field">
            <span>Advanced Access rules JSON</span>
            <textarea
              value={form.accessRulesJson}
              onChange={(event) => update('accessRulesJson', event.target.value)}
              placeholder={'{"include":[{"github_organization":{"name":"org","identity_provider_id":"id"}}],"require":[],"exclude":[]}'}
              rows={5}
            />
          </label>
          {form.customDomain && (
            <p className="warning-note">Private custom-domain publishing is blocked until custom-domain Access provisioning is tested. Clear the custom domain or publish as public.</p>
          )}
        </div>
      )}
      <div className="action-row">
        <button className="secondary-action" type="button" onClick={onGenerate} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
          Generate files
        </button>
        <button className="primary-action" type="button" onClick={onPublish} disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <LibraryBig size={17} />}
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

export default App
