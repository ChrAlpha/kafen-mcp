import type { DiscourseClient } from './client'
import type { Site, SiteCategory } from './types'

const TTL_MS = 60 * 60 * 1000

/** Discourse's `slug_for_url`: categories with an empty slug (common for Chinese names) route as `{id}-category`. */
function urlSlug(category: SiteCategory): string {
  return category.slug || `${category.id}-category`
}

function matchesRef(category: SiteCategory, ref: string): boolean {
  return urlSlug(category).toLowerCase() === ref || category.name.toLowerCase() === ref
}

/** Caches `/site.json` (categories and enum tables) so tools can resolve names without extra requests. */
export class SiteInfo {
  private cached?: { site: Site, at: number }
  private inflight?: Promise<Site>

  constructor(private readonly client: DiscourseClient, private readonly now: () => number = Date.now) {}

  async get(): Promise<Site> {
    if (this.cached && this.now() - this.cached.at < TTL_MS)
      return this.cached.site
    this.inflight ??= this.client.getJson<Site>('/site.json').then((site) => {
      this.cached = { site, at: this.now() }
      return site
    }).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  async category(id: number | undefined): Promise<SiteCategory | undefined> {
    if (id === undefined)
      return undefined
    return (await this.get()).categories.find(category => category.id === id)
  }

  /** `Parent / Child` display name. */
  async categoryLabel(id: number | undefined): Promise<string | undefined> {
    const category = await this.category(id)
    if (!category)
      return undefined
    const parent = await this.category(category.parent_category_id ?? undefined)
    return parent ? `${parent.name} / ${category.name}` : category.name
  }

  /** Accepts a numeric id, a slug, a `parent/child` slug path, or a display name. */
  async resolveCategory(ref: string): Promise<SiteCategory> {
    const { categories } = await this.get()
    const needle = ref.trim().replace(/^#/, '')
    const byId = /^\d+$/.test(needle) ? categories.find(c => c.id === Number(needle)) : undefined
    if (byId)
      return byId

    const parts = needle.split('/').map(part => part.trim().toLowerCase())
    const leaf = parts.at(-1)!
    const parentSlug = parts.length > 1 ? parts.at(-2) : undefined
    const matches = categories.filter((c) => {
      if (!matchesRef(c, leaf))
        return false
      if (!parentSlug)
        return true
      const parent = categories.find(p => p.id === c.parent_category_id)
      return parent !== undefined && matchesRef(parent, parentSlug)
    })
    if (matches.length === 1)
      return matches[0]!
    if (matches.length > 1)
      throw new Error(`Category "${ref}" is ambiguous; use one of: ${(await Promise.all(matches.map(async m => `${await this.categorySlugPath(m)} (id ${m.id})`))).join(', ')}`)
    throw new Error(`Unknown category "${ref}". Call list_categories to see valid slugs.`)
  }

  /** `parent-slug/child-slug`, as used in `/c/...` routes. */
  async categorySlugPath(category: SiteCategory): Promise<string> {
    const parent = await this.category(category.parent_category_id ?? undefined)
    return parent ? `${await this.categorySlugPath(parent)}/${urlSlug(category)}` : urlSlug(category)
  }

  async notificationTypeName(type: number): Promise<string> {
    const entry = Object.entries((await this.get()).notification_types).find(([, value]) => value === type)
    return entry?.[0] ?? `type_${type}`
  }
}
