import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { type FeedEdition, generateFeedEdition, getFeedEditions } from '@/api/feed'
import { MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { useJarvisCopy } from '@/i18n/jarvis'
import { ExternalLink } from '@/lib/external-link'
import { stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $activeGatewayProfile, requestFreshSession } from '@/store/profile'
import { $connection } from '@/store/session'

import {
  feedEditionLovedKey, feedStoryId, feedStoryLovedKey, readLovedFeedEditions,
  readLovedFeedStories, setFeedEditionLoved, setFeedStoryLoved
} from './feed/edition-feedback'
import { type FeedEditionItem, parseFeedEditionItems } from './feed/edition-items'
import { groupFeedEditionsByDay } from './feed/group-editions'
import { readFeedPrompt, saveFeedPrompt } from './feed/prompt'
import { CONNECTIONS_ROUTE, NEW_CHAT_ROUTE } from './routes'

type FeedCopy = ReturnType<typeof useJarvisCopy>['feed']

function feedFailureCopy(item: FeedEdition, copy: FeedCopy): string {
  if (item.error?.includes('[blocked_config]')) {
    return copy.blocked
  }

  if (item.status === 'denied') {
    return copy.denied
  }

  if (item.status === 'interrupted') {
    return copy.interruptedError
  }

  return copy.failedError
}

function feedRetrievalCopy(item: FeedEdition, url: string, copy: FeedCopy): string {
  const retrieved = item.source_events?.some(event =>
    event.tool === 'web_extract' && event.requested_url === url && event.result_url === url &&
    typeof event.tool_call_id === 'string' && event.tool_call_id.length > 0
  )

  return retrieved ? copy.retrieved : copy.notRetrieved
}

function feedDayLabel(day: { key: string; editions: FeedEdition[] }, locale: string, copy: FeedCopy): string {
  return day.key === 'unknown'
    ? copy.dateUnavailable
    : new Date(day.editions[0].created_at).toLocaleDateString(locale, { day: 'numeric', month: 'long', weekday: 'long', year: 'numeric' })
}

function FeedEditionContent({ content, editionId, lovedStoryIds, onDiscussItem, onLoveItem }: {
  content: string
  editionId: string
  lovedStoryIds: string[]
  onDiscussItem: (item: FeedEditionItem) => void
  onLoveItem: (index: number) => void
}) {
  const { feed, storyLove } = useJarvisCopy()
  const parsed = parseFeedEditionItems(content)

  if (!parsed) {
    return <div className="mt-3 text-sm leading-7"><MarkdownTextContent isRunning={false} previewOnly text={content} /></div>
  }

  return <div className="mt-4 space-y-4">
    {parsed.introduction ? <div className="text-sm leading-7"><MarkdownTextContent isRunning={false} previewOnly text={parsed.introduction} /></div> : null}
    <p className="text-xs font-medium text-(--ui-text-tertiary)">{feed.storyCount(parsed.items.length)}</p>
    <p className="text-xs text-(--ui-text-tertiary)">{storyLove.disclosure}</p>
    <ol aria-label={feed.storiesLabel} className="space-y-3">
      {parsed.items.map((story, index) => <li className="rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary) p-5" key={`${index}-${story.title}`}>
        <section aria-label={story.title}>
          <p className="text-xs font-medium text-(--ui-text-tertiary)">{feed.storyNumber(index + 1)}</p>
          <h4 className="mt-2 text-base font-semibold leading-snug text-(--ui-text-primary)">{story.title}</h4>
          <div className="mt-3 text-sm leading-7"><MarkdownTextContent isRunning={false} previewOnly text={story.body} /></div>
          <div className="mt-3 flex items-center gap-3">
            <Button
              aria-label={`${lovedStoryIds.includes(feedStoryId(editionId, index)) ? storyLove.loved : storyLove.love} ${story.title}`}
              aria-pressed={lovedStoryIds.includes(feedStoryId(editionId, index))}
              onClick={() => onLoveItem(index)}
              size="sm"
              variant="text"
            >{lovedStoryIds.includes(feedStoryId(editionId, index)) ? storyLove.loved : storyLove.love}</Button>
            <Button aria-label={feed.discussStory(story.title)} onClick={() => onDiscussItem(story)} size="sm" variant="textStrong">{feed.discuss}</Button>
          </div>
        </section>
      </li>)}
    </ol>
  </div>
}

export function ConsumerFeedEditions() {
  const { feed, storyLove } = useJarvisCopy()
  const { locale } = useI18n()
  const navigate = useNavigate()
  const profile = useStore($activeGatewayProfile)
  const connection = useStore($connection)
  const connectionId = connection?.mode === 'remote' ? (connection.connectionId || connection.baseUrl) : null
  const scope = feedEditionLovedKey(profile, connectionId)
  const activeScope = useRef(scope)
  activeScope.current = scope
  const [promptSnapshot, setPromptSnapshot] = useState(() => ({ scope, value: readFeedPrompt(profile, connectionId) }))
  const prompt = promptSnapshot.scope === scope ? promptSnapshot.value : readFeedPrompt(profile, connectionId)
  const [editingPrompt, setEditingPrompt] = useState(false)
  const [promptDraft, setPromptDraft] = useState(prompt)
  const [promptError, setPromptError] = useState(false)
  const [lovedSnapshot, setLovedSnapshot] = useState(() => ({ scope, ids: readLovedFeedEditions(profile, connectionId) }))
  const lovedEditions = lovedSnapshot.scope === scope ? lovedSnapshot.ids : readLovedFeedEditions(profile, connectionId)
  const storyScope = feedStoryLovedKey(profile, connectionId)
  const [lovedStorySnapshot, setLovedStorySnapshot] = useState(() => ({ scope: storyScope, ids: readLovedFeedStories(profile, connectionId) }))
  const lovedStories = lovedStorySnapshot.scope === storyScope ? lovedStorySnapshot.ids : readLovedFeedStories(profile, connectionId)
  const [feedbackError, setFeedbackError] = useState(false)
  const [snapshot, setSnapshot] = useState<{ items: FeedEdition[]; scope: string }>({ items: [], scope })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | { kind: 'load' | 'generate'; prompt?: string; retry?: FeedEdition }>(null)
  const [refresh, setRefresh] = useState(0)
  const items = snapshot.scope === scope ? snapshot.items : []
  const generating = items.some(item => item.status === 'generating')

  useEffect(() => {
    setPromptSnapshot({ scope, value: readFeedPrompt(profile, connectionId) })
    setPromptDraft(readFeedPrompt(profile, connectionId))
    setPromptError(false)
    setEditingPrompt(false)
    setLovedSnapshot({ scope, ids: readLovedFeedEditions(profile, connectionId) })
    setLovedStorySnapshot({ scope: storyScope, ids: readLovedFeedStories(profile, connectionId) })
    setFeedbackError(false)
    setBusy(false)
    setError(null)
  }, [connectionId, profile, scope, storyScope])

  useEffect(() => {
    let cancelled = false

    setLoading(true)
    void getFeedEditions(profile)
      .then(editions => {
        if (!cancelled) {
          setSnapshot({ items: editions, scope })
          setError(null)
        }
      })
      .catch(() => {
        if (!cancelled) {setError({ kind: 'load' })}
      })
      .finally(() => {
        if (!cancelled) {setLoading(false)}
      })

    return () => { cancelled = true }
  }, [connectionId, profile, refresh, scope])

  useEffect(() => {
    if (!generating || loading) {return}

    // Only poll while an explicitly requested edition is running. Idle Feed
    // has no timer, network churn or model calls.
    const timer = window.setTimeout(() => setRefresh(value => value + 1), 2000)

    return () => window.clearTimeout(timer)
  }, [generating, loading, refresh])

  const generate = async (retry?: FeedEdition, failedPrompt?: string) => {
    const text = retry?.prompt ?? failedPrompt ?? prompt.trim()

    if (!text || busy || generating) {return}

    setBusy(true)
    setError(null)

    try {
      const validStoryIds = retry ? [] : lovedStories.filter(id => /^[0-9a-f]{32}:(0|[1-9]|1[01])$/.test(id)).slice(-5)
      const edition = await generateFeedEdition(profile, text, retry?.id, retry ? [] : lovedEditions, validStoryIds)

      if (activeScope.current !== scope) {return}

      setSnapshot(current => ({
        items: [edition, ...(current.scope === scope ? current.items : []).filter(item => item.id !== edition.id)],
        scope
      }))
    } catch {
      if (activeScope.current === scope) {
        setError({
          kind: 'generate',
          prompt: text,
          retry
        })
      }
    } finally {
      if (activeScope.current === scope) {setBusy(false)}
    }
  }

  const editPrompt = () => {
    setPromptDraft(prompt)
    setPromptError(false)
    setEditingPrompt(true)
  }

  const savePrompt = () => {
    if (!saveFeedPrompt(profile, connectionId, promptDraft)) {
      setPromptError(true)

      return
    }

    setPromptSnapshot({ scope, value: promptDraft.trim() })
    setEditingPrompt(false)
    setPromptError(false)
  }

  const toggleLove = (editionId: string) => {
    const loved = !lovedEditions.includes(editionId)

    if (!setFeedEditionLoved(profile, connectionId, editionId, loved)) {
      setFeedbackError(true)

      return
    }

    setLovedSnapshot({ scope, ids: readLovedFeedEditions(profile, connectionId) })
    setFeedbackError(false)
  }

  const toggleStoryLove = (editionId: string, index: number) => {
    const loved = !lovedStories.includes(feedStoryId(editionId, index))

    if (!setFeedStoryLoved(profile, connectionId, editionId, index, loved)) {
      setFeedbackError(true)

      return
    }

    setLovedStorySnapshot({ scope: storyScope, ids: readLovedFeedStories(profile, connectionId) })
    setFeedbackError(false)
  }

  const discuss = (edition: FeedEdition, selectedItem?: FeedEditionItem) => {
    if (!edition.content) {return}

    const current = takeSessionDraft(null)
    const context = selectedItem ? `## ${selectedItem.title}\n\n${selectedItem.body}` : edition.content
    const next = `Help me think through this Feed ${selectedItem ? 'item' : 'edition'}:\n\n${context.slice(0, 4000)}`

    stashSessionDraft(null, current.text.trim() ? `${current.text.trimEnd()}\n\n${next}` : next, current.attachments)
    requestFreshSession()
    navigate(NEW_CHAT_ROUTE)
  }

  return (
    <section aria-label={feed.title} className="space-y-5">
      <div className="rounded-3xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary) px-6 py-6 shadow-sm">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-(--ui-text-tertiary)">{feed.instructionsTitle}</h2>
        <p className="mt-5 whitespace-pre-wrap text-base leading-7 text-(--ui-text-primary)">{prompt}</p>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-(--ui-text-tertiary)">{feed.reviewNotice}</span>
          <div className="flex gap-2">
            <Button onClick={editPrompt} size="sm" variant="secondary">{feed.edit}</Button>
            <Button disabled={busy || generating} onClick={() => void generate()} size="sm">
              {busy || generating ? feed.generating : feed.generate}
            </Button>
          </div>
        </div>
        <p className="mt-4 text-xs text-(--ui-text-tertiary)">{feed.loveNotice}</p>
      </div>
      <Dialog onOpenChange={setEditingPrompt} open={editingPrompt}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{feed.dialogTitle}</DialogTitle>
            <DialogDescription>{feed.dialogDetail}</DialogDescription>
          </DialogHeader>
          <label className="text-sm font-medium" htmlFor="feed-generation-prompt">{feed.promptLabel}</label>
          <textarea
            className="min-h-40 w-full resize-y rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary) p-4 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-primary"
            id="feed-generation-prompt"
            maxLength={8000}
            onChange={event => setPromptDraft(event.target.value)}
            value={promptDraft}
          />
          {promptError && <p className="text-sm text-destructive" role="alert">{feed.savePromptError}</p>}
          <DialogFooter>
            <Button onClick={() => setEditingPrompt(false)} variant="secondary">{feed.cancel}</Button>
            <Button disabled={!promptDraft.trim() || promptDraft.trim() === prompt} onClick={savePrompt}>{feed.save}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {error && <div className="flex items-center gap-3 text-sm text-destructive" role="alert">
        <span>{error.kind === 'load' ? feed.loadError : feed.generateError}</span>
        <Button
          disabled={busy || generating}
          onClick={() => error.kind === 'load' ? setRefresh(value => value + 1) : void generate(error.retry, error.prompt)}
          size="sm"
          variant="text"
        >
          {error.kind === 'load' ? feed.retryLoad : feed.retry}
        </Button>
      </div>}
      {feedbackError && <p className="text-sm text-destructive" role="alert">{storyLove.saveError}</p>}
      {loading && items.length === 0 ? <p className="text-sm text-(--ui-text-tertiary)" role="status">{feed.loading}</p> : null}
      {!loading && items.length === 0 && !error ? <p className="text-sm text-(--ui-text-tertiary)">{feed.empty}</p> : null}
      {groupFeedEditionsByDay(items).map(day => (
        <section aria-label={feedDayLabel(day, locale, feed)} className="pt-4" key={day.key}>
          <h2 className="border-b border-(--ui-stroke-tertiary) pb-3 text-xs font-semibold uppercase tracking-[0.14em] text-(--ui-text-tertiary)">{feedDayLabel(day, locale, feed)}</h2>
          <div className="divide-y divide-(--ui-stroke-tertiary)">
            {day.editions.map(item => (
              <article className="py-7 first:pt-6" key={item.id}>
                <div className="flex items-center justify-between gap-4 text-xs text-(--ui-text-tertiary)">
                  <span className="font-medium">{feed.briefing}</span>
                  <span>{item.status === 'generating' ? feed.working : item.status === 'completed' ? feed.ready : item.status === 'interrupted' ? feed.interrupted : item.status === 'denied' ? feed.needsAccess : feed.failed}</span>
                </div>
                <h3 className="mt-3 line-clamp-2 text-xl font-semibold leading-snug tracking-tight text-(--ui-text-primary)">{item.prompt}</h3>
                {(item.feedback_applied_count ?? 0) > 0 ? <p className="mt-2 text-xs text-(--ui-text-tertiary)">{feed.guidedBy(item.feedback_applied_count ?? 0)}</p> : null}
                {item.status === 'completed' && item.content ? <>
                  <p className="mt-4 text-xs text-(--ui-text-tertiary)">{feed.sourcesCaveat}</p>
                  {item.source_urls.length > 0 ? <div className="mt-2 text-xs text-(--ui-text-tertiary)">
                    <p>{feed.linksIntro}</p>
                    <ul aria-label={feed.linksLabel} className="mt-1 list-inside list-disc break-all">
                      {item.source_urls.map(url => <li key={url}><ExternalLink href={url}>{url}</ExternalLink> — {feedRetrievalCopy(item, url, feed)}</li>)}
                    </ul>
                  </div> : null}
                  {/* Generated prose is passive until the user chooses a listed source.
                      Rich transcript links fetch titles and embeds on mount. */}
                  <FeedEditionContent
                    content={item.content}
                    editionId={item.id}
                    lovedStoryIds={lovedStories}
                    onDiscussItem={selected => discuss(item, selected)}
                    onLoveItem={index => toggleStoryLove(item.id, index)}
                  />
                </> : null}
                {item.status === 'generating' ? <p className="mt-5 text-sm text-(--ui-text-secondary)" role="status">{feed.preparing}</p> : null}
                {(item.status === 'failed' || item.status === 'interrupted' || item.status === 'denied') && <p className="mt-5 text-sm text-destructive" role="alert">{feedFailureCopy(item, feed)}</p>}
                <div className="mt-5 flex gap-3">
                  {item.status === 'completed' && <Button aria-pressed={lovedEditions.includes(item.id)} onClick={() => toggleLove(item.id)} size="sm" variant="text">{lovedEditions.includes(item.id) ? feed.loved : feed.love}</Button>}
                  {item.status === 'completed' && <Button onClick={() => discuss(item)} size="sm" variant="textStrong">{feed.discuss}</Button>}
                  {(item.status === 'failed' || item.status === 'interrupted' || item.status === 'denied') && <Button disabled={busy || generating} onClick={() => void generate(item)} size="sm" variant="textStrong">{feed.retry}</Button>}
                  {(item.status === 'failed' || item.status === 'denied') && item.error?.includes('[blocked_config]') && <Button onClick={() => navigate(CONNECTIONS_ROUTE)} size="sm" variant="text">{feed.connections}</Button>}
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </section>
  )
}
