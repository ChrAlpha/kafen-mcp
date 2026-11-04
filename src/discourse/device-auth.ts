import type { DiscourseClient } from './client'
import { constants, generateKeyPairSync, privateDecrypt, randomBytes } from 'node:crypto'

/**
 * Discourse User API Key device authorization (auth API v4).
 *
 * 1. POST /user-api-key/device.json with an RSA public key → device code + user code.
 * 2. The user approves in a browser at `verificationUriComplete`.
 * 3. Poll /user-api-key/device/poll.json until the server returns the key, RSA-encrypted
 *    to our public key. OAEP padding is requested because Node refuses PKCS#1 v1.5
 *    private decryption.
 */

export interface DeviceAuthRequest {
  clientId: string
  applicationName: string
  scopes: string[]
}

export interface DeviceAuthorization {
  userCode: string
  verificationUri: string
  /** Opens the approval page with the request pre-selected; the user still confirms the code. */
  verificationUriComplete: string
  expiresAt: Date
  intervalSeconds: number
}

export interface IssuedKey {
  key: string
  expiresAt?: string
}

export class DeviceAuthError extends Error {
  constructor(message: string, readonly reason: 'access_denied' | 'expired_token' | 'invalid_payload' | 'aborted') {
    super(message)
    this.name = 'DeviceAuthError'
  }
}

interface CreateResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_with_request: string
  expires_in: number
  interval: number
}

interface PollResponse {
  status: 'authorization_pending' | 'authorized' | 'access_denied' | 'expired_token'
  payload?: string
}

interface DecryptedPayload {
  key: string
  nonce: string
  api: number
  expires_at?: string
}

export interface PendingDeviceAuth {
  authorization: DeviceAuthorization
  /** Resolves with the issued key once the user approves; rejects with {@link DeviceAuthError}. */
  waitForKey: (signal?: AbortSignal) => Promise<IssuedKey>
}

export function decryptPayload(payloadBase64: string, privateKeyPem: string, expectedNonce: string): IssuedKey {
  let payload: DecryptedPayload
  try {
    const plain = privateDecrypt(
      { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
      Buffer.from(payloadBase64, 'base64'),
    )
    payload = JSON.parse(plain.toString('utf8')) as DecryptedPayload
  }
  catch (error) {
    throw new DeviceAuthError(`Could not decrypt the key payload: ${(error as Error).message}`, 'invalid_payload')
  }
  if (payload.nonce !== expectedNonce || typeof payload.key !== 'string' || !payload.key)
    throw new DeviceAuthError('Key payload failed nonce verification', 'invalid_payload')
  return { key: payload.key, expiresAt: payload.expires_at }
}

export async function startDeviceAuth(
  client: DiscourseClient,
  request: DeviceAuthRequest,
  // Unref'd so a login left pending does not keep an MCP server alive after its client disconnects.
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms).unref()),
): Promise<PendingDeviceAuth> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const nonce = randomBytes(16).toString('hex')

  const created = await client.postJson<CreateResponse>('/user-api-key/device.json', {
    client_id: request.clientId,
    application_name: request.applicationName,
    scopes: request.scopes.join(','),
    nonce,
    public_key: publicKey,
    padding: 'oaep',
  }, { authenticated: false })

  const authorization: DeviceAuthorization = {
    userCode: created.user_code,
    verificationUri: created.verification_uri,
    verificationUriComplete: created.verification_uri_with_request,
    expiresAt: new Date(Date.now() + created.expires_in * 1000),
    intervalSeconds: created.interval,
  }

  async function waitForKey(signal?: AbortSignal): Promise<IssuedKey> {
    for (;;) {
      if (signal?.aborted)
        throw new DeviceAuthError('Device authorization was cancelled', 'aborted')
      if (Date.now() >= authorization.expiresAt.getTime())
        throw new DeviceAuthError('The authorization request expired before it was approved', 'expired_token')

      await sleep(authorization.intervalSeconds * 1000)
      const poll = await client.postJson<PollResponse>(
        '/user-api-key/device/poll.json',
        { device_code: created.device_code },
        { authenticated: false },
      )
      switch (poll.status) {
        case 'authorization_pending':
          continue
        case 'authorized':
          if (!poll.payload)
            throw new DeviceAuthError('The forum authorized the request but returned no key', 'invalid_payload')
          return decryptPayload(poll.payload, privateKey, nonce)
        case 'access_denied':
          throw new DeviceAuthError('The authorization request was denied in the browser', 'access_denied')
        default:
          throw new DeviceAuthError('The authorization request expired or was already used', 'expired_token')
      }
    }
  }

  return { authorization, waitForKey }
}
