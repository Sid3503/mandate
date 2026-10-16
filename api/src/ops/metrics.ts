/** Process counters. No personal data: no keys, no emails, no paths. */
export class Metrics {
  requests = 0
  limited = 0
  streams = 0
  demos = 0

  record(status: number): void {
    this.requests += 1
    if (status === 429) this.limited += 1
  }

  snapshot(extra: Record<string, number> = {}): Record<string, number> {
    return { requests: this.requests, limited: this.limited, streams: this.streams, demos: this.demos, ...extra }
  }
}
