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
