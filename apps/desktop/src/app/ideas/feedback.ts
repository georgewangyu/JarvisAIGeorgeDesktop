import { readJson, readKey, writeKey } from '@/lib/storage'

import { IDEA_IDS } from './catalog'

export type IdeaFeedback = 'saved' | 'done' | 'not-interested'
export type IdeaFeedbackById = Record<string, IdeaFeedback>

const STORAGE_PREFIX = 'jarvis.desktop.ideaFeedback.v1'
const FEEDBACK = new Set<IdeaFeedback>(['saved', 'done', 'not-interested'])

export function ideaFeedbackKey(profile: string, connectionId: null | string): string {
  return `${STORAGE_PREFIX}.profile.${encodeURIComponent(profile.trim() || 'default')}.connection.${encodeURIComponent(connectionId?.trim() || 'local')}`
}

function validFeedback(value: unknown): value is IdeaFeedback {
  return typeof value === 'string' && FEEDBACK.has(value as IdeaFeedback)
}

export function readIdeaFeedback(profile: string, connectionId: null | string): IdeaFeedbackById {
  const value = readJson<unknown>(ideaFeedbackKey(profile, connectionId))

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value).filter(([id, feedback]) => IDEA_IDS.has(id) && validFeedback(feedback))
  )
}

/** Best-effort device-local preference. A failed write is reported so the UI never claims it stuck. */
export function setIdeaFeedback(
  profile: string,
  connectionId: null | string,
  ideaId: string,
  feedback: IdeaFeedback | null
): boolean {
  if (!IDEA_IDS.has(ideaId) || (feedback !== null && !validFeedback(feedback))) {
    return false
  }

  const key = ideaFeedbackKey(profile, connectionId)
  const next = { ...readIdeaFeedback(profile, connectionId) }

  if (feedback === null) {
    delete next[ideaId]
  } else {
    next[ideaId] = feedback
  }

  const serialized = Object.keys(next).length ? JSON.stringify(next) : null
  writeKey(key, serialized)

  return readKey(key) === serialized
}

/** Profile rename moves only local-connection preferences; a remote profile belongs to its own server. */
export function migrateIdeaFeedbackForProfile(oldProfile: string, newProfile: string): void {
  const source = ideaFeedbackKey(oldProfile, null)
  const target = ideaFeedbackKey(newProfile, null)

  if (source === target) {
    return
  }

  const existing = readIdeaFeedback(oldProfile, null)

  if (Object.keys(existing).length === 0) {
    return
  }

  const merged = { ...existing, ...readIdeaFeedback(newProfile, null) }
  const serialized = JSON.stringify(merged)
  writeKey(target, serialized)

  if (readKey(target) === serialized) {
    writeKey(source, null)
  }
}
