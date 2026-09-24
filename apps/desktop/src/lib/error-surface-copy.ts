// Resolves the error card's title/body for a failed turn from the i18n tables
// (`assistant.thread.errorCodes` / `errorAuthKinds` / `errorLayers`), so the
// inline card and the global gateway-error toast read the same words for the
// same failure. Sibling of error-surface.ts because i18n/types.ts imports the
// code list from there — importing Translations back would be a cycle.

import type { ErrorCardCopy, Translations } from '@/i18n/types'

import { errorCardKey, type ErrorSurface, isFreeTierSurface } from './error-surface'

export interface ErrorCardText {
  title: string
  body: string
}

const render = (value: ErrorCardCopy['title'], provider: string) =>
  typeof value === 'function' ? value(provider) : value

/** The failing provider's display name for copy — the descriptor's label,
 *  else its id, else the generic "the AI service". */
export function errorProviderName(thread: Translations['assistant']['thread'], surface?: ErrorSurface | null): string {
  return surface?.providerLabel || surface?.provider || thread.errorGenericProvider
}

export function errorCardText(
  thread: Translations['assistant']['thread'],
  surface: ErrorSurface | null | undefined,
  brand?: 'jarvis'
): ErrorCardText {
  const provider = errorProviderName(thread, surface)
  const providerMarker = '\uE000provider\uE001'
  const providerForCopy = brand === 'jarvis' ? providerMarker : provider

  // Only the app-owned translation mentions the legacy desktop name. Keep
  // error details and provider-returned sentences untouched.
  const ownCopy = ({ body, title }: ErrorCardText): ErrorCardText => brand === 'jarvis'
    ? {
        body: body.replace(/\bHermes\b/g, 'Jarvis').replaceAll(providerMarker, provider),
        title: title.replace(/\bHermes\b/g, 'Jarvis').replaceAll(providerMarker, provider)
      }
    : { body, title }

  // A credential rejection is worded by HOW the provider is credentialed
  // (key vs sign-in), which the code alone (`auth`) cannot tell.
  if (surface?.layer === 'auth' && surface.authKind === 'oauth') {
    return ownCopy({ body: thread.errorOauthExpired(providerForCopy), title: render(thread.errorAuthKinds.oauth.title, providerForCopy) })
  }

  if (surface?.layer === 'auth' && surface.authKind === 'api_key') {
    const copy = thread.errorAuthKinds.api_key

    return ownCopy({ body: render(copy.body, providerForCopy), title: render(copy.title, providerForCopy) })
  }

  const key = errorCardKey(surface)

  if ('code' in key) {
    const copy = thread.errorCodes[key.code]

    // A free-tier refusal arrives with the backend's own sentence (the wait, the
    // model, the way forward); the table body is only the fallback for an older backend.
    const translated = ownCopy({ body: render(copy.body, providerForCopy), title: render(copy.title, providerForCopy) })

    return isFreeTierSurface(surface) && surface?.message
      ? { ...translated, body: surface.message }
      : translated
  }

  return ownCopy({ body: thread.errorLayerBodies[key.layer], title: thread.errorLayers[key.layer] })
}
