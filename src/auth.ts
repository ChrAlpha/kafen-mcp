import type { Config } from './config'
import type { Credential, CredentialStore } from './credentials'
import type { ClientAuth, DiscourseClient } from './discourse/client'
import type { DeviceAuthorization } from './discourse/device-auth'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { startDeviceAuth } from './discourse/device-auth'

/** `read` permits every GET request and nothing else, so the server can never post on the user's behalf. */
export const SCOPES = ['read']

export type AuthStatus
  = | { state: 'authenticated', source: 'env' | 'store', username?: string, expiresAt?: string }
    | { state: 'pending', authorization: DeviceAuthorization }
    | { state: 'unauthenticated', lastError?: string }

interface PendingLogin {
  authorization: DeviceAuthorization
  done: Promise<void>
}

interface CurrentSession {
  current_user?: { username: string }
}

export class AuthManager {
  private pending?: PendingLogin
  private lastError?: string
  private client!: DiscourseClient

  constructor(private readonly config: Config, readonly store: CredentialStore) {}

  /** Breaks the construction cycle: the client asks this manager for credentials. */
  attach(client: DiscourseClient): void {
    this.client = client
  }

  async credential(): Promise<ClientAuth | undefined> {
    if (this.config.envApiKey)
      return { key: this.config.envApiKey, clientId: this.config.envClientId ?? 'kafen-mcp' }
    const stored = await this.storedCredential()
    return stored && { key: stored.key, clientId: stored.clientId }
  }

  async status(): Promise<AuthStatus> {
    if (this.config.envApiKey)
      return { state: 'authenticated', source: 'env' }
    const stored = await this.storedCredential()
    if (stored)
      return { state: 'authenticated', source: 'store', username: stored.username, expiresAt: stored.expiresAt }
    if (this.pending)
      return { state: 'pending', authorization: this.pending.authorization }
    return { state: 'unauthenticated', lastError: this.lastError }
  }

  /**
   * Starts (or reuses) a device authorization and polls for approval in the
   * background. The key is persisted as soon as the user approves.
   */
  async startLogin(): Promise<DeviceAuthorization> {
    if (this.pending)
      return this.pending.authorization

    const clientId = `kafen-mcp-${randomUUID()}`
    const flow = await startDeviceAuth(this.client, {
      clientId,
      applicationName: `Kafen MCP (${hostname()})`.slice(0, 200),
      scopes: SCOPES,
    })
    this.lastError = undefined

    const done = (async () => {
      try {
        const issued = await flow.waitForKey()
        await this.store.set(this.config.baseUrl, {
          key: issued.key,
          clientId,
          scopes: SCOPES,
          createdAt: new Date().toISOString(),
          expiresAt: issued.expiresAt,
        })
        // The username is informational; a failed lookup must not undo a successful login.
        await this.recordUsername().catch(() => {})
      }
      catch (error) {
        this.lastError = (error as Error).message
      }
      finally {
        this.pending = undefined
      }
    })()

    this.pending = { authorization: flow.authorization, done }
    return flow.authorization
  }

  /** Waits up to `ms` for an in-flight login to finish. */
  async waitForLogin(ms: number): Promise<void> {
    const pending = this.pending
    if (!pending || ms <= 0)
      return
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      pending.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms)
      }),
    ])
    clearTimeout(timer)
  }

  /** Revokes the stored key on the forum (best effort) and removes it locally. */
  async logout(): Promise<{ removed: boolean, revoked: boolean }> {
    const stored = await this.store.get(this.config.baseUrl)
    if (!stored)
      return { removed: false, revoked: false }
    let revoked = false
    try {
      await this.client.postJson('/user-api-key/revoke', {})
      revoked = true
    }
    catch {
      // A key that is already revoked or expired cannot be revoked again; local removal still matters.
    }
    await this.store.delete(this.config.baseUrl)
    return { removed: true, revoked }
  }

  private async recordUsername(): Promise<void> {
    const session = await this.client.getJson<CurrentSession>('/session/current.json')
    const stored = await this.store.get(this.config.baseUrl)
    if (stored && session.current_user)
      await this.store.set(this.config.baseUrl, { ...stored, username: session.current_user.username })
  }

  private async storedCredential(): Promise<Credential | undefined> {
    const stored = await this.store.get(this.config.baseUrl)
    if (stored?.expiresAt && Date.parse(stored.expiresAt) <= Date.now())
      return undefined
    return stored
  }
}
