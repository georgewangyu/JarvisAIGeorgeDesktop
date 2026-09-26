import { afterEach, expect, it, vi } from 'vitest'

import {
  feedEditionLovedKey, feedStoryLovedKey, readLovedFeedEditions, readLovedFeedStories,
  setFeedEditionLoved, setFeedStoryLoved
} from './edition-feedback'
import { readLovedFeedRuns, setFeedRunLoved } from './feedback'
import { dropFeedPreferencesForProfile, migrateFeedPreferencesForProfile } from './preferences-lifecycle'
import { feedPromptKey, readFeedPrompt, saveFeedPrompt } from './prompt'

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

it('moves local Feed preferences on rename without adopting same-named remote data', () => {
  expect(saveFeedPrompt('old', null, 'Local briefing')).toBe(true)
  expect(setFeedRunLoved('old', null, 'run-1', true)).toBe(true)
  expect(setFeedEditionLoved('old', null, 'edition-1', true)).toBe(true)
  expect(setFeedStoryLoved('old', null, 'edition-1', 0, true)).toBe(true)
  expect(saveFeedPrompt('old', 'local', 'Remote briefing')).toBe(true)
  expect(setFeedRunLoved('old', 'local', 'remote-run', true)).toBe(true)
  expect(setFeedEditionLoved('old', 'local', 'remote-edition', true)).toBe(true)
  expect(setFeedStoryLoved('old', 'local', 'remote-edition', 1, true)).toBe(true)

  migrateFeedPreferencesForProfile('old', 'new')

  expect(readFeedPrompt('new', null)).toBe('Local briefing')
  expect(readLovedFeedRuns('new', null)).toEqual(['run-1'])
  expect(readLovedFeedEditions('new', null)).toEqual(['edition-1'])
  expect(readLovedFeedStories('new', null)).toEqual(['edition-1:0'])
  expect(window.localStorage.getItem(feedPromptKey('old', null))).toBeNull()
  expect(window.localStorage.getItem(feedEditionLovedKey('old', null))).toBeNull()
  expect(window.localStorage.getItem(feedStoryLovedKey('old', null))).toBeNull()
  expect(readFeedPrompt('old', 'local')).toBe('Remote briefing')
  expect(readLovedFeedRuns('old', 'local')).toEqual(['remote-run'])
  expect(readLovedFeedEditions('old', 'local')).toEqual(['remote-edition'])
  expect(readLovedFeedStories('old', 'local')).toEqual(['remote-edition:1'])
})

it('preserves destination instructions and merges Love without losing either choice', () => {
  saveFeedPrompt('old', null, 'Older instructions')
  saveFeedPrompt('new', null, 'Current instructions')
  setFeedRunLoved('old', null, 'old-run', true)
  setFeedRunLoved('new', null, 'new-run', true)
  setFeedEditionLoved('old', null, 'old-edition', true)
  setFeedEditionLoved('new', null, 'new-edition', true)
  setFeedStoryLoved('old', null, 'old-edition', 0, true)
  setFeedStoryLoved('new', null, 'new-edition', 1, true)

  migrateFeedPreferencesForProfile('old', 'new')

  expect(readFeedPrompt('new', null)).toBe('Current instructions')
  expect(readLovedFeedRuns('new', null)).toEqual(['new-run', 'old-run'])
  expect(readLovedFeedEditions('new', null)).toEqual(['new-edition', 'old-edition'])
  expect(readLovedFeedStories('new', null)).toEqual(['new-edition:1', 'old-edition:0'])
})

it('keeps old feedback when the target storage write is refused', () => {
  setFeedEditionLoved('old', null, 'edition-1', true)
  setFeedStoryLoved('old', null, 'edition-1', 0, true)
  const target = feedEditionLovedKey('new', null)
  const storyTarget = feedStoryLovedKey('new', null)
  const original = window.localStorage.setItem.bind(window.localStorage)
  vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === target || key === storyTarget) {throw new Error('storage unavailable')}
    original(key, value)
  })

  migrateFeedPreferencesForProfile('old', 'new')

  expect(readLovedFeedEditions('old', null)).toEqual(['edition-1'])
  expect(readLovedFeedEditions('new', null)).toEqual([])
  expect(readLovedFeedStories('old', null)).toEqual(['edition-1:0'])
  expect(readLovedFeedStories('new', null)).toEqual([])
})

it('drops only local Feed preferences when a local profile is deleted', () => {
  saveFeedPrompt('old', null, 'Local briefing')
  setFeedRunLoved('old', null, 'run-1', true)
  setFeedEditionLoved('old', null, 'edition-1', true)
  setFeedStoryLoved('old', null, 'edition-1', 0, true)
  saveFeedPrompt('old', 'local', 'Remote briefing')

  dropFeedPreferencesForProfile('old')

  expect(window.localStorage.getItem(feedPromptKey('old', null))).toBeNull()
  expect(readLovedFeedRuns('old', null)).toEqual([])
  expect(readLovedFeedEditions('old', null)).toEqual([])
  expect(readLovedFeedStories('old', null)).toEqual([])
  expect(readFeedPrompt('old', 'local')).toBe('Remote briefing')
})
