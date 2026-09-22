import { describe, expect, it } from 'vitest'

import { TRANSLATIONS } from './catalog'

const ENGINE_TERMS =
  /Hermes|gateway|backend|IPC|ゲートウェイ|バックエンド|网关|后端|閘道|後端|шлюз|бэкенд|البوابة المحلية|الخلفية/i

describe('consumer startup recovery copy', () => {
  it.each(Object.entries(TRANSLATIONS))('%s keeps engine terminology behind the recovery boundary', (_locale, t) => {
    const visibleCopy = Object.values(t.boot.failure).map(value =>
      typeof value === 'function' ? (value as (label: string) => string)('OpenAI') : value
    )

    expect(visibleCopy.join('\n')).not.toMatch(ENGINE_TERMS)
  })
})
