const JARVIS_ORIGIN = /^(?:https:\/\/github\.com\/|git@github\.com:)georgewangyu\/JarvisAIGeorgeDesktop(?:\.git)?\/?$/i

/** A packaged Jarvis app must not silently attach to an unrelated Hermes CLI. */
export function mayReuseDiscoveredHermes(isPackaged: boolean, ignoreExisting: boolean): boolean {
  return !isPackaged && !ignoreExisting
}

/** A managed checkout may be reused only when it belongs to this app's fork. */
export function isJarvisRuntimeOrigin(origin: string | null | undefined): boolean {
  return JARVIS_ORIGIN.test(origin?.trim() ?? '')
}
