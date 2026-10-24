/** A client or agent key names its studio. `ws_default` is not a studio: older keys were stamped with it by mistake. */
export function workspaceFromKey(key: string): string | null {
  const match = /^mnd_(?:cl|ag)_(ws_(?:default|[a-z2-7]{20}))_/.exec(key.trim())
  const id = match?.[1]
  if (!id || id === 'ws_default') return null
  return id
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
      const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('workspace') : null
      if (q) {
        sessionStorage.setItem(WORKSPACE, q)
        return q
      }
      const stored = sessionStorage.getItem(WORKSPACE)
      if (stored) return stored
      if (typeof document !== 'undefined') {
        const match = document.cookie.match(/(?:^|;\s*)(?:mandate_workspace|mnd_workspace)=([^;]+)/)
        if (match && match[1]) return decodeURIComponent(match[1])
      }
      return null
    } catch {
      return null
    }
  },
  setWorkspace(id: string): void {
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
