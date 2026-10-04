export function shortId(id: string | null | undefined, size = 8): string {
  if (!id) return '—'
  return id.length > size * 2 ? `${id.slice(0, size)}…${id.slice(-size)}` : id
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function relative(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return when(iso)
}

export function newKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}
