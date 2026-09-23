import { afterEach, expect, it } from 'vitest'

import { ideaFeedbackKey, migrateIdeaFeedbackForProfile, readIdeaFeedback, setIdeaFeedback } from './feedback'

afterEach(() => window.localStorage.clear())

it('persists reversible choices per profile and connection across a fresh read', () => {
  expect(setIdeaFeedback('default', null, 'plan-day', 'saved')).toBe(true)
  expect(setIdeaFeedback('default', null, 'catch-up', 'done')).toBe(true)
  expect(readIdeaFeedback('default', null)).toEqual({ 'plan-day': 'saved', 'catch-up': 'done' })
  expect(readIdeaFeedback('other', null)).toEqual({})
  expect(readIdeaFeedback('default', 'remote-1')).toEqual({})

  expect(setIdeaFeedback('default', null, 'plan-day', null)).toBe(true)
  expect(readIdeaFeedback('default', null)).toEqual({ 'catch-up': 'done' })
})

it('ignores unknown or malformed persisted choices and rejects unknown idea ids', () => {
  window.localStorage.setItem(ideaFeedbackKey('default', null), JSON.stringify({ 'plan-day': 'saved', retired: 'done', 'catch-up': 'invalid' }))
  expect(readIdeaFeedback('default', null)).toEqual({ 'plan-day': 'saved' })
  expect(setIdeaFeedback('default', null, 'unknown', 'done')).toBe(false)
  window.localStorage.setItem(ideaFeedbackKey('other', null), 'not json')
  expect(readIdeaFeedback('other', null)).toEqual({})
})

it('moves local preferences on profile rename without touching a remote profile of the same name', () => {
  setIdeaFeedback('before', null, 'plan-day', 'saved')
  setIdeaFeedback('after', null, 'catch-up', 'done')
  setIdeaFeedback('before', 'remote-1', 'plan-day', 'not-interested')

  migrateIdeaFeedbackForProfile('before', 'after')

  expect(readIdeaFeedback('after', null)).toEqual({ 'plan-day': 'saved', 'catch-up': 'done' })
  expect(readIdeaFeedback('before', null)).toEqual({})
  expect(readIdeaFeedback('before', 'remote-1')).toEqual({ 'plan-day': 'not-interested' })
})

it('does not report success when device storage rejects a write', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage')

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => { throw new Error('storage unavailable') }, removeItem: () => {} }
  })

  try {
    expect(setIdeaFeedback('default', null, 'plan-day', 'saved')).toBe(false)
    expect(readIdeaFeedback('default', null)).toEqual({})
  } finally {
    if (original) {
      Object.defineProperty(window, 'localStorage', original)
    }
  }
})
