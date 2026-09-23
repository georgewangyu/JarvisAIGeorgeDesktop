import { type ArtifactRecord, collectArtifactsForSession } from '@/app/artifacts/artifact-utils'
import { getAllSessionMessages, listAllProfileSessions, type SessionInfo } from '@/hermes'
import { isMessagingSource, normalizeSessionSource } from '@/lib/session-source'
import { normalize } from '@/lib/text'

export interface LibrarySearchHit {
  artifact: ArtifactRecord
  session: SessionInfo
}

const PAGE_SIZE = 30

export function matchingLibraryHits(hits: LibrarySearchHit[], query: string): LibrarySearchHit[] {
  const needle = normalize(query)

  if (!needle) {
    return []
  }

  return hits.filter(({ artifact }) =>
    [artifact.label, artifact.value, artifact.sessionTitle].some(value => normalize(value).includes(needle))
  )
}

/** Read the same saved transcripts as Library, one at a time. The caller owns cancellation. */
export async function scanLibrary(
  isCancelled: () => boolean,
  onPage: (hits: LibrarySearchHit[], failedReads: number) => void
): Promise<void> {
  let offset = 0
  let failedReads = 0

  while (!isCancelled()) {
    const page = await listAllProfileSessions(PAGE_SIZE, 1, 'exclude', 'recent', 'all', {}, offset)
    const hits: LibrarySearchHit[] = []

    for (const session of page.sessions) {
      if (isCancelled()) {
        return
      }

      const source = normalizeSessionSource(session.source)

      // Only user-facing conversations can produce a Search result. Workers,
      // cron internals and tool transcripts must remain behind their owner UI.
      if (session.archived || isMessagingSource(source) ||
          ['cron', 'kanban', 'oneshot', 'subagent', 'tool'].includes(source ?? '')) {
        continue
      }

      try {
        const { messages } = await getAllSessionMessages(session.id, session.profile)

        if (isCancelled()) {
          return
        }

        hits.push(...collectArtifactsForSession(session, messages).map(artifact => ({ artifact, session })))
      } catch {
        failedReads += 1
      }
    }

    if (isCancelled()) {
      return
    }

    onPage(hits, failedReads)
    offset += page.sessions.length

    // A short page is valid at the end, while an empty page must always stop.
    if (page.sessions.length === 0 || offset >= page.total) {
      return
    }
  }
}
