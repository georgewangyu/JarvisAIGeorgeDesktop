import { afterEach, expect, it, vi } from 'vitest'

import {
  feedEditionLovedKey, feedStoryId, feedStoryLovedKey, readLovedFeedEditions,
  readLovedFeedStories, setFeedEditionLoved, setFeedStoryLoved
} from './edition-feedback'

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

it('persists reversible edition Love for only the selected profile and connection', () => {
  expect(setFeedEditionLoved('personal', null, 'edition-1', true)).toBe(true)
  expect(readLovedFeedEditions('personal', null)).toEqual(['edition-1'])
  expect(readLovedFeedEditions('work', null)).toEqual([])
  expect(readLovedFeedEditions('personal', 'local')).toEqual([])
  expect(setFeedEditionLoved('personal', null, 'edition-1', false)).toBe(true)
  expect(readLovedFeedEditions('personal', null)).toEqual([])
})

it('refuses a failed device-local write without inventing a saved choice', () => {
  vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('storage blocked') })

  expect(setFeedEditionLoved('personal', null, 'edition-1', true)).toBe(false)
  expect(readLovedFeedEditions('personal', null)).toEqual([])
})

it('ignores corrupt IDs and blank writes', () => {
  window.localStorage.setItem(feedEditionLovedKey('personal', null), JSON.stringify(['edition-1', 14, '', 'edition-2']))

  expect(readLovedFeedEditions('personal', null)).toEqual(['edition-1', 'edition-2'])
  expect(setFeedEditionLoved('personal', null, ' ', true)).toBe(false)
})

it('keeps each completed story choice separate, reversible, and scoped', () => {
  expect(setFeedStoryLoved('personal', null, 'edition-1', 0, true)).toBe(true)
  expect(readLovedFeedStories('personal', null)).toEqual([feedStoryId('edition-1', 0)])
  expect(readLovedFeedStories('personal', 'local')).toEqual([])
  expect(readLovedFeedStories('work', null)).toEqual([])
  expect(readLovedFeedEditions('personal', null)).toEqual([])
  expect(setFeedStoryLoved('personal', null, 'edition-1', 1, true)).toBe(true)
  expect(readLovedFeedStories('personal', null)).toEqual([
    feedStoryId('edition-1', 0), feedStoryId('edition-1', 1)
  ])
  expect(setFeedStoryLoved('personal', null, 'edition-1', 0, false)).toBe(true)
  expect(readLovedFeedStories('personal', null)).toEqual([feedStoryId('edition-1', 1)])
})

it('rejects invalid story identity and refuses storage failure', () => {
  expect(setFeedStoryLoved('personal', null, ' ', 0, true)).toBe(false)
  expect(setFeedStoryLoved('personal', null, 'edition-1', 12, true)).toBe(false)
  expect(setFeedStoryLoved('personal', null, 'edition-1', -1, true)).toBe(false)
  expect(setFeedStoryLoved('personal', null, 'edition-1', 0.5, true)).toBe(false)
  vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('storage blocked') })
  expect(setFeedStoryLoved('personal', null, 'edition-1', 0, true)).toBe(false)
  expect(readLovedFeedStories('personal', null)).toEqual([])
  expect(window.localStorage.getItem(feedStoryLovedKey('personal', null))).toBeNull()
})
