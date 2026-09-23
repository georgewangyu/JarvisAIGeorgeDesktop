import { atom } from 'nanostores'

// An in-memory presentation request, never a reset of provider credentials,
// chats, onboarding decisions, or macOS permissions.
export const $consumerSetupReview = atom(false)

export function openConsumerSetupReview(): void {
  $consumerSetupReview.set(true)
}

export function closeConsumerSetupReview(): void {
  $consumerSetupReview.set(false)
}
