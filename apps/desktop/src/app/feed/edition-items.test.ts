import { expect, it } from 'vitest'

import { parseFeedEditionItems } from './edition-items'

it('recognizes complete explicit story sections and preserves the introduction', () => {
  expect(parseFeedEditionItems('Today\'s briefing.\n\n## First story\nFirst details.\n\n## Second story\nSecond details.')).toEqual({
    introduction: "Today's briefing.",
    items: [
      { title: 'First story', body: 'First details.' },
      { title: 'Second story', body: 'Second details.' }
    ]
  })
})

it('keeps legacy, incomplete and code-fenced output as one briefing', () => {
  expect(parseFeedEditionItems('A complete older briefing.')).toBeNull()
  expect(parseFeedEditionItems('## One story\nBody.')).toBeNull()
  expect(parseFeedEditionItems('## First\nBody.\n## Second\n')).toBeNull()
  expect(parseFeedEditionItems('~~~md\n## Not a story\n~~~\n## Only story\nBody.')).toBeNull()
  expect(parseFeedEditionItems('````md\n## Not a story\n```\n## Still fenced\n````\n## Only story\nBody.')).toBeNull()
})
