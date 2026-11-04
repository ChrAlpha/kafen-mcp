export interface TopicRef {
  topicId: number
  postNumber?: number
}

/**
 * Parses a topic id or any forum topic URL:
 * `123`, `/t/123`, `/t/slug/123`, `/t/slug/123/45`, `https://host/t/slug/123/45?u=x`.
 */
export function parseTopicRef(input: string | number): TopicRef {
  if (typeof input === 'number')
    return { topicId: input }
  const text = input.trim()
  if (/^\d+$/.test(text))
    return { topicId: Number(text) }

  let path = text
  try {
    path = new URL(text, 'https://placeholder.invalid').pathname
  }
  catch {}
  const segments = path.split('/').filter(Boolean)
  const t = segments.indexOf('t')
  if (t !== -1) {
    const rest = segments.slice(t + 1)
    const numeric = rest.map(segment => (/^\d+$/.test(segment) ? Number(segment) : undefined))
    // `/t/slug/123[/45]` or `/t/123[/45]`
    const idIndex = numeric[0] !== undefined ? 0 : numeric[1] !== undefined ? 1 : -1
    if (idIndex !== -1) {
      const postNumber = numeric[idIndex + 1]
      return { topicId: numeric[idIndex]!, ...(postNumber ? { postNumber } : {}) }
    }
  }
  throw new Error(`Not a topic id or topic URL: "${input}"`)
}

export function topicUrl(baseUrl: string, topicId: number, slug?: string, postNumber?: number): string {
  const parts = [baseUrl, 't', slug || 'topic', String(topicId)]
  if (postNumber && postNumber > 1)
    parts.push(String(postNumber))
  return parts.join('/')
}
