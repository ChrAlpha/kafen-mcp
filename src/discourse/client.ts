export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>

export interface ClientAuth {
  key: string
  clientId: string
}

export type QueryValue = string | number | boolean | undefined | ReadonlyArray<string | number>
export type Query = Record<string, QueryValue>

export interface DiscourseClientOptions {
  baseUrl: string
  /** Resolved on every request so credentials written by another process are picked up. */
  auth: () => Promise<ClientAuth | undefined>
  userAgent: string
  fetch?: FetchLike
  /** Client-side budget; Discourse allows 50 User API requests per minute by default. */
  maxRequestsPerMinute?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export class DiscourseError extends Error {
  constructor(message: string, readonly status: number, readonly errorType?: string) {
    super(message)
    this.name = new.target.name
  }
}

/** The forum requires login and no usable credential was sent. */
export class AuthRequiredError extends DiscourseError {}
export class NotFoundError extends DiscourseError {}
export class RateLimitedError extends DiscourseError {
  constructor(message: string, readonly waitSeconds: number) {
    super(message, 429, 'rate_limit')
  }
}

const MAX_REDIRECTS = 5
/** A 429 asking us to wait longer than this is surfaced instead of silently blocking the tool call. */
const MAX_RETRY_WAIT_SECONDS = 20

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

class SlidingWindowLimiter {
  private readonly stamps: number[] = []

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.now()
      while (this.stamps.length > 0 && now - this.stamps[0]! >= this.windowMs)
        this.stamps.shift()
      if (this.stamps.length < this.limit) {
        this.stamps.push(now)
        return
      }
      await this.sleep(this.windowMs - (now - this.stamps[0]!))
    }
  }
}

export function buildQuery(query: Query | undefined): string {
  if (!query)
    return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined)
      continue
    if (Array.isArray(value)) {
      for (const item of value)
        params.append(`${key}[]`, String(item))
    }
    else {
      params.append(key, String(value))
    }
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

interface DiscourseErrorBody {
  errors?: string[]
  error_type?: string
  extras?: { wait_seconds?: number }
}

async function readErrorBody(response: Response): Promise<DiscourseErrorBody> {
  try {
    return await response.json() as DiscourseErrorBody
  }
  catch {
    return {}
  }
}

export class DiscourseClient {
  readonly baseUrl: string
  private readonly origin: string
  private readonly fetchImpl: FetchLike
  private readonly sleep: (ms: number) => Promise<void>
  private readonly limiter: SlidingWindowLimiter

  constructor(private readonly options: DiscourseClientOptions) {
    this.baseUrl = options.baseUrl
    this.origin = new URL(options.baseUrl).origin
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
    this.sleep = options.sleep ?? defaultSleep
    this.limiter = new SlidingWindowLimiter(
      options.maxRequestsPerMinute ?? 45,
      60_000,
      options.now ?? Date.now,
      this.sleep,
    )
  }

  /** Resolves a forum-relative path (or absolute URL) against the forum base URL. */
  resolveUrl(pathOrUrl: string): URL {
    return new URL(pathOrUrl, `${this.baseUrl}/`)
  }

  isForumUrl(url: URL): boolean {
    return url.origin === this.origin
  }

  async getJson<T>(path: string, query?: Query): Promise<T> {
    const response = await this.request(this.resolveUrl(`${path.replace(/^\//, '')}${buildQuery(query)}`), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    return await response.json() as T
  }

  async postJson<T>(path: string, body: unknown, options: { authenticated?: boolean } = {}): Promise<T> {
    const response = await this.request(this.resolveUrl(path.replace(/^\//, '')), {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, options.authenticated ?? true)
    return await response.json() as T
  }

  /**
   * Downloads a resource embedded in a post. Credentials are only attached while the URL stays on
   * the forum origin. The forum origin is sent as Referer, as a browser rendering the post would;
   * DocOfCard's uploads and image CDN reject requests without it.
   */
  async fetchBinary(url: URL, maxBytes: number): Promise<{ bytes: Uint8Array, contentType: string, url: URL }> {
    const response = await this.request(url, {
      method: 'GET',
      headers: { 'Accept': 'image/*,*/*;q=0.5', 'Referer': `${this.origin}/` },
    })
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > maxBytes)
      throw new DiscourseError(`Resource is ${declared} bytes, larger than the ${maxBytes} byte limit`, 413)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes)
      throw new DiscourseError(`Resource is ${bytes.byteLength} bytes, larger than the ${maxBytes} byte limit`, 413)
    return { bytes, contentType: response.headers.get('content-type') ?? 'application/octet-stream', url: new URL(response.url || url) }
  }

  private async request(url: URL, init: RequestInit, authenticated = true): Promise<Response> {
    const auth = authenticated ? await this.options.auth() : undefined
    let current = url
    let retried = false

    for (let redirects = 0; ; ) {
      const headers = new Headers(init.headers)
      headers.set('User-Agent', this.options.userAgent)
      const onForum = this.isForumUrl(current)
      if (auth && onForum) {
        headers.set('User-Api-Key', auth.key)
        headers.set('User-Api-Client-Id', auth.clientId)
      }

      if (onForum)
        await this.limiter.acquire()
      const response = await this.fetchImpl(current, { ...init, headers, redirect: 'manual' })

      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        await response.body?.cancel()
        const next = new URL(response.headers.get('location')!, current)
        if (this.isForumUrl(next) && /^\/(?:login|session\/sso)\b/.test(next.pathname))
          throw new AuthRequiredError('The forum redirected to its login page', 401, 'not_logged_in')
        if (++redirects > MAX_REDIRECTS)
          throw new DiscourseError(`Too many redirects fetching ${url.href}`, response.status)
        if (response.status === 303)
          init = { ...init, method: 'GET', body: undefined }
        current = next
        continue
      }

      if (response.status === 429) {
        const body = await readErrorBody(response)
        const wait = Number(response.headers.get('retry-after')) || body.extras?.wait_seconds || 5
        if (!retried && wait <= MAX_RETRY_WAIT_SECONDS) {
          retried = true
          await this.sleep(wait * 1000)
          continue
        }
        throw new RateLimitedError(`Rate limited by the forum; retry in ${wait}s`, wait)
      }

      if (!response.ok)
        throw await this.toError(response, Boolean(auth && onForum))
      return response
    }
  }

  private async toError(response: Response, sentKey: boolean): Promise<DiscourseError> {
    const body = await readErrorBody(response)
    const detail = body.errors?.join('; ') || response.statusText || 'request failed'
    const type = body.error_type
    if (response.status === 403 && (type === 'not_logged_in' || (!sentKey && type === 'invalid_access')))
      return new AuthRequiredError(`Login required: ${detail}`, 403, type)
    if (response.status === 404)
      return new NotFoundError(`Not found: ${detail}`, 404, type)
    if (response.status === 403 && sentKey)
      return new DiscourseError(`Access denied: ${detail}. If every request fails this way the API key may have been revoked — check auth_status.`, 403, type)
    return new DiscourseError(`HTTP ${response.status}: ${detail}`, response.status, type)
  }
}
