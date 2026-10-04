const KEY = 'mandate.apiKey'

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
  },
}
