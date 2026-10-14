import { randomBytes, randomUUID } from 'node:crypto'
import type { ClientKeyRow, Repo } from '../db/repo'
import { live } from './live'
import { stamp } from './live'
import { Problem } from '../http/problem'
import { machineKeyHash } from './machine-key'

/**
 * The client-key registry: every client company gets its own key, bound to itself on the warrant. A client key is
 * what the `BUYER_AGENT_KEY` environment variable always was, except issued from the product instead of the shell:
 * it may make and read its own deal offers, read its own price sheet, and write its own ceiling — and it is bound
 * to one party, so it can never speak for the studio or for another client.
 *
 * Keys are shown once at creation; only the hash is stored. Rotating a key kills the old one and returns the new
 * one, in one step, so there is never a moment with two live keys or none.
 */
export class ClientKeyService {
  constructor(
    private readonly repo: Repo,
    private readonly now: () => Date,
    private readonly workspaceId: string = 'ws_default',
  ) {}

  issue(input: { name: string; partyId: string; expiryDays?: number | null }): { key: ClientKeySummary; apiKey: string } {
    const name = input.name.trim().slice(0, 120)
    if (!name) throw new Problem(422, 'client-key.name', 'The key needs a name', 'Give the key a name, such as “Northwind buyer agent”.')
    const partyId = input.partyId.trim()
    const warrant = this.repo.latestWarrant()
    const client = warrant?.body.clients.find((item) => item.id === partyId)
    if (!client) throw new Problem(404, 'client-key.party_unknown', 'No such client on the rules', 'A client key is bound to one client on the warrant. Add the client to the rules first.')
    if (input.expiryDays !== undefined && input.expiryDays !== null && input.expiryDays <= 0) {
      throw new Problem(400, 'client-key.expiry', 'expiryDays must be positive', 'Set a valid expiration period.')
    }
    const id = randomUUID()
    const secret = randomBytes(24).toString('base64url')
    const apiKey = `mnd_cl_${this.workspaceId}_${secret}`
    const keyPrefix = `mnd_cl_${this.workspaceId}_${secret.slice(0, 4)}...`
    const expiresAt = input.expiryDays ? new Date(this.now().getTime() + input.expiryDays * 86_400_000).toISOString() : null
    this.repo.createClientKey({
      id, name, party_id: partyId,
      status: 'active', key_hash: machineKeyHash(apiKey), key_prefix: keyPrefix, created_at: this.now().toISOString(), last_seen_at: null,
      expires_at: expiresAt,
    })
    live.publish({ type: 'changed', scope: 'agents', what: 'client-key.issued', at: stamp() })
    return { key: this.toSummary(this.repo.getClientKey(id)!), apiKey }
  }

  list(): ClientKeySummary[] {
    return this.repo.listClientKeys().map((r) => this.toSummary(r))
  }

  revoke(id: string): ClientKeySummary {
    const row = this.repo.getClientKey(id)
    if (!row) throw new Problem(404, 'client-key.unknown', 'No client key with that id', 'Check the client keys list for the id.')
    this.repo.setClientKeyStatus(id, 'revoked', this.now().toISOString())
    live.publish({ type: 'changed', scope: 'agents', what: 'client-key.revoked', at: stamp() })
    return this.toSummary(this.repo.getClientKey(id)!)
  }

  /** Replaces the secret on the same client key. The old mnd_cl_ key stops matching. The client binding stays. */
  upgrade(id: string): { key: ClientKeySummary; apiKey: string } {
    const row = this.repo.getClientKey(id)
    if (!row) throw new Problem(404, 'client-key.unknown', 'No client key with that id', 'Check the client keys list for the id.')
    if (row.status === 'revoked') throw new Problem(409, 'client-key.revoked', 'That key was revoked, not paused', 'Issue a new key if you want the access back.')
    const secret = randomBytes(24).toString('base64url')
    const apiKey = `mnd_cl_${this.workspaceId}_${secret}`
    const keyPrefix = `mnd_cl_${this.workspaceId}_${secret.slice(0, 4)}...`
    this.repo.setClientKeyHash(id, machineKeyHash(apiKey), keyPrefix)
    live.publish({ type: 'changed', scope: 'agents', what: 'client-key.upgraded', at: stamp() })
    return { key: this.toSummary(this.repo.getClientKey(id)!), apiKey }
  }

  rotate(id: string): { key: ClientKeySummary; apiKey: string } {
    const row = this.repo.getClientKey(id)
    if (!row) throw new Problem(404, 'client-key.unknown', 'No client key with that id', 'Check the client keys list for the id.')
    if (row.status === 'revoked') throw new Problem(409, 'client-key.revoked', 'That key was revoked, not paused', 'Issue a new key if you want the access back.')
    this.repo.setClientKeyStatus(id, 'revoked', this.now().toISOString())
    const issued = this.issue({ name: row.name, partyId: row.party_id })
    live.publish({ type: 'changed', scope: 'agents', what: 'client-key.rotated', at: stamp() })
    return issued
  }

  private toSummary(row: ClientKeyRow): ClientKeySummary {
    const keyPrefix = row.key_prefix ?? `mnd_cl_${this.workspaceId}_...`
    return {
      id: row.id,
      name: row.name,
      partyId: row.party_id,
      status: row.status as ClientKeySummary['status'],
      keyPrefix,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      lastUsedAt: row.last_seen_at,
      expiresAt: row.expires_at ?? null,
    }
  }
}

export type ClientKeySummary = {
  id: string
  name: string
  partyId: string
  status: 'active' | 'revoked'
  keyPrefix: string
  createdAt: string
  lastSeenAt: string | null
  lastUsedAt: string | null
  expiresAt: string | null
}

