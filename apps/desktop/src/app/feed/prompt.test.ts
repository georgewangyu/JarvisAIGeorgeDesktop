import { afterEach, expect, it, vi } from 'vitest'

import { DEFAULT_FEED_PROMPT, feedPromptKey, readFeedPrompt, saveFeedPrompt } from './prompt'

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

it('keeps saved instructions separate by profile and connection', () => {
  expect(saveFeedPrompt('alpha', null, '  Local briefing  ')).toBe(true)
  expect(readFeedPrompt('alpha', null)).toBe('Local briefing')
  expect(readFeedPrompt('beta', null)).toBe(DEFAULT_FEED_PROMPT)
  expect(readFeedPrompt('alpha', 'remote')).toBe(DEFAULT_FEED_PROMPT)
  expect(readFeedPrompt('alpha', 'local')).toBe(DEFAULT_FEED_PROMPT)
})

it('rejects missing or oversized instructions and ignores corrupt stored data', () => {
  expect(saveFeedPrompt('alpha', null, '   ')).toBe(false)
  expect(saveFeedPrompt('alpha', null, 'x'.repeat(8001))).toBe(false)
  window.localStorage.setItem(feedPromptKey('alpha', null), '  ')
  expect(readFeedPrompt('alpha', null)).toBe(DEFAULT_FEED_PROMPT)
})

it('reports a failed device-local write rather than claiming the edit was saved', () => {
  vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
    throw new Error('storage blocked')
  })

  expect(saveFeedPrompt('alpha', null, 'Reliable news')).toBe(false)
  expect(readFeedPrompt('alpha', null)).toBe(DEFAULT_FEED_PROMPT)
})
