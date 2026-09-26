import { readJson, readKey, writeKey } from '@/lib/storage'

const PREFIX = 'jarvis.desktop.feedEditionLoved.v1'
const STORY_PREFIX = 'jarvis.desktop.feedStoryLoved.v1'

export function feedEditionLovedKey(profile: string, connectionId: null | string): string {
  const connectionScope = connectionId === null ? 'local' : `remote.${encodeURIComponent(connectionId.trim())}`

  return `${PREFIX}.profile.${encodeURIComponent(profile.trim() || 'default')}.connection.${connectionScope}`
}

export function feedStoryLovedKey(profile: string, connectionId: null | string): string {
  return feedEditionLovedKey(profile, connectionId).replace(PREFIX, STORY_PREFIX)
}

export function feedStoryId(editionId: string, index: number): string {
  return `${editionId}:${index}`
}

export function readLovedFeedEditions(profile: string, connectionId: null | string): string[] {
  const value = readJson<unknown>(feedEditionLovedKey(profile, connectionId))

  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 500)
    : []
}

/** Device-local feedback sent to the backend only on a deliberate Generate. */
export function setFeedEditionLoved(profile: string, connectionId: null | string, editionId: string, loved: boolean): boolean {
  if (!editionId.trim()) {return false}

  const key = feedEditionLovedKey(profile, connectionId)
  const next = new Set(readLovedFeedEditions(profile, connectionId))

  if (loved) {next.add(editionId)}
  else {next.delete(editionId)}

  const serialized = JSON.stringify([...next].slice(-500))
  writeKey(key, serialized)

  return readKey(key) === serialized
}

/** Story Love is device-local and never included in generation requests. */
export function readLovedFeedStories(profile: string, connectionId: null | string): string[] {
  const value = readJson<unknown>(feedStoryLovedKey(profile, connectionId))

  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 500)
    : []
}

export function setFeedStoryLoved(
  profile: string, connectionId: null | string, editionId: string, index: number, loved: boolean
): boolean {
  if (!editionId.trim() || !Number.isInteger(index) || index < 0 || index >= 12) {return false}

  const key = feedStoryLovedKey(profile, connectionId)
  const id = feedStoryId(editionId, index)
  const next = new Set(readLovedFeedStories(profile, connectionId))

  if (loved) {next.add(id)}
  else {next.delete(id)}

  const serialized = JSON.stringify([...next].slice(-500))
  writeKey(key, serialized)

  return readKey(key) === serialized
}
