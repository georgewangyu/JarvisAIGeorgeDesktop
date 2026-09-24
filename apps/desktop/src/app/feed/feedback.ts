import { readJson, readKey, writeKey } from '@/lib/storage'

const PREFIX = 'jarvis.desktop.feedLoved.v1'

export function feedLovedKey(profile: string, connectionId: null | string): string {
  const connectionScope = connectionId === null ? 'local' : `remote.${encodeURIComponent(connectionId.trim())}`

  return `${PREFIX}.profile.${encodeURIComponent(profile.trim() || 'default')}.connection.${connectionScope}`
}

export function readLovedFeedRuns(profile: string, connectionId: null | string): string[] {
  const key = feedLovedKey(profile, connectionId)
  let value = readJson<unknown>(key)

  // Earlier builds stored ordinary remote choices without a remote prefix.
  // The literal remote ID "local" is ambiguous with local data, so it must
  // never inherit that legacy key. A new [] value shadows a legacy choice.
  const legacyRemoteId = connectionId?.trim()

  if (value === null && legacyRemoteId && legacyRemoteId !== 'local') {
    const legacyKey = `${PREFIX}.profile.${encodeURIComponent(profile.trim() || 'default')}.connection.${encodeURIComponent(legacyRemoteId)}`
    value = readJson<unknown>(legacyKey)
  }

  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 500) : []
}

/** Feedback is stored on this device only; it does not affect ranking or model training. */
export function setFeedRunLoved(profile: string, connectionId: null | string, runId: string, loved: boolean): boolean {
  if (!runId.trim()) {return false}

  const key = feedLovedKey(profile, connectionId)
  const next = new Set(readLovedFeedRuns(profile, connectionId))

  if (loved) {next.add(runId)}
  else {next.delete(runId)}

  // Keep an empty list as a tombstone so an older remote key cannot restore a
  // choice that the user explicitly cleared after upgrading.
  const serialized = JSON.stringify([...next].slice(-500))
  writeKey(key, serialized)

  return readKey(key) === serialized
}
