import { expect, it } from 'vitest'

import type { FeedEdition } from '@/api/feed'

import { groupFeedEditionsByDay } from './group-editions'

const edition = (id: string, created_at: string): FeedEdition => ({
  attempt: 1,
  content: 'Saved content',
  created_at,
  error: null,
  finished_at: created_at,
  id,
  prompt: 'Brief me',
  source_urls: [],
  source_urls_verified: false,
  status: 'completed'
})

it('groups newest editions into local calendar days without mutating the response', () => {
  const input = [
    edition('older', '2026-09-21T12:00:00Z'),
    edition('latest', '2026-09-23T13:00:00Z'),
    edition('same-day', '2026-09-23T12:00:00Z')
  ]

  const grouped = groupFeedEditionsByDay(input)

  expect(grouped.map(group => group.editions.map(item => item.id))).toEqual([
    ['latest', 'same-day'],
    ['older']
  ])
  expect(grouped[0].label).toContain('2026')
  expect(input[0].id).toBe('older')
})

it('keeps a malformed timestamp visible in an explicit undated group', () => {
  const grouped = groupFeedEditionsByDay([
    edition('undated', 'not-a-date'),
    edition('dated', '2026-09-23T12:00:00Z')
  ])

  expect(grouped[0].editions[0].id).toBe('dated')
  expect(grouped[1].label).toBe('Date unavailable')
  expect(grouped[1].editions[0].id).toBe('undated')
})
