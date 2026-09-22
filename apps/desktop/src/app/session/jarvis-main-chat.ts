import type { SessionInfo } from '@/hermes'

/**
 * The consumer shell has one durable, human-facing conversation. Its exact
 * title is the registry key, mirroring Hermes' proven canonical-chat pattern
 * without exposing profiles, workers, or gateway concepts in the UI.
 */
export const JARVIS_MAIN_CHAT_TITLE = 'Jarvis'

export function isJarvisMainChat(session: Pick<SessionInfo, 'title'>): boolean {
  return session.title?.trim() === JARVIS_MAIN_CHAT_TITLE
}
