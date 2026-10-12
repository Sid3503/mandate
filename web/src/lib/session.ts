const KEY = 'mandate.apiKey'
const WORKSPACE = 'mandate.workspace'
const MODE = 'mandate.workspaceMode'

/** The API key lives only in this tab's session storage. It is never bundled or persisted to disk. */
export const session = {
  get(): string | null {
    try {
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
      return sessionStorage.getItem(MODE)
    } catch {
      return null
    }
  },
  setMode(mode: string): void {
    sessionStorage.setItem(MODE, mode)
  },
}
