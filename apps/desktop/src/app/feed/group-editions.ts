import type { FeedEdition } from '@/api/feed'

export interface FeedEditionDay {
  editions: FeedEdition[]
  key: string
  label: string
}

export function groupFeedEditionsByDay(editions: FeedEdition[]): FeedEditionDay[] {
  const groups: FeedEditionDay[] = []

  for (const edition of [...editions].sort((a, b) => {
    const left = Date.parse(a.created_at)
    const right = Date.parse(b.created_at)

    if (!Number.isFinite(left)) {return Number.isFinite(right) ? 1 : 0}

    if (!Number.isFinite(right)) {return -1}

    return right - left
  })) {
    const date = new Date(edition.created_at)
    const valid = Number.isFinite(date.getTime())
    const key = valid ? date.toDateString() : 'unknown'
    let group = groups.find(item => item.key === key)

    if (!group) {
      group = {
        editions: [],
        key,
        label: valid
          ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', weekday: 'long', year: 'numeric' })
          : 'Date unavailable'
      }
      groups.push(group)
    }

    group.editions.push(edition)
  }

  return groups
}
