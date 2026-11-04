import type { DiscourseClient } from './discourse/client'
import type { SiteInfo } from './discourse/site'
import type {
  CurrentUserResponse,
  NotificationsResponse,
  Post,
  PostsResponse,
  SearchResponse,
  TagRef,
  TopicListResponse,
  TopicResponse,
  UserActionsResponse,
  UserResponse,
  UserSummaryResponse,
} from './discourse/types'
import { parseTopicRef, topicUrl } from './discourse/refs'
import { createHtmlConverter, createTextConverter } from './format/html'

export const TOPIC_FEEDS = ['latest', 'new', 'unread', 'top', 'hot'] as const
export const TOP_PERIODS = ['all', 'yearly', 'quarterly', 'monthly', 'weekly', 'daily'] as const
export const LATEST_ORDERS = ['activity', 'created', 'views', 'posts', 'likes', 'op_likes'] as const

export type TopicFeed = typeof TOPIC_FEEDS[number]

export interface ListTopicsInput {
  feed: TopicFeed
  category?: string
  tag?: string
  period?: typeof TOP_PERIODS[number]
  order?: typeof LATEST_ORDERS[number]
  ascending?: boolean
  page?: number
}

export interface ReadTopicInput {
  topic: string | number
  postNumber?: number
  limit: number
}

export interface ImageResult {
  data: string
  mimeType: string
  url: string
}

const POSTS_BATCH = 20
const USER_ACTION_TOPIC = 4
const USER_ACTION_REPLY = 5
const POST_TYPE_SMALL_ACTION = 3
const POST_TYPE_WHISPER = 4
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const IMAGE_SIGNATURES: Array<[string, (b: Uint8Array) => boolean]> = [
  ['image/png', b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47],
  ['image/jpeg', b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF],
  ['image/gif', b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46],
  ['image/webp', b => b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50],
]

/** `2026-11-03T06:22:41.123Z` → `2026-11-03 06:22Z`. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso)
    return 'unknown'
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`
}

function tagNames(tags: TagRef[] | undefined): string[] {
  return (tags ?? []).map(tag => (typeof tag === 'string' ? tag : tag.name))
}

function joinNonEmpty(parts: Array<string | false | 0 | undefined | null>, separator = ' · '): string {
  return parts.filter(Boolean).join(separator)
}

function indent(text: string, prefix = '   '): string {
  return text.split('\n').map(line => (line ? prefix + line : line)).join('\n')
}

export class Forum {
  private readonly toMarkdown: (html: string) => string
  private readonly toText: (html: string) => string

  constructor(private readonly client: DiscourseClient, private readonly site: SiteInfo) {
    this.toMarkdown = createHtmlConverter(client.baseUrl)
    this.toText = createTextConverter()
  }

  async whoami(): Promise<CurrentUserResponse['current_user']> {
    return (await this.client.getJson<CurrentUserResponse>('/session/current.json')).current_user
  }

  async listCategories(): Promise<string> {
    const { categories } = await this.site.get()
    const children = new Map<number | undefined, typeof categories>()
    for (const category of categories) {
      const parent = category.parent_category_id ?? undefined
      children.set(parent, [...(children.get(parent) ?? []), category])
    }

    const lines: string[] = [`# Categories on ${this.client.baseUrl}`, '']
    const walk = async (parent: number | undefined, depth: number): Promise<void> => {
      for (const category of children.get(parent) ?? []) {
        const pad = '  '.repeat(depth)
        const stats = category.topic_count !== undefined ? ` — ${category.topic_count} topics` : ''
        lines.push(`${pad}- **${category.name}** \`${await this.site.categorySlugPath(category)}\` (id ${category.id})${stats}${category.read_restricted ? ' · restricted' : ''}`)
        const description = category.description_text?.replace(/\s+/g, ' ').trim()
        if (description)
          lines.push(`${pad}  ${description}`)
        await walk(category.id, depth + 1)
      }
    }
    await walk(undefined, 0)
    lines.push('', 'Pass a slug path (e.g. `parent/child`) or id as `category` to list_topics, or use `#slug` in search.')
    return lines.join('\n')
  }

  async listTopics(input: ListTopicsInput): Promise<string> {
    const { feed, tag } = input
    const category = input.category ? await this.site.resolveCategory(input.category) : undefined
    const categoryPath = category && `${await this.site.categorySlugPath(category)}/${category.id}`
    const encodedTag = tag && encodeURIComponent(tag.replace(/^#/, ''))

    let path: string
    if (categoryPath && encodedTag)
      path = `/tags/c/${categoryPath}/${encodedTag}/l/${feed}.json`
    else if (categoryPath)
      path = `/c/${categoryPath}/l/${feed}.json`
    else if (encodedTag)
      path = `/tag/${encodedTag}/l/${feed}.json`
    else
      path = `/${feed}.json`

    const page = input.page ?? 0
    const response = await this.client.getJson<TopicListResponse>(path, {
      page: page || undefined,
      period: feed === 'top' ? (input.period ?? 'weekly') : undefined,
      order: feed === 'latest' && input.order && input.order !== 'activity' ? input.order : undefined,
      ascending: feed === 'latest' && input.ascending ? true : undefined,
    })

    const users = new Map((response.users ?? []).map(user => [user.id, user.username]))
    const scope = joinNonEmpty([
      category && await this.site.categoryLabel(category.id),
      tag && `#${tag.replace(/^#/, '')}`,
      feed === 'top' && `period: ${input.period ?? 'weekly'}`,
    ])
    const topics = response.topic_list.topics
    const lines = [`# ${feed[0]!.toUpperCase()}${feed.slice(1)} topics${scope ? ` — ${scope}` : ''} (page ${page})`, '']
    if (topics.length === 0)
      lines.push('No topics.')

    for (const [index, topic] of topics.entries()) {
      const op = topic.posters?.find(poster => poster.description?.includes('Original Poster'))
      const flags = joinNonEmpty([
        topic.pinned && 'pinned',
        topic.closed && 'closed',
        topic.archived && 'archived',
        topic.has_accepted_answer && 'solved',
        topic.unseen && 'new',
        topic.unread_posts && `${topic.unread_posts} unread`,
        topic.new_posts && `${topic.new_posts} new posts`,
      ], ', ')
      lines.push(`${index + 1}. **${topic.title}** (topic ${topic.id})${flags ? ` [${flags}]` : ''}`)
      lines.push(indent(joinNonEmpty([
        await this.site.categoryLabel(topic.category_id),
        tagNames(topic.tags).map(name => `#${name}`).join(' '),
        op && users.get(op.user_id) && `by @${users.get(op.user_id)}`,
        `created ${formatTime(topic.created_at)}`,
      ])))
      lines.push(indent(joinNonEmpty([
        `${topic.posts_count - 1} replies`,
        `${topic.views} views`,
        `${topic.like_count} likes`,
        `last post ${formatTime(topic.last_posted_at ?? topic.bumped_at)}${topic.last_poster_username ? ` by @${topic.last_poster_username}` : ''}`,
      ])))
      if (topic.excerpt)
        lines.push(indent(`> ${this.toText(topic.excerpt)}`))
    }

    if (response.topic_list.more_topics_url)
      lines.push('', `More topics: call again with page=${page + 1}.`)
    return lines.join('\n')
  }

  async readTopic(input: ReadTopicInput): Promise<string> {
    const ref = parseTopicRef(input.topic)
    const startAt = input.postNumber ?? ref.postNumber ?? 1
    const topic = await this.client.getJson<TopicResponse>(
      startAt > 1 ? `/t/${ref.topicId}/${startAt}.json` : `/t/${ref.topicId}.json`,
    )

    const loaded = new Map(topic.post_stream.posts.map(post => [post.id, post]))
    const { stream } = topic.post_stream
    const anchor = topic.post_stream.posts.find(post => post.post_number >= startAt)
      ?? topic.post_stream.posts.at(-1)
    const startIndex = anchor ? Math.max(0, stream.indexOf(anchor.id)) : 0
    const windowIds = stream.slice(startIndex, startIndex + input.limit)

    const missing = windowIds.filter(id => !loaded.has(id))
    for (let i = 0; i < missing.length; i += POSTS_BATCH) {
      const batch = await this.client.getJson<PostsResponse>(`/t/${ref.topicId}/posts.json`, {
        post_ids: missing.slice(i, i + POSTS_BATCH),
      })
      for (const post of batch.post_stream.posts)
        loaded.set(post.id, post)
    }
    const posts = windowIds.map(id => loaded.get(id)).filter((post): post is Post => Boolean(post))

    const lines = [
      `# ${topic.title}`,
      topicUrl(this.client.baseUrl, topic.id, topic.slug),
      '',
      joinNonEmpty([
        `topic ${topic.id}`,
        await this.site.categoryLabel(topic.category_id),
        tagNames(topic.tags).map(name => `#${name}`).join(' '),
        topic.details?.created_by && `by @${topic.details.created_by.username}`,
        `created ${formatTime(topic.created_at)}`,
      ]),
      joinNonEmpty([
        `${topic.posts_count} posts`,
        `${topic.views} views`,
        `${topic.like_count} likes`,
        topic.archetype === 'private_message' && 'private message',
        topic.closed && 'closed',
        topic.archived && 'archived',
        topic.accepted_answer && `solved by @${topic.accepted_answer.username} in #${topic.accepted_answer.post_number}`,
      ]),
    ]

    for (const post of posts)
      lines.push('', this.renderPost(post))

    const last = posts.at(-1)
    const endIndex = startIndex + posts.length
    lines.push('', '---')
    if (posts.length === 0)
      lines.push(`No posts at or after #${startAt}.`)
    else if (endIndex < stream.length)
      lines.push(`Showing #${posts[0]!.post_number}–#${last!.post_number} (${endIndex} of ${stream.length} visible posts). Continue with post_number=${last!.post_number + 1}.`)
    else
      lines.push(`Showing #${posts[0]!.post_number}–#${last!.post_number}; end of topic (${stream.length} visible posts).`)
    return lines.join('\n')
  }

  private renderPost(post: Post): string {
    const likes = post.actions_summary?.find(action => action.id === 2)?.count ?? 0
    const reactions = (post.reactions ?? []).map(reaction => `${reaction.id}×${reaction.count}`).join(' ')
    const header = joinNonEmpty([
      `## #${post.post_number} @${post.username}${post.name && post.name !== post.username ? ` (${post.name})` : ''}`,
      formatTime(post.created_at),
      post.reply_to_post_number && `reply to #${post.reply_to_post_number}${post.reply_to_user ? ` @${post.reply_to_user.username}` : ''}`,
      likes > 0 && `${likes} likes`,
      reactions && `reactions ${reactions}`,
      post.accepted_answer && 'accepted answer',
      post.post_type === POST_TYPE_WHISPER && 'whisper',
      post.hidden && 'hidden',
      post.deleted_at && 'deleted',
    ])

    if (post.post_type === POST_TYPE_SMALL_ACTION)
      return `${header}\n_(${post.action_code ?? 'action'})_${post.cooked ? `\n${this.toMarkdown(post.cooked)}` : ''}`

    const body = this.toMarkdown(post.cooked)
    const polls = (post.polls ?? []).map((poll) => {
      const options = poll.options.map(option => `  - ${this.toText(option.html)}${option.votes !== undefined ? `: ${option.votes}` : ''}`)
      return [`**Poll "${poll.name}"** (${poll.status}, ${poll.voters ?? 0} voters)`, ...options].join('\n')
    })
    return [header, body, ...polls].filter(Boolean).join('\n\n')
  }

  async search(query: string, page = 1): Promise<string> {
    const response = await this.client.getJson<SearchResponse>('/search.json', { q: query, page: page > 1 ? page : undefined })
    const topics = new Map((response.topics ?? []).map(topic => [topic.id, topic]))
    const lines = [`# Search "${query}" (page ${page})`, '']

    if (response.users?.length)
      lines.push(`Users: ${response.users.map(user => `@${user.username}`).join(', ')}`, '')
    if (response.categories?.length)
      lines.push(`Categories: ${response.categories.map(category => `${category.name} (\`${category.slug}\`)`).join(', ')}`, '')

    const posts = response.posts ?? []
    if (posts.length === 0)
      lines.push('No matching posts.')
    for (const [index, post] of posts.entries()) {
      const topic = topics.get(post.topic_id)
      lines.push(`${index + 1}. **${topic?.title ?? `Topic ${post.topic_id}`}** (topic ${post.topic_id}, post #${post.post_number})${topic?.has_accepted_answer ? ' [solved]' : ''}${topic?.closed ? ' [closed]' : ''}`)
      lines.push(indent(joinNonEmpty([
        await this.site.categoryLabel(topic?.category_id),
        tagNames(topic?.tags).map(name => `#${name}`).join(' '),
        `@${post.username}`,
        formatTime(post.created_at),
        post.like_count && `${post.like_count} likes`,
      ])))
      lines.push(indent(`> ${this.toText(post.blurb)}`))
    }

    if (response.grouped_search_result?.more_full_page_results)
      lines.push('', `More results: call again with page=${page + 1}.`)
    return lines.join('\n')
  }

  async getUser(username: string, recentLimit: number): Promise<string> {
    const name = encodeURIComponent(username.replace(/^@/, ''))
    const [{ user }, summary, actions] = await Promise.all([
      this.client.getJson<UserResponse>(`/u/${name}.json`),
      this.client.getJson<UserSummaryResponse>(`/u/${name}/summary.json`).catch(() => undefined),
      recentLimit > 0
        ? this.client.getJson<UserActionsResponse>('/user_actions.json', {
            username: username.replace(/^@/, ''),
            filter: `${USER_ACTION_TOPIC},${USER_ACTION_REPLY}`,
          })
        : Promise.resolve(undefined),
    ])

    const stats = summary?.user_summary
    const lines = [
      `# @${user.username}${user.name ? ` (${user.name})` : ''}${user.title ? ` — ${user.title}` : ''}`,
      `${this.client.baseUrl}/u/${name}`,
      '',
      joinNonEmpty([
        `trust level ${user.trust_level}`,
        user.admin && 'admin',
        user.moderator && 'moderator',
        `joined ${formatTime(user.created_at)}`,
        user.last_posted_at && `last posted ${formatTime(user.last_posted_at)}`,
        user.last_seen_at && `last seen ${formatTime(user.last_seen_at)}`,
      ]),
      stats && joinNonEmpty([
        `${stats.topic_count} topics`,
        `${stats.post_count} posts`,
        `${stats.likes_received} likes received`,
        `${stats.likes_given} likes given`,
        `${stats.days_visited} days visited`,
        stats.solved_count !== undefined && `${stats.solved_count} solutions`,
        user.badge_count !== undefined && `${user.badge_count} badges`,
      ]),
      (user.location || user.website)
        ? joinNonEmpty([user.location && `location: ${user.location}`, user.website && `website: ${user.website}`])
        : undefined,
    ].filter((line): line is string => line !== undefined)

    if (user.bio_cooked)
      lines.push('', '## Bio', this.toMarkdown(user.bio_cooked))

    const recent = actions?.user_actions.slice(0, recentLimit) ?? []
    if (recent.length) {
      lines.push('', '## Recent topics and replies')
      for (const action of recent) {
        const kind = action.action_type === USER_ACTION_TOPIC ? 'new topic' : `reply #${action.post_number}`
        lines.push(`- ${formatTime(action.created_at)} ${kind} in **${action.title}** (topic ${action.topic_id}, post #${action.post_number})`)
        if (action.excerpt)
          lines.push(`  > ${this.toText(action.excerpt)}`)
      }
    }
    return lines.join('\n')
  }

  async listNotifications(limit: number, unreadOnly: boolean): Promise<string> {
    const me = await this.whoami()
    const response = await this.client.getJson<NotificationsResponse>('/notifications.json', {
      username: me.username,
      filter: unreadOnly ? 'unread' : undefined,
    })
    const notifications = response.notifications.slice(0, limit)
    const lines = [
      `# Notifications for @${me.username}${unreadOnly ? ' (unread only)' : ''}`,
      `${me.unread_notifications ?? 0} unread, ${me.unread_high_priority_notifications ?? 0} unread high-priority`,
      '',
    ]
    if (notifications.length === 0)
      lines.push('No notifications.')
    for (const notification of notifications) {
      const data = notification.data
      const actor = (data.display_username ?? data.username ?? data.original_username) as string | undefined
      const title = notification.fancy_title ?? (data.topic_title as string | undefined)
      const where = notification.topic_id
        ? ` in **${this.toText(title ?? '')}** (topic ${notification.topic_id}${notification.post_number ? `, post #${notification.post_number}` : ''})`
        : ''
      const extra = (data.badge_name as string | undefined) ? ` badge "${data.badge_name}"` : ''
      lines.push(`- ${notification.read ? '' : '[unread] '}${formatTime(notification.created_at)} ${await this.site.notificationTypeName(notification.notification_type)}${actor ? ` by @${actor}` : ''}${where}${extra}`)
    }
    return lines.join('\n')
  }

  async viewImage(url: string): Promise<ImageResult> {
    const target = this.client.resolveUrl(url)
    if (target.protocol !== 'https:' && target.protocol !== 'http:')
      throw new Error(`Unsupported URL: ${url}`)
    const { bytes, contentType, url: finalUrl } = await this.client.fetchBinary(target, MAX_IMAGE_BYTES)
    const sniffed = IMAGE_SIGNATURES.find(([, matches]) => matches(bytes))?.[0]
    const declared = contentType.split(';')[0]!.trim().toLowerCase()
    const mimeType = sniffed ?? (IMAGE_SIGNATURES.some(([type]) => type === declared) ? declared : undefined)
    if (!mimeType)
      throw new Error(`Not a supported raster image (content-type ${declared}); only PNG, JPEG, GIF and WebP can be returned.`)
    return { data: Buffer.from(bytes).toString('base64'), mimeType, url: finalUrl.href }
  }
}
