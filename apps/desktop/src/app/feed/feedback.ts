import { readJson, readKey, writeKey } from '@/lib/storage'

const PREFIX = 'jarvis.desktop.feedLoved.v1'

export function feedLovedKey(profile: string, connectionId: null | string): string {
  return `${PREFIX}.profile.${encodeURIComponent(profile.trim() || 'default')}.connection.${encodeURIComponent(connectionId?.trim() || 'local')}`
}

export function readLovedFeedRuns(profile: string, connectionId: null | string): string[] {
  const value = readJson<unknown>(feedLovedKey(profile, connectionId))

  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 500) : []
}

/** Feedback is stored on this device only; it does not affect ranking or model training. */
export function setFeedRunLoved(profile: string, connectionId: null | string, runId: string, loved: boolean): boolean {
  if (!runId.trim()) {return false}

  const key = feedLovedKey(profile, connectionId)
  const next = new Set(readLovedFeedRuns(profile, connectionId))

  if (loved) {next.add(runId)}
  else {next.delete(runId)}

  const serialized = next.size ? JSON.stringify([...next].slice(-500)) : null
  writeKey(key, serialized)

  return readKey(key) === serialized
}
