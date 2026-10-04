function parts(date: Date, timeZone: string): Record<string, string> {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)
  return Object.fromEntries(formatted.map((part) => [part.type, part.value]))
}

function offsetMs(date: Date, timeZone: string): number {
  const part = parts(date, timeZone)
  const hour = part.hour === '24' ? 0 : Number(part.hour)
  const asUtc = Date.UTC(Number(part.year), Number(part.month) - 1, Number(part.day), hour, Number(part.minute), Number(part.second))
  return asUtc - date.getTime()
}

function zonedStart(year: number, monthIndex: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0))
  const corrected = new Date(guess.getTime() - offsetMs(guess, timeZone))
  return new Date(guess.getTime() - offsetMs(corrected, timeZone))
}

export function monthWindow(now: Date, timeZone: string): { start: string; end: string } {
  const part = parts(now, timeZone)
  const year = Number(part.year)
  const monthIndex = Number(part.month) - 1
  const start = zonedStart(year, monthIndex, timeZone)
  const end = zonedStart(monthIndex === 11 ? year + 1 : year, (monthIndex + 1) % 12, timeZone)
  return { start: start.toISOString(), end: end.toISOString() }
}
