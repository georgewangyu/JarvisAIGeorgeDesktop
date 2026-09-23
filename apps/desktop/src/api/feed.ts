import { connectionScoped, hermesApi, profileScoped } from './client'

export interface FeedEdition {
  attempt: number
  content: null | string
  created_at: string
  error: null | string
  finished_at: null | string
  id: string
  prompt: string
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

export async function generateFeedEdition(profile: string, prompt: string, retryId?: string): Promise<FeedEdition> {
  const result = await hermesApi<{ edition: FeedEdition }>({
    ...profileScoped(),
    ...connectionScoped(),
    body: { prompt, ...(retryId ? { retry_id: retryId } : {}) },
    method: 'POST',
    path: `/api/feed/editions?profile=${encodeURIComponent(profile)}`
  })

  return result.edition
}
