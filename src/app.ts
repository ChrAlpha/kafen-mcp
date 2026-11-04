import type { Config } from './config'
import { AuthManager } from './auth'
import { CredentialStore } from './credentials'
import { DiscourseClient } from './discourse/client'
import { SiteInfo } from './discourse/site'
import { Forum } from './forum'
import { version } from './version'

/** Process-wide services shared by every MCP connection and the CLI. */
export interface App {
  config: Config
  auth: AuthManager
  client: DiscourseClient
  forum: Forum
}

export function createApp(config: Config): App {
  const auth = new AuthManager(config, new CredentialStore(config.configDir))
  const client = new DiscourseClient({
    baseUrl: config.baseUrl,
    auth: () => auth.credential(),
    userAgent: `kafen-mcp/${version} (+https://github.com/ChrAlpha/kafen-mcp)`,
  })
  auth.attach(client)
  return { config, auth, client, forum: new Forum(client, new SiteInfo(client)) }
}
