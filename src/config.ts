import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export const DEFAULT_BASE_URL = 'https://forum.docofcard.com'

export interface Config {
  /** Forum origin without a trailing slash, e.g. `https://forum.docofcard.com`. */
  baseUrl: string
  /** Directory holding `credentials.json`. */
  configDir: string
  /** User API key supplied through the environment; takes precedence over the credential store. */
  envApiKey?: string
  envClientId?: string
}

function defaultConfigDir(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32' && env.APPDATA)
    return join(env.APPDATA, 'kafen-mcp')
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'kafen-mcp')
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`Unsupported forum URL protocol: ${url.protocol}`)
  return url.origin + url.pathname.replace(/\/+$/, '')
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    baseUrl: normalizeBaseUrl(env.KAFEN_BASE_URL || DEFAULT_BASE_URL),
    configDir: env.KAFEN_MCP_CONFIG_DIR || defaultConfigDir(env),
    envApiKey: env.KAFEN_USER_API_KEY || undefined,
    envClientId: env.KAFEN_USER_API_CLIENT_ID || undefined,
  }
}
