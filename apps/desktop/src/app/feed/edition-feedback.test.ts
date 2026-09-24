import { afterEach, expect, it, vi } from 'vitest'

import { feedEditionLovedKey, readLovedFeedEditions, setFeedEditionLoved } from './edition-feedback'

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
