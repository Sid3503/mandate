/** A client or agent key names its studio. `ws_default` is not a studio: older keys were stamped with it by mistake. */
export function workspaceFromKey(key: string): string | null {
  const match = /^mnd_(?:cl|ag)_(ws_(?:default|[a-z2-7]{20}))_/.exec(key.trim())
  const id = match?.[1]
  if (!id || id === 'ws_default') return null
  return id
}

/** `ws_default`, or `ws_` and 20 lowercase base32 characters: the same shape the server's isWorkspaceId accepts. */
export function workspaceId(value: string | null | undefined): string | null {
  return value && (value === 'ws_default' || /^ws_[a-z2-7]{20}$/.test(value)) ? value : null
}

const KEY = 'mandate.apiKey'
const WORKSPACE = 'mandate.workspace'
const MODE = 'mandate.workspaceMode'

/** The API key lives only in this tab's session storage. It is never bundled or persisted to disk. */
export const session = {
  get(): string | null {
    try {
      const stored = sessionStorage.getItem(KEY)
      if (stored) return stored
      if (typeof document !== 'undefined') {
        const match = document.cookie.match(/(?:^|;\s*)(?:mandate_session|mnd_session)=([^;]+)/)
        if (match && match[1]) return decodeURIComponent(match[1])
      }
      return null
    } catch {
      return null
    }
  },
  set(value: string): void {
    sessionStorage.setItem(KEY, value)
  },
  clear(): void {
    sessionStorage.removeItem(KEY)
    sessionStorage.removeItem(WORKSPACE)
    sessionStorage.removeItem(MODE)
  },
  workspace(): string | null {
    try {
      // A workspace id becomes the /w/<id> prefix of every URL this page builds, so only the server's own shape is
      // accepted, wherever it came from (the address bar, this tab, a cookie). Anything else is as if none was given.
      const q = typeof window !== 'undefined' ? workspaceId(new URLSearchParams(window.location.search).get('workspace')) : null
      if (q) {
        sessionStorage.setItem(WORKSPACE, q)
        return q
      }
      const stored = workspaceId(sessionStorage.getItem(WORKSPACE))
      if (stored) return stored
      if (typeof document !== 'undefined') {
        const match = document.cookie.match(/(?:^|;\s*)(?:mandate_workspace|mnd_workspace)=([^;]+)/)
        if (match && match[1]) return workspaceId(decodeURIComponent(match[1]))
      }
      return null
    } catch {
      return null
    }
  },
  setWorkspace(id: string): void {
    if (!workspaceId(id)) return
    sessionStorage.setItem(WORKSPACE, id)
  },
  /** Drop the workspace this tab thinks it is in. The session cookie is left as it is. */
  clearWorkspace(): void {
    sessionStorage.removeItem(WORKSPACE)
    sessionStorage.removeItem(MODE)
  },
  mode(): string | null {
    try {
      return sessionStorage.getItem(MODE)
    } catch {
      return null
    }
  },
  setMode(mode: string): void {
    sessionStorage.setItem(MODE, mode)
  },
}
