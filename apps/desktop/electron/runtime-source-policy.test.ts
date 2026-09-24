import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isJarvisRuntimeOrigin, mayReuseDiscoveredHermes } from './runtime-source-policy'

test('a packaged Jarvis app does not silently reuse an arbitrary Hermes CLI', () => {
  assert.equal(mayReuseDiscoveredHermes(true, false), false)
  assert.equal(mayReuseDiscoveredHermes(true, true), false)
  assert.equal(mayReuseDiscoveredHermes(false, false), true)
  assert.equal(mayReuseDiscoveredHermes(false, true), false)
})

test('managed runtime provenance requires the exact Jarvis fork origin', () => {
  assert.equal(isJarvisRuntimeOrigin('https://github.com/georgewangyu/JarvisAIGeorgeDesktop.git'), true)
  assert.equal(isJarvisRuntimeOrigin('git@github.com:georgewangyu/JarvisAIGeorgeDesktop.git'), true)
  assert.equal(isJarvisRuntimeOrigin('https://github.com/NousResearch/hermes-agent.git'), false)
  assert.equal(isJarvisRuntimeOrigin('https://github.com/georgewangyu/JarvisAIGeorgeDesktop-malicious.git'), false)
  assert.equal(isJarvisRuntimeOrigin('https://github.com.attacker.test/georgewangyu/JarvisAIGeorgeDesktop'), false)
  assert.equal(isJarvisRuntimeOrigin(null), false)
})
