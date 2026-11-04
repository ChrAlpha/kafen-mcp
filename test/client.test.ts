import type { FetchLike } from '../src/discourse/client'
import { caught } from './helpers'
import { describe, expect, it, vi } from 'vitest'
import { AuthRequiredError, buildQuery, DiscourseClient, DiscourseError, NotFoundError, RateLimitedError } from '../src/discourse/client'

const BASE = 'https://forum.example.com'
const AUTH = { key: 'secret-key', clientId: 'client-1' }

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function makeClient(fetchImpl: FetchLike, options: { auth?: typeof AUTH, sleep?: (ms: number) => Promise<void>, now?: () => number } = {}) {
  return new DiscourseClient({
    baseUrl: BASE,
    auth: async () => ('auth' in options ? options.auth : AUTH),
    userAgent: 'test',
    fetch: fetchImpl,
    sleep: options.sleep ?? (async () => {}),
    now: options.now,
  })
}

describe('buildQuery', () => {
  it('encodes arrays with [] and skips undefined', () => {
    expect(buildQuery({ q: '招商 年费', page: 2, skip: undefined, post_ids: [1, 2] }))
      .toBe('?q=%E6%8B%9B%E5%95%86+%E5%B9%B4%E8%B4%B9&page=2&post_ids%5B%5D=1&post_ids%5B%5D=2')
  })
})

describe('discourseClient', () => {
  it('sends the user API key headers to the forum', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json(200, { ok: true }))
    await makeClient(fetchImpl).getJson('/latest.json')
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url.href).toBe(`${BASE}/latest.json`)
    const headers = new Headers(init.headers)
    expect(headers.get('User-Api-Key')).toBe('secret-key')
    expect(headers.get('User-Api-Client-Id')).toBe('client-1')
    expect(init.redirect).toBe('manual')
  })

  it('drops credentials when a redirect leaves the forum origin', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.origin === BASE)
        return new Response(null, { status: 302, headers: { location: 'https://s3.example.net/upload.png?sig=1' } })
      return new Response(new Uint8Array([0x89, 0x50, 0x4E, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const result = await makeClient(fetchImpl).fetchBinary(new URL(`${BASE}/uploads/short-url/x.png`), 1024)
    expect(result.bytes.byteLength).toBe(4)
    const external = new Headers(fetchImpl.mock.calls[1]![1].headers)
    expect(fetchImpl.mock.calls[1]![0].origin).toBe('https://s3.example.net')
    expect(external.get('Referer')).toBe(`${BASE}/`)
    expect(external.has('User-Api-Key')).toBe(false)
    expect(external.has('User-Api-Client-Id')).toBe(false)
  })

  it('treats a redirect to the login page as missing auth', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(null, { status: 302, headers: { location: '/login' } }))
    await expect(makeClient(fetchImpl).getJson('/latest.json')).rejects.toBeInstanceOf(AuthRequiredError)
  })

  it('classifies Discourse errors', async () => {
    const notLoggedIn = makeClient(async () => json(403, { errors: ['login'], error_type: 'not_logged_in' }), { auth: undefined })
    await expect(notLoggedIn.getJson('/x.json')).rejects.toBeInstanceOf(AuthRequiredError)

    const anonymousDenied = makeClient(async () => json(403, { errors: ['no'], error_type: 'invalid_access' }), { auth: undefined })
    await expect(anonymousDenied.getJson('/x.json')).rejects.toBeInstanceOf(AuthRequiredError)

    const keyDenied = makeClient(async () => json(403, { errors: ['no'], error_type: 'invalid_access' }))
    const error = await caught<DiscourseError>(keyDenied.getJson('/x.json'))
    expect(error).toBeInstanceOf(DiscourseError)
    expect(error).not.toBeInstanceOf(AuthRequiredError)
    expect(error.message).toMatch(/revoked/)

    const missing = makeClient(async () => json(404, { errors: ['gone'], error_type: 'not_found' }))
    await expect(missing.getJson('/t/1.json')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('retries once after a short 429 and surfaces long waits', async () => {
    const sleep = vi.fn(async () => {})
    let calls = 0
    const shortWait = makeClient(async () => (++calls === 1 ? json(429, { extras: { wait_seconds: 3 } }) : json(200, { ok: 1 })), { sleep })
    await expect(shortWait.getJson('/x.json')).resolves.toEqual({ ok: 1 })
    expect(sleep).toHaveBeenCalledWith(3000)

    const longWait = makeClient(async () => json(429, {}, { 'retry-after': '120' }), { sleep })
    const error = await caught<RateLimitedError>(longWait.getJson('/x.json'))
    expect(error).toBeInstanceOf(RateLimitedError)
    expect(error.waitSeconds).toBe(120)
  })

  it('throttles to the per-minute budget', async () => {
    let now = 0
    const sleeps: number[] = []
    const client = new DiscourseClient({
      baseUrl: BASE,
      auth: async () => AUTH,
      userAgent: 'test',
      fetch: async () => json(200, {}),
      maxRequestsPerMinute: 2,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms)
        now += ms
      },
    })
    await client.getJson('/a.json')
    now = 10_000
    await client.getJson('/b.json')
    await client.getJson('/c.json')
    expect(sleeps).toEqual([50_000])
  })
})
