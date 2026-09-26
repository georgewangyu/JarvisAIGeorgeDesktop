export interface FeedEditionItem {
  title: string
  body: string
}

export interface ParsedFeedEditionItems {
  introduction: string
  items: FeedEditionItem[]
}

/**
 * Treat generated prose as multiple stories only when it actually contains
 * multiple complete level-two Markdown sections. Never infer items from
 * sentences, URLs, lists, or headings inside a fenced code block.
 */
export function parseFeedEditionItems(content: string): ParsedFeedEditionItems | null {
  const lines = content.split(/\r?\n/)
  const boundaries: Array<{ line: number; title: string }> = []
  let fence: null | { marker: string; length: number } = null

  lines.forEach((line, index) => {
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)

    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`)

      if (closing.test(line)) {fence = null}

      return
    }

    if (opening) {
      fence = { marker: opening[1][0], length: opening[1].length }

      return
    }

    const heading = /^ {0,3}## (.+?)\s*#*\s*$/.exec(line)

    if (heading?.[1].trim()) {boundaries.push({ line: index, title: heading[1].trim() })}
  })

  if (boundaries.length < 2 || boundaries.length > 12) {return null}

  const items = boundaries.map((boundary, index) => ({
    title: boundary.title,
    body: lines.slice(boundary.line + 1, boundaries[index + 1]?.line ?? lines.length).join('\n').trim()
  }))

  if (items.some(item => !item.body || item.title.length > 160)) {return null}

  return {
    introduction: lines.slice(0, boundaries[0].line).join('\n').trim(),
    items
  }
}
