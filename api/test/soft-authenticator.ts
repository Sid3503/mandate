import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'

/**
 * A P-256 authenticator that speaks the JSON WebAuthn messages the server verifies.
 * It exists so tests can register and sign in without a browser.
 */
export class SoftAuthenticator {
  private counter = 0
  readonly id = randomBytes(16).toString('base64url')
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

  constructor(private readonly origin: string, private readonly rpID: string) {}

  private cose(): Uint8Array {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    const map = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ])
    return isoCBOR.encode(map)
  }

  private authData(attested: boolean): Buffer {
    const rpHash = createHash('sha256').update(this.rpID).digest()
    const flags = attested ? 0x45 : 0x05
    const count = Buffer.alloc(4)
    count.writeUInt32BE(this.counter)
    if (!attested) return Buffer.concat([rpHash, Buffer.from([flags]), count])
    const cose = this.cose()
    const id = Buffer.from(this.id, 'base64url')
    const len = Buffer.alloc(2)
    len.writeUInt16BE(id.length)
    return Buffer.concat([rpHash, Buffer.from([flags]), count, Buffer.alloc(16), len, id, Buffer.from(cose)])
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string): string {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false })).toString('base64url')
  }

  private signature(authData: Buffer, clientDataJSON: string): string {
    const hash = createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest()
    return sign('sha256', Buffer.concat([authData, hash]), this.keys.privateKey).toString('base64url')
  }

  register(challenge: string): RegistrationResponseJSON {
    const clientDataJSON = this.clientData('webauthn.create', challenge)
    const authData = this.authData(true)
    const attestation = new Map<string, unknown>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ])
    const attestationObject = Buffer.from(isoCBOR.encode(attestation as never)).toString('base64url')
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON, attestationObject, transports: ['internal'] },
    }
  }

  authenticate(challenge: string): AuthenticationResponseJSON {
    this.counter += 1
    const clientDataJSON = this.clientData('webauthn.get', challenge)
    const authData = this.authData(false)
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON,
        authenticatorData: authData.toString('base64url'),
        signature: this.signature(authData, clientDataJSON),
      },
    }
  }
}
