import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

type TNode = Element

function attr(node: TNode, name: string): string {
  return node.getAttribute(name)?.trim() ?? ''
}

function hasClass(node: TNode, className: string): boolean {
  return node.nodeType === 1 && (` ${attr(node, 'class')} `).includes(` ${className} `)
}

function escapeAlt(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[[\]]/g, '\\$&').trim()
}

function quoteBlock(markdown: string): string {
  return markdown.trim().split('\n').map(line => (line ? `> ${line}` : '>')).join('\n')
}

/**
 * Converts Discourse "cooked" post HTML to compact Markdown, resolving
 * forum-relative links and flattening Discourse-specific widgets.
 */
export function createHtmlConverter(baseUrl: string): (html: string) => string {
  const absolute = (href: string): string => {
    // Already-absolute URLs stay verbatim; only forum-relative ones are resolved.
    if (!href || /^[a-z][a-z\d+.-]*:/i.test(href))
      return href
    try {
      return new URL(href, `${baseUrl}/`).href
    }
    catch {
      return href
    }
  }

  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  })
  td.use(gfm)

  td.remove(node => hasClass(node, 'meta') || hasClass(node, 'quote-controls') || hasClass(node, 'anchor')
    || node.nodeName === 'SVG' || node.nodeName === 'svg')

  // Turndown gives later rules precedence: generic element rules first, Discourse-specific ones after.
  // Post bodies sit under `## #N` headers, so their own headings are demoted two levels.
  td.addRule('heading', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: (content, node) => {
      const level = Math.min(6, Number(node.nodeName.charAt(1)) + 2)
      return `\n\n${'#'.repeat(level)} ${content.trim()}\n\n`
    },
  })

  td.addRule('listItem', {
    filter: 'li',
    replacement: (content, node) => {
      const parent = node.parentNode as TNode | null
      let prefix = '- '
      if (parent?.nodeName === 'OL') {
        const start = Number(attr(parent, 'start')) || 1
        prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `
      }
      const body = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/g, `\n${' '.repeat(prefix.length)}`)
      return prefix + body + (node.nextSibling && !body.endsWith('\n') ? '\n' : '')
    },
  })

  // GFM table rows must stay on one line: keep in-cell line breaks as <br> and escape pipes.
  td.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: (content, node) => {
      const text = content.trim().replace(/ *\n+ */g, '<br>').replace(/\|/g, '\\|')
      return `${node.parentNode?.firstElementChild === node ? '| ' : ' '}${text} |`
    },
  })

  td.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      const element = node as TNode
      const src = absolute(attr(element, 'src'))
      const caption = attr(element, 'aria-description') || attr(element, 'alt') || 'image'
      return src ? `![${escapeAlt(caption)}](${src})` : ''
    },
  })

  td.addRule('link', {
    filter: node => node.nodeName === 'A' && Boolean(attr(node, 'href')),
    replacement: (content, node) => {
      const href = absolute(attr(node as TNode, 'href'))
      const text = content.trim()
      if (!text)
        return ''
      if (hasClass(node as TNode, 'mention') || hasClass(node as TNode, 'hashtag-cooked'))
        return text
      return text === href ? `<${href}>` : `[${text}](${href})`
    },
  })

  td.addRule('emoji', {
    filter: node => node.nodeName === 'IMG' && hasClass(node, 'emoji'),
    replacement: (_content, node) => {
      const name = attr(node as TNode, 'title') || attr(node as TNode, 'alt')
      return name.startsWith(':') ? name : `:${name}:`
    },
  })

  td.addRule('avatar', {
    filter: node => node.nodeName === 'IMG' && hasClass(node, 'avatar'),
    replacement: () => '',
  })

  // Lightboxed uploads: link to the original, describe with the AI caption when present.
  td.addRule('lightbox', {
    filter: node => hasClass(node, 'lightbox-wrapper'),
    replacement: (_content, node) => {
      const element = node as TNode
      const link = element.querySelector('a.lightbox')
      const img = element.querySelector('img')
      const href = absolute((link && attr(link, 'href')) || (img && attr(img, 'src')) || '')
      const caption = (img && (attr(img, 'aria-description') || attr(img, 'alt'))) || 'image'
      return href ? `\n\n![${escapeAlt(caption)}](${href})\n\n` : ''
    },
  })

  td.addRule('quote', {
    filter: node => node.nodeName === 'ASIDE' && hasClass(node, 'quote'),
    replacement: (_content, node) => {
      const element = node as TNode
      const username = attr(element, 'data-username')
      const post = attr(element, 'data-post')
      const topic = attr(element, 'data-topic')
      const titleLink = element.querySelector('.title a[href*="/t/"]')
      const source = [
        username && `@${username}`,
        titleLink ? `in "${titleLink.textContent?.trim()}"` : topic && `topic ${topic}`,
        post && `#${post}`,
      ].filter(Boolean).join(' ')
      const blockquote = element.querySelector('blockquote')
      const body = blockquote ? td.turndown(blockquote.innerHTML) : ''
      return `\n\n${quoteBlock(`${source ? `**Quoting ${source}:**\n` : ''}${body}`)}\n\n`
    },
  })

  td.addRule('onebox', {
    filter: node => node.nodeName === 'ASIDE' && hasClass(node, 'onebox'),
    replacement: (_content, node) => {
      const element = node as TNode
      const heading = element.querySelector('h3 a, h4 a, header a')
      const url = absolute(attr(element, 'data-onebox-src') || (heading ? attr(heading, 'href') : ''))
      const title = element.querySelector('h3, h4')?.textContent?.trim() || heading?.textContent?.trim() || url
      const summary = element.querySelector('article p')?.textContent?.replace(/\s+/g, ' ').trim()
      const line = url ? `[${title}](${url})` : title
      return `\n\n> ${line}${summary ? `\n> ${summary}` : ''}\n\n`
    },
  })

  td.addRule('spoiler', {
    filter: node => hasClass(node, 'spoiler') || hasClass(node, 'spoiled'),
    replacement: content => `||${content.trim()}||`,
  })

  td.addRule('details', {
    filter: 'details',
    replacement: (content, node) => {
      const summary = (node as TNode).querySelector('summary')?.textContent?.trim() || 'Details'
      const body = content.replace(summary, '').trim()
      return `\n\n<details> ${summary}\n\n${body}\n\n</details>\n\n`
    },
  })

  return (html: string) => td.turndown(html).replace(/\n{3,}/g, '\n\n').trim()
}

/** Strips markup from short HTML snippets (excerpts, search blurbs) and decodes entities. */
export function createTextConverter(): (html: string) => string {
  const td = new TurndownService()
  td.addRule('plain', {
    filter: ['a', 'span', 'strong', 'em', 'b', 'i', 'code'],
    replacement: content => content,
  })
  td.addRule('emoji', {
    filter: node => node.nodeName === 'IMG',
    replacement: (_content, node) => {
      const alt = attr(node as TNode, 'alt')
      return alt ? `:${alt.replace(/^:|:$/g, '')}:` : ''
    },
  })
  td.escape = text => text
  return (html: string) => td.turndown(html).replace(/\s+/g, ' ').trim()
}
