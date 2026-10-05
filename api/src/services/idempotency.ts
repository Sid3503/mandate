import type { Repo } from '../db/repo'
import { Problem } from '../http/problem'

export type Stored = { status: number; body: unknown }

/**
 * Runs `fn` at most once per Idempotency-Key, atomically with the write it makes.
 * The same key with the same request replays the stored answer. The same key with a different request is refused.
 * A key whose first request is still running is refused rather than run twice.
 */
export function runIdempotent(repo: Repo, key: string, requestHash: string, now: string, fn: () => Stored): Stored {
  return repo.transaction(() => {
    const existing = repo.idempotency(key)
    if (existing?.state === 'done') {
      if (existing.request_hash !== requestHash) {
        throw new Problem(422, 'idempotency.mismatch', 'Idempotency-Key is already used', 'This key was stored for a different request body.')
      }
      return { status: existing.status_code ?? 200, body: JSON.parse(existing.response_json ?? '{}') as unknown }
    }
    if (existing?.state === 'pending') {
      throw new Problem(409, 'idempotency.inflight', 'A request is outstanding for this Idempotency-Key', 'Retry after the original request finishes.')
    }
    repo.insertIdempotency(key, requestHash, now)
    const result = fn()
    repo.finishIdempotency(key, result.status, result.body, now)
    return result
  })
}
