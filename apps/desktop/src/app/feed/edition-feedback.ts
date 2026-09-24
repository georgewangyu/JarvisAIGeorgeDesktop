import { readJson, readKey, writeKey } from '@/lib/storage'

const PREFIX = 'jarvis.desktop.feedEditionLoved.v1'

export function feedEditionLovedKey(profile: string, connectionId: null | string): string {
  const connectionScope = connectionId === null ? 'local' : `remote.${encodeURIComponent(connectionId.trim())}`

  return `${PREFIX}.profile.${encodeURIComponent(profile.trim() || 'default')}.connection.${connectionScope}`
}

export function readLovedFeedEditions(profile: string, connectionId: null | string): string[] {
  const value = readJson<unknown>(feedEditionLovedKey(profile, connectionId))

  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 500)
    : []
}

/** Device-local feedback only; it does not affect generation or ranking. */
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
