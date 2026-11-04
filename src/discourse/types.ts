/** Subsets of Discourse JSON payloads that this server reads. */

/** Recent Discourse versions serialize tags as objects; older ones as plain names. */
export type TagRef = string | { name: string }

export interface SiteCategory {
  id: number
  name: string
  slug: string
  parent_category_id?: number | null
  description_text?: string | null
  read_restricted?: boolean
  topic_count?: number
  post_count?: number
}

export interface Site {
  categories: SiteCategory[]
  notification_types: Record<string, number>
}

export interface TopicListItem {
  id: number
  title: string
  slug: string
  posts_count: number
  reply_count?: number
  created_at: string
  last_posted_at?: string | null
  bumped_at?: string
  views: number
  like_count: number
  category_id?: number
  tags?: TagRef[]
  pinned?: boolean
  closed?: boolean
  archived?: boolean
  excerpt?: string | null
  unread_posts?: number
  new_posts?: number
  unseen?: boolean
  has_accepted_answer?: boolean
  last_poster_username?: string
  posters?: Array<{ user_id: number, description?: string, extras?: string | null }>
}

export interface TopicListResponse {
  users?: Array<{ id: number, username: string }>
  topic_list: {
    topics: TopicListItem[]
    more_topics_url?: string
    per_page?: number
  }
}

export interface Poll {
  name: string
  type: string
  status: string
  voters?: number
  options: Array<{ id: string, html: string, votes?: number }>
}

export interface Post {
  id: number
  post_number: number
  post_type: number
  username: string
  name?: string | null
  user_title?: string | null
  created_at: string
  updated_at?: string
  cooked: string
  reply_to_post_number?: number | null
  reply_to_user?: { username: string } | null
  reply_count?: number
  actions_summary?: Array<{ id: number, count?: number }>
  reactions?: Array<{ id: string, count: number }>
  action_code?: string | null
  accepted_answer?: boolean
  deleted_at?: string | null
  hidden?: boolean
  polls?: Poll[]
  topic_id?: number
}

export interface TopicResponse {
  id: number
  title: string
  slug: string
  posts_count: number
  created_at: string
  last_posted_at?: string | null
  views: number
  like_count: number
  category_id?: number
  tags?: TagRef[]
  closed?: boolean
  archived?: boolean
  pinned?: boolean
  archetype?: string
  accepted_answer?: { post_number: number, username: string } | null
  details?: { created_by?: { username: string }, participants?: Array<{ username: string, post_count: number }> }
  post_stream: { posts: Post[], stream: number[] }
}

export interface PostsResponse {
  post_stream: { posts: Post[] }
}

export interface SearchResponse {
  posts?: Array<{
    id: number
    username: string
    created_at: string
    like_count?: number
    blurb: string
    post_number: number
    topic_id: number
  }>
  topics?: Array<{
    id: number
    title: string
    slug: string
    category_id?: number
    tags?: TagRef[]
    posts_count?: number
    closed?: boolean
    has_accepted_answer?: boolean
  }>
  users?: Array<{ username: string, name?: string | null }>
  categories?: Array<{ id: number, name: string, slug: string }>
  grouped_search_result?: {
    more_full_page_results?: boolean | null
    more_posts?: boolean | null
  }
}

export interface UserResponse {
  user: {
    id: number
    username: string
    name?: string | null
    title?: string | null
    created_at: string
    last_posted_at?: string | null
    last_seen_at?: string | null
    trust_level: number
    moderator?: boolean
    admin?: boolean
    badge_count?: number
    location?: string | null
    website?: string | null
    bio_cooked?: string | null
  }
}

export interface UserSummaryResponse {
  user_summary: {
    topic_count: number
    post_count: number
    likes_given: number
    likes_received: number
    days_visited: number
    posts_read_count: number
    solved_count?: number
  }
}

export interface UserActionsResponse {
  user_actions: Array<{
    action_type: number
    created_at: string
    excerpt?: string
    title: string
    topic_id: number
    post_number: number
    slug: string
    category_id?: number
  }>
}

export interface NotificationsResponse {
  notifications: Array<{
    id: number
    notification_type: number
    read: boolean
    created_at: string
    topic_id?: number | null
    post_number?: number | null
    slug?: string | null
    fancy_title?: string | null
    data: Record<string, unknown>
  }>
  total_rows_notifications?: number
}

export interface CurrentUserResponse {
  current_user: {
    id: number
    username: string
    name?: string | null
    unread_notifications?: number
    unread_high_priority_notifications?: number
  }
}
