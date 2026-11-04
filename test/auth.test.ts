import type { FetchLike } from '../src/discourse/client'
import { constants, publicEncrypt } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthManager } from '../src/auth'
import { loadConfig } from '../src/config'
import { CredentialStore } from '../src/credentials'
import { DiscourseClient } from '../src/discourse/client'

const BASE = 'https://forum.example.com'
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kafen-mcp-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function setup(env: Record<string, string> = {}, fetchImpl?: FetchLike) {
  const config = loadConfig({ KAFEN_BASE_URL: BASE, KAFEN_MCP_CONFIG_DIR: dir, ...env })
  const store = new CredentialStore(config.configDir)
  const auth = new AuthManager(config, store)
  const client = new DiscourseClient({
    baseUrl: BASE,
    auth: () => auth.credential(),
    userAgent: 'test',
    fetch: fetchImpl ?? (async () => Response.json({})),
    sleep: async () => {},
  })
  auth.attach(client)
  return { auth, store }
}

describe('credentialStore', () => {
  it('writes a private file and removes it with the last site', async () => {
    const { store } = setup()
    await store.set(BASE, { key: 'k', clientId: 'c', scopes: ['read'], createdAt: '2026-01-01T00:00:00Z' })
    expect((await stat(store.path)).mode & 0o777).toBe(0o600)
    expect(await store.get(BASE)).toMatchObject({ key: 'k' })
    expect(await store.delete(BASE)).toBe(true)
    await expect(stat(store.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('authManager', () => {
  it('prefers KAFEN_USER_API_KEY over the store', async () => {
    const { auth, store } = setup({ KAFEN_USER_API_KEY: 'env-key' })
    await store.set(BASE, { key: 'stored', clientId: 'c', scopes: ['read'], createdAt: '2026-01-01T00:00:00Z' })
    expect(await auth.credential()).toEqual({ key: 'env-key', clientId: 'kafen-mcp' })
    expect(await auth.status()).toEqual({ state: 'authenticated', source: 'env' })
  })

  it('ignores expired keys', async () => {
    const { auth, store } = setup()
    await store.set(BASE, { key: 'old', clientId: 'c', scopes: ['read'], createdAt: '2020-01-01T00:00:00Z', expiresAt: '2021-01-01T00:00:00Z' })
    expect(await auth.credential()).toBeUndefined()
    expect((await auth.status()).state).toBe('unauthenticated')
  })

  it('stores the key and username once the device login is approved', async () => {
    let publicKey = ''
    let nonce = ''
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.pathname === '/user-api-key/device.json') {
        ({ public_key: publicKey, nonce } = JSON.parse(String(init.body)))
        return Response.json({ device_code: 'd'.repeat(64), user_code: 'WXYZ-2345', verification_uri: `${BASE}/user-api-key/activate`, verification_uri_with_request: `${BASE}/user-api-key/activate?request=12345678`, expires_in: 600, interval: 0 })
      }
      if (url.pathname === '/user-api-key/device/poll.json') {
        const payload = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(JSON.stringify({ key: 'fresh', nonce, push: false, api: 4 })))
        return Response.json({ status: 'authorized', payload: payload.toString('base64') })
      }
      if (url.pathname === '/session/current.json') {
        expect(new Headers(init.headers).get('User-Api-Key')).toBe('fresh')
        return Response.json({ current_user: { id: 1, username: 'kafen' } })
      }
      throw new Error(`unexpected ${url.pathname}`)
    }
    const { auth, store } = setup({}, fetchImpl)

    const authorization = await auth.startLogin()
    expect(authorization.userCode).toBe('WXYZ-2345')
    expect(await auth.startLogin()).toBe(authorization)

    await auth.waitForLogin(5_000)
    expect(await auth.status()).toMatchObject({ state: 'authenticated', source: 'store', username: 'kafen' })
    expect(await store.get(BASE)).toMatchObject({ key: 'fresh', scopes: ['read'], username: 'kafen' })
  })
})
