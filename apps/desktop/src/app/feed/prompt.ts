import { readKey, writeKey } from '@/lib/storage'

export const DEFAULT_FEED_PROMPT = 'Give me a concise briefing about what matters today. Use only information and sources you can actually access. Identify sources when available; if there is not enough information, say so.'

const STORAGE_PREFIX = 'jarvis.desktop.feedPrompt.v1'
const MAX_PROMPT_LENGTH = 8000

export function feedPromptKey(profile: string, connectionId: null | string): string {
  const connectionScope = connectionId === null ? 'local' : `remote.${encodeURIComponent(connectionId.trim())}`

  return `${STORAGE_PREFIX}.profile.${encodeURIComponent(profile.trim() || 'default')}.connection.${connectionScope}`
}

export function readFeedPrompt(profile: string, connectionId: null | string): string {
  const value = readKey(feedPromptKey(profile, connectionId))

  return value && value.trim() && value.length <= MAX_PROMPT_LENGTH ? value : DEFAULT_FEED_PROMPT
}

export function saveFeedPrompt(profile: string, connectionId: null | string, value: string): boolean {
  const prompt = value.trim()

  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {return false}

  const key = feedPromptKey(profile, connectionId)
  writeKey(key, prompt)

  return readKey(key) === prompt
}
