import type { CallToolResult } from '@modelcontextprotocol/client'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Drives the built server (`pnpm build` first) over stdio against a live forum.
 * Opt-in because it needs network access:
 *
 *   KAFEN_E2E=1 KAFEN_BASE_URL=https://meta.discourse.org pnpm test e2e
 *
 * Against a login-required forum such as DocOfCard, log in first and point
 * KAFEN_MCP_CONFIG_DIR at the credential directory.
 */
const enabled = Boolean(process.env.KAFEN_E2E)
const cli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url))

function textOf(result: CallToolResult): string {
  return result.content.map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n')
}

describe.runIf(enabled)('stdio server against a live forum', () => {
  let client: Client

  beforeAll(async () => {
    client = new Client({ name: 'kafen-mcp-e2e', version: '0.0.0' })
    const env = { ...getDefaultEnvironment() }
    for (const key of ['KAFEN_BASE_URL', 'KAFEN_MCP_CONFIG_DIR', 'KAFEN_USER_API_KEY', 'KAFEN_USER_API_CLIENT_ID']) {
      if (process.env[key])
        env[key] = process.env[key]!
    }
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli], env, stderr: 'inherit' }))
  })

  afterAll(async () => {
    await client?.close()
  })

  async function callRaw(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const result = await client.callTool({ name, arguments: args }) as CallToolResult
    const output = textOf(result)
    if (process.env.KAFEN_E2E_VERBOSE)
      console.log(`\n===== ${name} ${JSON.stringify(args)}\n${output}`)
    expect(result.isError, output).toBeFalsy()
    return result
  }

  async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    return textOf(await callRaw(name, args))
  }

  it('lists every tool', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'auth_status',
      'get_user',
      'list_categories',
      'list_notifications',
      'list_topics',
      'login',
      'read_topic',
      'search',
      'view_image',
    ])
  })

  it('browses, reads, searches and looks up users', async () => {
    const categories = await call('list_categories')
    expect(categories).toMatch(/\(id \d+\)/)

    const latest = await call('list_topics', { feed: 'latest' })
    const topicIds = [...latest.matchAll(/\(topic (\d+)\)/g)].map(match => Number(match[1]))
    expect(topicIds.length).toBeGreaterThan(0)

    const top = await call('list_topics', { feed: 'top', period: 'monthly' })
    expect(top).toContain('period: monthly')

    const topic = await call('read_topic', { topic: topicIds.at(-1), limit: 5 })
    expect(topic).toMatch(/^## #1 @/m)

    const author = topic.match(/^## #\d+ @([\w.-]+)/m)![1]!
    const user = await call('get_user', { username: author, recent: 3 })
    expect(user).toContain(`@${author}`)

    const search = await call('search', { query: 'order:latest in:first' })
    expect(search).toMatch(/\(topic \d+, post #\d+\)/)
  })

  it('pages through a long topic', async () => {
    const top = await call('list_topics', { feed: 'top', period: 'yearly' })
    const busiest = [...top.matchAll(/\(topic (\d+)\)[^\n]*\n[^\n]*\n\s+(\d+) replies/g)]
      .map(match => ({ id: Number(match[1]), replies: Number(match[2]) }))
      .sort((a, b) => b.replies - a.replies)[0]!
    const first = await call('read_topic', { topic: busiest.id, limit: 3 })
    const next = Number(first.match(/Continue with post_number=(\d+)/)?.[1])
    expect(next).toBeGreaterThan(1)
    const second = await call('read_topic', { topic: busiest.id, post_number: next, limit: 3 })
    expect(second).toMatch(new RegExp(`^## #${next} @`, 'm'))
  })

  it('filters topics by category, including categories routed by id', async () => {
    const categories = [...(await call('list_categories')).matchAll(/\*\*(.+?)\*\* `([^`]*)` \(id (\d+)\)/g)]
      .map(([, name, slugPath, id]) => ({ name: name!, slugPath: slugPath!, id: Number(id) }))
    const target = categories.find(category => category.slugPath.includes('-category')) ?? categories[0]!
    const listing = await call('list_topics', { category: String(target.id) })
    expect(listing).toContain(target.name)
  })

  it('returns an image referenced by a post', async () => {
    const latest = await call('list_topics', { feed: 'top', period: 'monthly' })
    const ids = [...latest.matchAll(/\(topic (\d+)\)/g)].map(match => Number(match[1])).slice(0, 10)
    let imageUrl: string | undefined
    for (const id of ids) {
      const topic = await call('read_topic', { topic: id, limit: 10 })
      imageUrl = topic.match(/!\[[^\]]*\]\(([^)\s]+\.(?:png|jpe?g|gif|webp))\)/i)?.[1]
      if (imageUrl)
        break
    }
    expect(imageUrl, 'no post image found among top topics').toBeDefined()
    const result = await callRaw('view_image', { url: imageUrl })
    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: expect.stringMatching(/^image\//) })
  })

  it('reports the signed-in account and its inbox', async (context) => {
    const status = await call('auth_status')
    if (!status.startsWith('Logged in'))
      return context.skip('not logged in to this forum')
    const username = status.match(/ as @(\S+) /)![1]!
    expect(await call('list_notifications', { limit: 5 })).toContain(`@${username}`)
    expect(await call('list_topics', { feed: 'new' })).toContain('# New topics')
  })
})
