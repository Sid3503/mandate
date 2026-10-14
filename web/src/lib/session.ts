const KEY = 'mandate.apiKey'
const WORKSPACE = 'mandate.workspace'
const MODE = 'mandate.workspaceMode'

/** The API key lives only in this tab's session storage. It is never bundled or persisted to disk. */
export const session = {
  get(): string | null {
    try {
      const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('key') : null
      if (q) {
        sessionStorage.setItem(KEY, q)
        return q
      }
      return sessionStorage.getItem(KEY)
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
      return sessionStorage.getItem(WORKSPACE)
    } catch {
      return null
    }
  },
  setWorkspace(id: string): void {
    sessionStorage.setItem(WORKSPACE, id)
  },
  mode(): string | null {
    try {
      const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('mode') : null
      if (q) {
        sessionStorage.setItem(MODE, q)
        return q
      }
      return sessionStorage.getItem(MODE)
    } catch {
      return null
    }
  },
  setMode(mode: string): void {
    sessionStorage.setItem(MODE, mode)
  },
}
