import { describe, expect, it } from 'vitest'
import { createHtmlConverter, createTextConverter } from '../src/format/html'

const toMarkdown = createHtmlConverter('https://forum.example.com')

describe('createHtmlConverter', () => {
  it('renders emoji as shortcodes, not images', () => {
    const html = '<p>nice <img src="https://emoji.cdn/grinning_face.png" title=":grinning_face:" class="emoji" alt=":grinning_face:"> and <img src="x" alt="slight_smile" class="emoji only-emoji"></p>'
    expect(toMarkdown(html)).toBe('nice :grinning_face: and :slight_smile:')
  })

  it('links lightboxed uploads to the original and prefers the AI caption', () => {
    const html = `<p><div class="lightbox-wrapper"><a class="lightbox" href="/uploads/default/original/1X/abc.png" title="image">
      <img src="/uploads/default/optimized/1X/abc_2_690x107.png" alt="image" aria-description="A bank statement table">
      <div class="meta"><svg class="fa"><use href="#far-image"></use></svg><span class="filename">image</span><span class="informations">2200×344 20 KB</span></div>
    </a></div></p>`
    expect(toMarkdown(html)).toBe('![A bank statement table](https://forum.example.com/uploads/default/original/1X/abc.png)')
  })

  it('attributes quotes to their author and post', () => {
    const html = `<aside class="quote no-group" data-username="alice" data-post="3" data-topic="42">
      <div class="title"><div class="quote-controls"></div><img class="avatar" src="/a.png"> alice:</div>
      <blockquote><p>年费可以免吗？</p></blockquote></aside><p>可以</p>`
    expect(toMarkdown(html)).toBe('> **Quoting @alice topic 42 #3:**\n> 年费可以免吗？\n\n可以')
  })

  it('demotes headings below the post header level and keeps lists compact', () => {
    const html = '<h1>Title</h1><ul><li>one</li><li>two</li></ul><ol start="3"><li>three</li></ol>'
    expect(toMarkdown(html)).toBe('### Title\n\n- one\n- two\n\n3. three')
  })

  it('resolves relative links and flattens mentions', () => {
    const html = '<p><a class="mention" href="/u/bob">@bob</a> see <a href="/t/topic/9">this</a> and <a href="https://x.dev">https://x.dev</a></p>'
    expect(toMarkdown(html)).toBe('@bob see [this](https://forum.example.com/t/topic/9) and <https://x.dev>')
  })

  it('summarizes oneboxes as a link with description', () => {
    const html = `<aside class="onebox allowlistedgeneric" data-onebox-src="https://bank.example/card">
      <header class="source"><a href="https://bank.example/card">bank.example</a></header>
      <article class="onebox-body"><h3><a href="https://bank.example/card">Platinum Card</a></h3><p>No annual fee.</p></article></aside>`
    expect(toMarkdown(html)).toBe('> [Platinum Card](https://bank.example/card)\n> No annual fee.')
  })

  it('keeps multi-line table cells on one row', () => {
    const html = '<table><thead><tr><th>银行</th><th>费用</th></tr></thead><tbody><tr><td><img src="/a.png" alt="卡"><br>祥鹿金卡</td><td>1，年费 50 元<br>2，免 a|b</td></tr></tbody></table>'
    expect(toMarkdown(html)).toBe('| 银行 | 费用 |\n| --- | --- |\n| ![卡](https://forum.example.com/a.png)<br>祥鹿金卡 | 1，年费 50 元<br>2，免 a\\|b |')
  })

  it('keeps tables as GFM', () => {
    const html = '<div class="md-table"><table><thead><tr><th>卡</th><th>年费</th></tr></thead><tbody><tr><td>A</td><td>0</td></tr></tbody></table></div>'
    expect(toMarkdown(html)).toBe('| 卡 | 年费 |\n| --- | --- |\n| A | 0 |')
  })
})

describe('createTextConverter', () => {
  it('strips markup and decodes entities from excerpts', () => {
    const toText = createTextConverter()
    expect(toText('<span class="search-highlight">招商</span> 信用卡&hellip; <a href="/x">link</a> 1_2')).toBe('招商 信用卡… link 1_2')
  })
})
