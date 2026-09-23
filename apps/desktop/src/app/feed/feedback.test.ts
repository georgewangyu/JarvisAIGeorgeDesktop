import { afterEach, expect, it } from 'vitest'

import { feedLovedKey, readLovedFeedRuns, setFeedRunLoved } from './feedback'

afterEach(() => window.localStorage.clear())

it('keeps reversible Love scoped to profile and connection', () => {
  expect(setFeedRunLoved('personal', null, 'run-1', true)).toBe(true)
  expect(readLovedFeedRuns('personal', null)).toEqual(['run-1'])
  expect(readLovedFeedRuns('work', null)).toEqual([])
  expect(readLovedFeedRuns('personal', 'remote')).toEqual([])
  expect(setFeedRunLoved('personal', null, 'run-1', false)).toBe(true)
  expect(readLovedFeedRuns('personal', null)).toEqual([])
})

it('ignores malformed stored values and blank run IDs', () => {
  window.localStorage.setItem(feedLovedKey('personal', null), JSON.stringify(['run-1', 123, '', 'run-2']))
  expect(readLovedFeedRuns('personal', null)).toEqual(['run-1', 'run-2'])
  expect(setFeedRunLoved('personal', null, ' ', true)).toBe(false)
})
