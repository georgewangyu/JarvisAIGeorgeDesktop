/**
 * User-facing copy for a failed first-run install (bootstrap).
 *
 * The install runner reports the manifest stage name that failed (see
 * electron/bootstrap-runner.ts and the stage manifests in scripts/install.ps1 /
 * scripts/install.sh) plus the raw error text. This module turns that into an
 * Error.message the install overlay can show verbatim: a plain lead sentence
 * naming the step in everyday words and what to do next, with the raw error on
 * a trailing "Details:" line.
 *
 * Pure module: no Electron imports, unit-tested next to it.
 */

/** Manifest stage name -> everyday label. Unknown names fall back to humanizeStageName. */
export const BOOTSTRAP_STAGE_LABELS: ReadonlyMap<string, string> = new Map([
  // scripts/install.ps1 manifest
  ['uv', 'Package installer'],
  ['git', 'Git'],
  ['node', 'Node.js'],
  ['system-packages', 'System packages'],
  ['repository', 'Hermes source code'],
  ['python', 'Python runtime'],
  ['venv', 'Python environment'],
  ['dependencies', 'Python packages'],
  ['node-deps', 'Browser tool packages'],
  ['desktop', 'Desktop app build'],
  ['platform-sdks', 'Platform tools'],
  ['configure', 'Settings'],
  ['config-templates', 'Settings templates'],
  ['path', 'Hermes command'],
  ['gateway', 'Hermes service'],
  ['bootstrap-marker', 'Finishing touches'],
  // scripts/install.sh manifest (names that differ from the Windows one)
  ['prerequisites', 'System prerequisites'],
  ['python-deps', 'Python packages'],
  ['config', 'Settings'],
  ['setup', 'Settings'],
  ['complete', 'Finishing touches']
])

/** `system-packages` -> `System packages`. */
export function humanizeStageName(stage: string): string {
  const words = stage.replace(/[-_]+/g, ' ').trim()

  return words ? words.charAt(0).toUpperCase() + words.slice(1) : ''
}

export function bootstrapStageLabel(stage: string | null | undefined): string | null {
  if (!stage) {
    return null
  }

  return BOOTSTRAP_STAGE_LABELS.get(stage) ?? humanizeStageName(stage)
}

const BOOTSTRAP_FAILURE_REMEDY =
  'Common causes: no internet connection, antivirus blocking setup, or another copy of Jarvis running. ' +
  'Close other Jarvis windows and choose Reload and retry; if it fails again, open the logs and send them to support.'

/**
 * Build the Error.message for a failed bootstrap. First line is the plain
 * explanation; the raw error follows on its own "Details:" line.
 */
export function describeBootstrapFailure(failedStage: string | null | undefined, rawError: unknown): string {
  const details = typeof rawError === 'string' && rawError.trim() ? rawError.trim() : 'unknown error'

  if (/Failed to download install\.(?:sh|ps1): GitHub API HTTP 404\b/.test(details)) {
    return (
      'Jarvis could not find the installer for this exact app build. This preview may use a revision that is not yet published or no longer available. ' +
      'Install the latest published build, or ask the person who provided this preview to publish its matching revision before retrying.\n' +
      `Details: ${details}`
    )
  }

  const label = bootstrapStageLabel(failedStage)

  const lead = label
    ? `Setting up Jarvis stopped during the '${label}' step.`
    : 'Setting up Jarvis stopped before it could finish.'

  return `${lead} ${BOOTSTRAP_FAILURE_REMEDY}\nDetails: ${details}`
}

/**
 * Error.message for an installed Hermes with a piece missing (source tree,
 * Python environment). The renderer's install overlay offers the Repair Jarvis
 * button ('hermes:bootstrap:repair'), so the copy points there. `whatIsMissing`
 * names the missing part and its path, e.g. "Python environment missing at /x".
 */
export function missingInstallPartMessage(whatIsMissing: string): string {
  return (
    'Part of Jarvis is missing (it may have been deleted or quarantined by antivirus). ' +
    'Choose Repair Jarvis below to put it back — your chats and settings are not affected. ' +
    `Details: ${whatIsMissing}`
  )
}
