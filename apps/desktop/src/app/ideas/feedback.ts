import { readJson, readKey, writeKey } from '@/lib/storage'

import { IDEA_IDS } from './catalog'

export type IdeaFeedback = 'saved' | 'done' | 'not-interested'
export type IdeaFeedbackById = Record<string, IdeaFeedback>

const STORAGE_PREFIX = 'jarvis.desktop.ideaFeedback.v1'
const FEEDBACK = new Set<IdeaFeedback>(['saved', 'done', 'not-interested'])
const GOAL_ID = /^goal(?:-review)?:[A-Za-z0-9_-]{1,128}$/

function validIdeaId(id: string): boolean {
  return IDEA_IDS.has(id) || GOAL_ID.test(id)
}

export function ideaFeedbackKey(profile: string, connectionId: null | string): string {
  const connectionScope = connectionId === null ? 'local' : `remote.${encodeURIComponent(connectionId.trim())}`

  return `${STORAGE_PREFIX}.profile.${encodeURIComponent(profile.trim() || 'default')}.connection.${connectionScope}`
}

function validFeedback(value: unknown): value is IdeaFeedback {
  return typeof value === 'string' && FEEDBACK.has(value as IdeaFeedback)
}

export function readIdeaFeedback(profile: string, connectionId: null | string): IdeaFeedbackById {
  let value = readJson<unknown>(ideaFeedbackKey(profile, connectionId))
  const legacyRemoteId = connectionId?.trim()

  // Older remote keys omitted the prefix. The literal ID "local" aliases the
  // local owner's key, so never infer ownership from that ambiguous legacy key.
  if (value === null && legacyRemoteId && legacyRemoteId !== 'local') {
    value = readJson<unknown>(`${STORAGE_PREFIX}.profile.${encodeURIComponent(profile.trim() || 'default')}.connection.${encodeURIComponent(legacyRemoteId)}`)
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value).filter(([id, feedback]) => validIdeaId(id) && validFeedback(feedback))
  )
}

/** Best-effort device-local preference. A failed write is reported so the UI never claims it stuck. */
export function setIdeaFeedback(
  profile: string,
  connectionId: null | string,
  ideaId: string,
  feedback: IdeaFeedback | null
): boolean {
  if (!validIdeaId(ideaId) || (feedback !== null && !validFeedback(feedback))) {
    return false
  }

  const key = ideaFeedbackKey(profile, connectionId)
  const next = { ...readIdeaFeedback(profile, connectionId) }

  if (feedback === null) {
    delete next[ideaId]
  } else {
    next[ideaId] = feedback
  }

  // A remote empty object shadows its legacy key so clearing feedback cannot
  // bring an old choice back on the next read.
  const serialized = Object.keys(next).length || connectionId !== null ? JSON.stringify(next) : null
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

export function dropIdeaFeedbackForProfile(profile: string): void {
  writeKey(ideaFeedbackKey(profile, null), null)
}
