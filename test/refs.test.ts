import { describe, expect, it } from 'vitest'
import { parseTopicRef, topicUrl } from '../src/discourse/refs'

describe('parseTopicRef', () => {
  it.each([
    [123, { topicId: 123 }],
    ['123', { topicId: 123 }],
    ['/t/123', { topicId: 123 }],
    ['/t/123/4', { topicId: 123, postNumber: 4 }],
    ['/t/some-slug/123', { topicId: 123 }],
    ['https://forum.docofcard.com/t/some-slug/123/45?u=me', { topicId: 123, postNumber: 45 }],
    ['https://forum.docofcard.com/t/2026/123', { topicId: 2026, postNumber: 123 }],
  ])('parses %s', (input, expected) => {
    expect(parseTopicRef(input)).toEqual(expected)
  })

  it('rejects non-topic input', () => {
    expect(() => parseTopicRef('https://forum.docofcard.com/u/alice')).toThrow(/Not a topic/)
  })
})

describe('topicUrl', () => {
  it('omits the post number for the first post', () => {
    expect(topicUrl('https://f.example', 9, 'slug', 1)).toBe('https://f.example/t/slug/9')
    expect(topicUrl('https://f.example', 9, 'slug', 3)).toBe('https://f.example/t/slug/9/3')
  })
})
