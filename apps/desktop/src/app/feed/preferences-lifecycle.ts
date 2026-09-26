import { readKey, writeKey } from '@/lib/storage'

import { feedEditionLovedKey, feedStoryLovedKey, readLovedFeedEditions, readLovedFeedStories } from './edition-feedback'
import { feedLovedKey, readLovedFeedRuns } from './feedback'
import { feedPromptKey } from './prompt'

/** A local profile rename must not strand its device-local Feed preferences. */
export function migrateFeedPreferencesForProfile(oldProfile: string, newProfile: string): void {
  if (oldProfile.trim() === newProfile.trim()) {return}

  const oldPrompt = feedPromptKey(oldProfile, null)
  const newPrompt = feedPromptKey(newProfile, null)

  if (oldPrompt === newPrompt) {return}

  const prompt = readKey(oldPrompt)

  if (prompt !== null) {
    const existing = readKey(newPrompt)

    if (existing === null) {writeKey(newPrompt, prompt)}

    if (readKey(newPrompt) === (existing ?? prompt)) {writeKey(oldPrompt, null)}
  }

  for (const [keyFor, readIds] of [
    [feedLovedKey, readLovedFeedRuns],
    [feedEditionLovedKey, readLovedFeedEditions],
    [feedStoryLovedKey, readLovedFeedStories]
  ] as const) {
    const source = keyFor(oldProfile, null)
    const target = keyFor(newProfile, null)
    const existing = readKey(source)

    if (existing === null) {continue}

    const merged = JSON.stringify([...new Set([...readIds(newProfile, null), ...readIds(oldProfile, null)])].slice(-500))
    writeKey(target, merged)

    if (readKey(target) === merged) {writeKey(source, null)}
  }
}

/** Remove only local Feed preferences; same-named remote profiles are independent. */
export function dropFeedPreferencesForProfile(profile: string): void {
  for (const key of [feedPromptKey(profile, null), feedLovedKey(profile, null), feedEditionLovedKey(profile, null), feedStoryLovedKey(profile, null)]) {
    writeKey(key, null)
  }
}
