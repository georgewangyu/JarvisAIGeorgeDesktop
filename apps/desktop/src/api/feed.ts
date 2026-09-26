import { connectionScoped, hermesApi, profileScoped } from './client'

export interface FeedEdition {
  attempt: number
  content: null | string
  created_at: string
  error: null | string
  feedback_applied_count?: number
  finished_at: null | string
  id: string
  prompt: string
  retrieved_source_urls?: string[]
  source_events?: Array<{
    tool_call_id: string
    tool: 'web_extract'
    requested_url: string
    result_url: string
  }>
  source_urls: string[]
  source_urls_verified: false
  status: 'completed' | 'denied' | 'failed' | 'generating' | 'interrupted'
}

export async function getFeedEditions(profile: string): Promise<FeedEdition[]> {
  const result = await hermesApi<{ editions: FeedEdition[] }>({
    ...profileScoped(),
    ...connectionScoped(),
    path: `/api/feed/editions?profile=${encodeURIComponent(profile)}&limit=20`
  })

  return result.editions ?? []
}

export async function generateFeedEdition(
  profile: string, prompt: string, retryId?: string, likedEditionIds: string[] = [], likedStoryIds: string[] = []
): Promise<FeedEdition> {
  const result = await hermesApi<{ edition: FeedEdition }>({
    ...profileScoped(),
    ...connectionScoped(),
    body: {
      prompt, ...(retryId ? { retry_id: retryId } : {}),
      liked_edition_ids: likedEditionIds.slice(0, 5),
      liked_story_ids: likedStoryIds.slice(0, 5)
    },
    method: 'POST',
    path: `/api/feed/editions?profile=${encodeURIComponent(profile)}`
  })

  return result.edition
}
