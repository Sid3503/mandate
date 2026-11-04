/**
 * PayPal's Transaction Search refuses a range longer than 31 days. A reconciliation that looks further back is
 * several of those windows, newest first, touching at the edges and never overlapping. 180 days is the furthest
 * this asks for: six windows, and no more.
 */

const DAY_MS = 86_400_000
/** The longest range PayPal's transaction report will answer. */
export const PAYPAL_WINDOW_MS = 31 * DAY_MS
/** The furthest back a reconciliation will look. */
export const RECONCILE_MAX_DAYS = 180

export type ActivityWindow = { start: Date; end: Date }

/** The windows to ask PayPal for, newest first, covering `days` back from `now` and no single window over 31 days. */
export function activityWindows(now: Date, days: number): ActivityWindow[] {
  const spanDays = Math.min(RECONCILE_MAX_DAYS, Math.max(1, Math.floor(days)))
  const earliest = now.getTime() - spanDays * DAY_MS
  const windows: ActivityWindow[] = []
  let end = now.getTime()
  while (end > earliest && windows.length < 8) {
    const start = Math.max(earliest, end - PAYPAL_WINDOW_MS)
    windows.push({ start: new Date(start), end: new Date(end) })
    if (start <= earliest) break
    end = start
  }
  return windows
}
