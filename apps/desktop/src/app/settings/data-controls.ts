import { getHermesConfigDefaults, getHermesConfigRecord, saveHermesConfig } from '@/hermes'

/** Footer actions follow the same explicit profile selection as config editing. */
export async function exportSettingsConfig(profile?: string): Promise<void> {
  const config = await getHermesConfigRecord(profile)
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)

  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'jarvis-config.json'
    anchor.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function restoreDefaultSettings(profile?: string): Promise<void> {
  const defaults = await getHermesConfigDefaults()
  const result = await saveHermesConfig(defaults, profile)

  if (!result.ok) {
    throw new Error('The backend refused to restore default settings')
  }
}
