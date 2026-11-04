import type { DiscourseClient } from '../src/discourse/client'
import type { Site } from '../src/discourse/types'
import { describe, expect, it, vi } from 'vitest'
import { SiteInfo } from '../src/discourse/site'

const site: Site = {
  notification_types: { mentioned: 1, replied: 2 },
  categories: [
    { id: 6, name: '卡片交流', slug: 'bank' },
    { id: 8, name: '卡友活动', slug: '' },
    { id: 20, name: 'HSBC', slug: 'hsbc', parent_category_id: 6 },
    { id: 21, name: 'HSBC', slug: 'hsbc', parent_category_id: 8 },
  ],
}

function makeSite() {
  const getJson = vi.fn(async () => site)
  return { info: new SiteInfo({ getJson } as unknown as DiscourseClient), getJson }
}

describe('siteInfo', () => {
  it('fetches site.json once and caches it', async () => {
    const { info, getJson } = makeSite()
    await Promise.all([info.get(), info.get()])
    await info.get()
    expect(getJson).toHaveBeenCalledTimes(1)
  })

  it('resolves categories by id, slug, name and parent path', async () => {
    const { info } = makeSite()
    expect((await info.resolveCategory('6')).id).toBe(6)
    expect((await info.resolveCategory('#bank')).id).toBe(6)
    expect((await info.resolveCategory('卡友活动')).id).toBe(8)
    expect((await info.resolveCategory('8-category')).id).toBe(8)
    expect((await info.resolveCategory('bank/hsbc')).id).toBe(20)
    expect((await info.resolveCategory('卡友活动/hsbc')).id).toBe(21)
  })

  it('explains ambiguous and unknown categories', async () => {
    const { info } = makeSite()
    await expect(info.resolveCategory('hsbc')).rejects.toThrow('bank/hsbc (id 20), 8-category/hsbc (id 21)')
    await expect(info.resolveCategory('nope')).rejects.toThrow(/list_categories/)
  })

  it('uses the id-category fallback for empty slugs in route paths and labels parents', async () => {
    const { info } = makeSite()
    expect(await info.categorySlugPath((await info.category(21))!)).toBe('8-category/hsbc')
    expect(await info.categoryLabel(20)).toBe('卡片交流 / HSBC')
    expect(await info.notificationTypeName(2)).toBe('replied')
  })
})
