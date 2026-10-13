import { createHash } from 'node:crypto'
import type { Repo } from '../db/repo'

export function machineKeyHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Older rows stored a hash of the secret with the mnd_ag_ or mnd_cl_ prefix left off.
 * The first accepted use rewrites that hash to the whole key. A revoked row is rewritten too, so the refusal stays the same.
 */
export function acceptLegacyMachineKey(repo: Repo, token: string): void {
  if (token.length < 8) return
  const full = machineKeyHash(token)
  if (repo.getAgentByKeyHash(full) || repo.getClientKeyByKeyHash(full)) return
  if (token.startsWith('mnd_ag_')) {
    const row = repo.getAgentByKeyHash(machineKeyHash(token.slice('mnd_ag_'.length)))
    if (row) repo.setAgentKeyHash(row.id, full)
    return
  }
  if (token.startsWith('mnd_cl_')) {
    const row = repo.getClientKeyByKeyHash(machineKeyHash(token.slice('mnd_cl_'.length)))
    if (row) repo.setClientKeyHash(row.id, full)
  }
}
