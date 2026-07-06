import { useEffect, useState } from 'react'

export interface User {
  id: string
  provider: 'github' | 'google'
  login: string
  name: string
  avatarUrl: string
  githubUrl: string
  email?: string
}

export interface Subscription {
  status: string
}

export type ThemePreference = 'light' | 'dark' | 'system'

export interface SecretStatus {
  openai: {
    configured: boolean
    label: string
  }
}

export interface PlatformStatus {
  github: {
    oauthConfigured: boolean
    publishingTokenConfigured: boolean
    org: string
  }
  google: {
    oauthConfigured: boolean
  }
  openai: {
    byok: boolean
  }
  cloudflare: {
    deployConnection: string
    deploySecretsConfigured: boolean
    pagesApiReady: boolean
    accessApiReady: boolean
    pagesError: string
    accessError: string
  }
}

const API_BASE = (import.meta.env.VITE_PDS_API_BASE as string | undefined) || 'https://api.prodocstore.online'
const THEME_KEY = 'pds:theme:v1'

async function apiFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  })
  return res
}

async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init)
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

function applyTheme(preference: ThemePreference) {
  const dark = preference === 'dark' || (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  if (dark) document.documentElement.dataset.theme = 'dark'
  else delete document.documentElement.dataset.theme
}

export const pds = {
  apiBase: API_BASE,
  kv: {
    async get<T>(key: string): Promise<T | null> {
      const data = await apiJson<{ value: T | null }>(`/api/kv/${encodeURIComponent(key)}`)
      return data.value ?? null
    },
    async set<T>(key: string, value: T): Promise<void> {
      await apiJson(`/api/kv/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      })
    },
  },
  proxy: {
    fetch(target: string, init: RequestInit = {}) {
      return apiFetch(`/api/proxy?target=${encodeURIComponent(target)}`, init)
    },
  },
  secrets: {
    get(): Promise<SecretStatus> {
      return apiJson<SecretStatus>('/api/secrets')
    },
    async setOpenAiKey(value: string): Promise<SecretStatus> {
      const data = await apiJson<{ openai: SecretStatus['openai'] }>('/api/secrets/openai', {
        method: 'PUT',
        body: JSON.stringify({ value }),
      })
      return { openai: data.openai }
    },
    async clearOpenAiKey(): Promise<SecretStatus> {
      const data = await apiJson<{ openai: SecretStatus['openai'] }>('/api/secrets/openai', {
        method: 'DELETE',
      })
      return { openai: data.openai }
    },
  },
  platform: {
    status(): Promise<PlatformStatus> {
      return apiJson<PlatformStatus>('/api/platform/status')
    },
    installDeploySecrets(repo: string): Promise<{ ok: boolean; repo: string; secrets: Array<{ name: string; status: string }> }> {
      return apiJson('/api/github/deploy-secrets', {
        method: 'POST',
        body: JSON.stringify({ repo }),
      })
    },
  },
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  async function refresh() {
    setLoading(true)
    try {
      const data = await apiJson<{ authenticated: boolean; user: User | null }>('/api/me')
      setUser(data.authenticated ? data.user : null)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  function signIn(provider: 'github' | 'google' = 'github') {
    window.location.href = `${API_BASE}/auth/${provider}/start?next=${encodeURIComponent(window.location.href)}`
  }

  async function signOut() {
    await apiFetch('/api/logout', { method: 'POST' }).catch(() => {})
    setUser(null)
  }

  async function deleteAccount() {
    await apiFetch('/api/account', { method: 'DELETE' })
    setUser(null)
  }

  return { user, loading, signIn, signOut, deleteAccount, refresh }
}

export function useSubscription() {
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiJson<{ status: string }>('/api/billing')
      .then((data) => setSubscription({ status: data.status }))
      .catch(() => setSubscription({ status: 'trial' }))
      .finally(() => setLoading(false))
  }, [])

  return {
    subscription,
    isPro: subscription?.status === 'active' || subscription?.status === 'trial',
    loading,
    upgrade: async () => {
      window.alert('Paid ProDocStore plans are not enabled yet.')
    },
    manageBilling: async () => {
      window.alert('Billing management is not enabled yet.')
    },
  }
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    const stored = localStorage.getItem(THEME_KEY)
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
  })

  useEffect(() => {
    applyTheme(preference)
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(preference)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [preference])

  function setPreference(next: ThemePreference) {
    localStorage.setItem(THEME_KEY, next)
    setPreferenceState(next)
  }

  return { preference, setPreference }
}
