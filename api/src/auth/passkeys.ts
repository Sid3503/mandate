import { createHash, randomUUID } from 'node:crypto'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type { AuthenticationResponseJSON, RegistrationResponseJSON, WebAuthnCredential } from '@simplewebauthn/server'
import type { ControlStore } from '../control/store'

export type WebAuthnConfig = { rpID: string; rpName: string; origins: string[] }

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function credentialFingerprint(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 16)
}

/** Binding for the grant that turns the workspace passkey rule on or off. */
export function passkeyRuleBinding(enabled: boolean): string {
  return createHash('sha256').update(`mandate/passkey-rule/v1\n${enabled ? 'on' : 'off'}`).digest('hex')
}

export async function beginRegistration(input: { config: WebAuthnConfig; store: ControlStore; memberId: string; memberName: string; workspaceId: string; now: Date }): Promise<{ challengeId: string; options: unknown }> {
  const existing = input.store.credentials(input.memberId).filter((row) => !row.revoked_at)
  const options = await generateRegistrationOptions({
    rpName: input.config.rpName,
    rpID: input.config.rpID,
    userName: input.memberName,
    userID: Buffer.from(input.memberId),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: [-7, -257],
    excludeCredentials: existing.map((row) => ({ id: row.credential_id })),
  })
  const challengeId = randomUUID()
  input.store.putChallenge({
    id: challengeId,
    purpose: 'register',
    challenge: options.challenge,
    expiresAt: new Date(input.now.getTime() + 5 * 60_000).toISOString(),
    memberId: input.memberId,
    workspaceId: input.workspaceId,
  })
  return { challengeId, options }
}

export async function finishRegistration(input: { config: WebAuthnConfig; store: ControlStore; challengeId: string; response: RegistrationResponseJSON; now: Date }): Promise<{ credentialId: string; fingerprint: string; backupEligible: boolean; backupState: boolean }> {
  const row = input.store.takeChallenge(input.challengeId, input.now.toISOString())
  if (!row || row.purpose !== 'register' || !row.member_id) throw new Error('challenge')
  const verified = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: row.challenge,
    expectedOrigin: input.config.origins,
    expectedRPID: input.config.rpID,
    requireUserVerification: true,
  })
  if (!verified.verified) throw new Error('verify')
  const credential = verified.registrationInfo.credential
  const fingerprint = credentialFingerprint(credential.publicKey)
  input.store.saveCredential({
    id: randomUUID(),
    memberId: row.member_id,
    credentialId: credential.id,
    publicKey: b64(credential.publicKey),
    alg: -7,
    counter: credential.counter,
    fingerprint,
    backupEligible: verified.registrationInfo.credentialDeviceType === 'multiDevice',
    backupState: verified.registrationInfo.credentialBackedUp,
    now: input.now.toISOString(),
  })
  return { credentialId: credential.id, fingerprint, backupEligible: verified.registrationInfo.credentialDeviceType === 'multiDevice', backupState: verified.registrationInfo.credentialBackedUp }
}

export async function beginLogin(input: { config: WebAuthnConfig; store: ControlStore; now: Date }): Promise<{ challengeId: string; options: unknown }> {
  const options = await generateAuthenticationOptions({
    rpID: input.config.rpID,
    userVerification: 'required',
  })
  const challengeId = randomUUID()
  input.store.putChallenge({
    id: challengeId,
    purpose: 'login',
    challenge: options.challenge,
    expiresAt: new Date(input.now.getTime() + 5 * 60_000).toISOString(),
  })
  return { challengeId, options }
}

/** A counter that moves backwards is always refused. The last remaining passkey is kept and marked suspect. */
export function applyCounterRollback(store: ControlStore, credentialId: string, memberId: string, now: string, workspaceId?: string | null): 'revoked' | 'suspect' {
  const others = store.credentials(memberId).filter((row) => !row.revoked_at && row.credential_id !== credentialId)
  if (others.length > 0) {
    store.forceRevokeCredential(credentialId, now)
    store.event({ id: randomUUID(), at: now, workspaceId, memberId, event: 'passkey.counter', result: 'revoked', detail: credentialId })
    return 'revoked'
  }
  store.markSuspect(credentialId, now)
  store.event({ id: randomUUID(), at: now, workspaceId, memberId, event: 'passkey.counter', result: 'suspect', detail: credentialId })
  return 'suspect'
}

function counterRolledBack(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return message.toLowerCase().includes('counter')
}

export async function finishLogin(input: { config: WebAuthnConfig; store: ControlStore; challengeId: string; response: AuthenticationResponseJSON; now: Date }): Promise<{ memberId: string; credentialId: string }> {
  const row = input.store.takeChallenge(input.challengeId, input.now.toISOString())
  if (!row || row.purpose !== 'login') throw new Error('challenge')
  const stored = input.store.credential(input.response.id)
  if (!stored || stored.revoked_at) throw new Error('credential')
  const credential: WebAuthnCredential = {
    id: stored.credential_id,
    publicKey: Buffer.from(stored.public_key, 'base64url'),
    counter: stored.counter,
  }
  try {
    const verified = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: row.challenge,
      expectedOrigin: input.config.origins,
      expectedRPID: input.config.rpID,
      credential,
      requireUserVerification: true,
    })
    if (!verified.verified) throw new Error('verify')
    input.store.setCounter(stored.credential_id, verified.authenticationInfo.newCounter, input.now.toISOString())
    return { memberId: stored.member_id, credentialId: stored.credential_id }
  } catch (error) {
    if (counterRolledBack(error)) {
      applyCounterRollback(input.store, stored.credential_id, stored.member_id, input.now.toISOString())
    }
    throw error
  }
}
