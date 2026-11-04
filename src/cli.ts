#!/usr/bin/env node
import type { App } from './app'
import process from 'node:process'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createApp } from './app'
import { loadConfig } from './config'
import { createServer } from './server'
import { version } from './version'

const HELP = `kafen-mcp ${version} — MCP server for reading the DocOfCard (卡粉) Discourse forum

Usage:
  kafen-mcp [serve]   Run the MCP server over stdio (default)
  kafen-mcp login     Authorize in a browser and store a read-only API key
  kafen-mcp status    Show which account the stored key belongs to
  kafen-mcp logout    Revoke the stored key on the forum and delete it locally

Environment:
  KAFEN_BASE_URL            Forum URL (default https://forum.docofcard.com)
  KAFEN_MCP_CONFIG_DIR      Credential directory (default $XDG_CONFIG_HOME/kafen-mcp)
  KAFEN_USER_API_KEY        Use this User API key instead of the credential store
  KAFEN_USER_API_CLIENT_ID  Client id that KAFEN_USER_API_KEY was issued to
`

const log = (message = '') => process.stderr.write(`${message}\n`)

async function login(app: App): Promise<number> {
  const status = await app.auth.status()
  if (status.state === 'authenticated' && status.source === 'store') {
    log(`Already logged in${status.username ? ` as @${status.username}` : ''}. Run \`kafen-mcp logout\` first to switch accounts.`)
    return 0
  }
  const authorization = await app.auth.startLogin()
  log(`Open this link in a browser where you are logged in to ${app.config.baseUrl}:`)
  log(`  ${authorization.verificationUriComplete}`)
  log(`Confirm the code ${authorization.userCode} and click Authorize.`)
  log('Waiting for approval…')
  await app.auth.waitForLogin(authorization.expiresAt.getTime() - Date.now() + 10_000)

  const after = await app.auth.status()
  if (after.state === 'authenticated') {
    log(`Logged in${after.username ? ` as @${after.username}` : ''}. Key saved to ${app.auth.store.path}`)
    return 0
  }
  log(`Login failed: ${after.state === 'unauthenticated' ? after.lastError ?? 'unknown error' : 'timed out'}`)
  return 1
}

async function status(app: App): Promise<number> {
  const current = await app.auth.status()
  if (current.state !== 'authenticated') {
    log(`Not logged in to ${app.config.baseUrl}. Run \`kafen-mcp login\`.`)
    return 1
  }
  const me = await app.forum.whoami()
  log(`Logged in to ${app.config.baseUrl} as @${me.username} (key from ${current.source === 'env' ? 'KAFEN_USER_API_KEY' : app.auth.store.path}).`)
  return 0
}

async function logout(app: App): Promise<number> {
  const { removed, revoked } = await app.auth.logout()
  if (!removed)
    log('No stored key to remove.')
  else
    log(revoked ? 'Key revoked on the forum and removed locally.' : 'Key removed locally (the forum did not accept the revocation; it may already be invalid).')
  return 0
}

async function main(argv: string[]): Promise<number | undefined> {
  const command = argv[0] ?? 'serve'
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP)
    return 0
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${version}\n`)
    return 0
  }

  const app = createApp(loadConfig())
  switch (command) {
    case 'serve':
      serveStdio(() => createServer(app), { onerror: error => log(`[kafen-mcp] ${error.message}`) })
      return undefined
    case 'login':
      return login(app)
    case 'status':
      return status(app)
    case 'logout':
      return logout(app)
    default:
      log(`Unknown command "${command}".\n`)
      log(HELP)
      return 2
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined)
      process.exitCode = code
  },
  (error: Error) => {
    log(`kafen-mcp: ${error.message}`)
    process.exitCode = 1
  },
)
