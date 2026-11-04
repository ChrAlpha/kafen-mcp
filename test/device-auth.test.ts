import type { FetchLike } from '../src/discourse/client'
import { constants, publicEncrypt } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DiscourseClient } from '../src/discourse/client'
import { DeviceAuthError, startDeviceAuth } from '../src/discourse/device-auth'
import { caught } from './helpers'

/** Simulates Discourse's device flow: pending once, then authorized with an OAEP-encrypted payload. */
function fakeForum(options: { nonceOverride?: string, finalStatus?: 'authorized' | 'access_denied' } = {}) {
  let publicKey = ''
  let nonce = ''
  let polls = 0
  const requests: Array<{ path: string, body: any }> = []
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body))
    requests.push({ path: url.pathname, body })
    if (url.pathname === '/user-api-key/device.json') {
      publicKey = body.public_key
      nonce = body.nonce
      return Response.json({
        device_code: 'a'.repeat(64),
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://forum.example.com/user-api-key/activate',
        verification_uri_with_request: 'https://forum.example.com/user-api-key/activate?request=abcdefgh',
        expires_in: 600,
        interval: 5,
      })
    }
    if (++polls === 1)
      return Response.json({ status: 'authorization_pending' })
    if (options.finalStatus === 'access_denied')
      return Response.json({ status: 'access_denied' })
    const payload = JSON.stringify({ key: 'issued-key', nonce: options.nonceOverride ?? nonce, push: false, api: 4 })
    const encrypted = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(payload))
    return Response.json({ status: 'authorized', payload: encrypted.toString('base64') })
  }
  const client = new DiscourseClient({ baseUrl: 'https://forum.example.com', auth: async () => undefined, userAgent: 'test', fetch: fetchImpl, sleep: async () => {} })
  return { client, requests }
}

const request = { clientId: 'kafen-mcp-test', applicationName: 'Test', scopes: ['read'] }
const noSleep = async () => {}

describe('startDeviceAuth', () => {
  it('requests a read-only key with OAEP padding and decrypts the approved payload', async () => {
    const { client, requests } = fakeForum()
    const flow = await startDeviceAuth(client, request, noSleep)
    expect(flow.authorization.userCode).toBe('ABCD-EFGH')
    expect(flow.authorization.verificationUriComplete).toContain('request=abcdefgh')
    await expect(flow.waitForKey()).resolves.toEqual({ key: 'issued-key', expiresAt: undefined })

    const create = requests[0]!.body
    expect(create).toMatchObject({ client_id: 'kafen-mcp-test', scopes: 'read', padding: 'oaep' })
    expect(create.public_key).toContain('BEGIN PUBLIC KEY')
    expect(requests.filter(r => r.path === '/user-api-key/device/poll.json')).toHaveLength(2)
  })

  it('rejects a payload whose nonce does not match', async () => {
    const { client } = fakeForum({ nonceOverride: 'forged' })
    const flow = await startDeviceAuth(client, request, noSleep)
    await expect(flow.waitForKey()).rejects.toMatchObject({ reason: 'invalid_payload' })
  })

  it('reports a denied request', async () => {
    const { client } = fakeForum({ finalStatus: 'access_denied' })
    const flow = await startDeviceAuth(client, request, noSleep)
    const error = await caught<DeviceAuthError>(flow.waitForKey())
    expect(error).toBeInstanceOf(DeviceAuthError)
    expect(error.reason).toBe('access_denied')
  })
})
