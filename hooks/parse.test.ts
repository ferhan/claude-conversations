import { expect, test } from 'claude-code/testing'

import { apply, file, gist, labelled, letters, parts, relabel, mint, parseAnswer, rebuild, WITHDRAWN } from './parse'

const ANSWER = [
  '[thread:a] Thread A: the migration plan is ready.',
  '',
  '```thread-item',
  'kind: decision',
  'key: merge-strategy',
  'title: Merge strategy for the release branch',
  'description: Squash keeps history linear; a flag lets QA run both paths.',
  'options:',
  '  - a: Squash',
  '  - b: Ship behind flag',
  'recommendation: b',
  'refs: [https://example.com/notes/1]',
  '```',
  '',
  '```text',
  '[thread:z] inside a fence: not a section',
  '```',
  '[thread:b] closed',
].join('\n')

test('parser: two sections, one decision, one closed verb', () => {
  const { sections, closes } = parseAnswer(ANSWER)
  expect(sections.map(s => s.thread)).toEqual(['a', 'b'])
  expect(sections[0]!.text.startsWith('Thread A: the migration plan is ready.')).toBe(true)
  expect(sections[0]!.text.includes('thread-item')).toBe(false)
  expect(sections[0]!.text.includes('[thread:z] inside a fence')).toBe(true)
  expect(sections[0]!.decisions).toEqual([
    {
      key: 'merge-strategy',
      title: 'Merge strategy for the release branch',
      description: 'Squash keeps history linear; a flag lets QA run both paths.',
      options: [
        { id: 'a', label: 'Squash' },
        { id: 'b', label: 'Ship behind flag' },
      ],
      recommendation: 'b',
      refs: ['https://example.com/notes/1'],
      answered: null,
    },
  ])
  expect(sections[1]!.verb).toBe('closed')
  expect(closes).toEqual(['b'])
})

test('apply: cards land in their section thread, close closes, ids mint a..z, aa', () => {
  const { threads, fresh } = apply([], ANSWER)
  expect(threads.map(t => [t.id, t.cards.length, t.closed])).toEqual([
    ['a', 1, false],
    ['b', 0, true],
  ])
  expect(fresh.length).toBe(1)
  expect([letters(0), letters(25), letters(26)]).toEqual(['a', 'z', 'aa'])
})

test('rebuild: user prompt opens and titles the thread; minting continues after the highest id', () => {
  const rows = [
    { role: 'user', text: '[thread:a] fix the build' },
    { role: 'assistant', text: '[thread:a] on it' },
  ]
  const one = rebuild(rows)
  expect(one.map(t => [t.id, t.title, t.sections.length])).toEqual([['a', 'fix the build', 1]])
  const two = rebuild([...rows, { role: 'user', text: '[thread:b] second' }])
  expect(mint(two)).toBe('c')
  expect(mint(rebuild([{ role: 'user', text: '[thread:b] x' }]))).toBe('c')
})

test('answered: a decide prompt survives rebuild; same options keep it, new options reopen', () => {
  const ask = '[thread:a] q\n```thread-item\nkind: decision\nkey: k\ntitle: T\noptions:\n  - a: A\n  - b: B\n```'
  const done = rebuild([
    { role: 'assistant', text: ask },
    { role: 'user', text: '[thread:a] decide: k a (A)' },
  ])
  expect(done[0]!.cards[0]!.answered).toBe('a')
  const same = apply(done, ask)
  expect([same.threads[0]!.cards[0]!.answered, same.fresh.length]).toEqual(['a', 0])
  const changed = apply(done, ask.replace('  - b: B', '  - c: C'))
  expect([changed.threads[0]!.cards[0]!.answered, changed.fresh.length]).toEqual([null, 1])
})

test('untagged text belongs to no thread, live and on rebuild', () => {
  const mixed = ['The band fixes are in and should have reloaded.', '', '[thread:ab] band answer', '[thread:ac] count answer'].join('\n')
  const seed = rebuild([
    { role: 'user', text: '[thread:ab] band' },
    { role: 'user', text: '[thread:ac] count' },
  ])
  const live = apply(seed, mixed).threads
  expect(live.map(t => [t.id, t.sections])).toEqual([
    ['ab', ['band answer']],
    ['ac', ['count answer']],
  ])
  expect(apply(seed, 'no tag at all').threads.every(t => t.sections.length === 0)).toBe(true)
  const rows = [
    { role: 'user', text: '[thread:ac] count' },
    { role: 'assistant', text: 'untagged lead' },
    { role: 'user', text: 'a prompt with no tag' },
    { role: 'assistant', text: mixed },
  ]
  expect(rebuild(rows).map(t => [t.id, t.sections])).toEqual([
    ['ac', ['count answer']],
    ['ab', ['band answer']],
  ])
})

test('rebuild: a decide prompt wrapped by the engine still marks its card answered', () => {
  const card = (k: string) => `\`\`\`thread-item\nkind: decision\nkey: ${k}\ntitle: Continue?\noptions:\n  - a: Continue\n  - b: Stop\n\`\`\``
  const wrap = (t: string) => `The conversations plugin sent a message:\n${t}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns.`
  const list = rebuild([
    { role: 'user', text: '[thread:ac] count' },
    { role: 'assistant', text: `[thread:ac] reached 10\n${card('k1')}` },
    { role: 'user', text: wrap('[thread:ac] decide: k1 a (Continue)') },
    { role: 'assistant', text: '[thread:ac] resolved' },
    { role: 'assistant', text: `[thread:ac] reached 20\n${card('k2')}` },
    { role: 'user', text: wrap('[thread:ac] decide: k2 a (Continue)') },
    { role: 'assistant', text: '[thread:ac] resolved' },
  ])
  expect(list[0]!.cards.map(c => [c.key, c.answered])).toEqual([
    ['k1', 'a'],
    ['k2', 'a'],
  ])
  expect(list[0]!.title).toBe('count')
})

const item = (lines: string[]) => ['```thread-item', ...lines, '```'].join('\n')
const NOTE = (id: string, desc: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Agent "${desc}" finished</summary>\n<result>done</result>\n</task-notification>`
const HANDBACK = (id: string) => `Another Claude session sent a message:\n<agent-message from="${id}">\n[Subagent hand-back] The fix is in.\n</agent-message>`

test('thread item: an untagged reply opens a thread with title, body and agent; the same key does not open a second', () => {
  const ask = item(['kind: thread', 'key: fix-login', 'title: Fix the login timeout', 'body: Agent started on the timeout', 'agent: Fix the login timeout'])
  const one = apply([{ id: 'a', title: 'x', key: '', sections: [], cards: [], closed: false }], `Starting the work.\n${ask}`).threads
  expect(one.map(t => [t.id, t.title, t.agent, t.sections])).toEqual([
    ['a', 'x', undefined, []],
    ['b', 'Fix the login timeout', 'Fix the login timeout', ['Agent started on the timeout']],
  ])
  expect(apply(one, `[thread:a] again\n${ask}`).threads).toHaveLength(2)
})

test('agents: a notification binds by description and is filed; a hand-back before it binds through the Agent tool use', () => {
  const open = item(['kind: thread', 'key: w', 'title: Work', 'agent: Rework the pane'])
  const rows = [
    { role: 'assistant', text: open, toolUses: [{ tool: 'Agent', input: { description: 'Rework the pane' }, agentId: 'ag1' }] },
    { role: 'user', text: HANDBACK('ag1') },
    { role: 'user', text: NOTE('ag1', 'Rework the pane') },
    { role: 'user', text: NOTE('ag2', 'Something else') },
  ]
  expect(rebuild(rows).map(t => [t.id, t.agentIds, t.sections])).toEqual([['a', ['ag1'], ['Report from agent "Rework the pane"', 'Agent "Rework the pane" finished']]])
  // Live, with no tool use seen: the notification alone binds it.
  const live = file(rebuild([{ role: 'assistant', text: open }]), NOTE('ag9', 'Rework the pane'))
  expect([live.thread?.id, live.thread?.agentIds]).toEqual(['a', ['ag9']])
  expect(file(live.threads, HANDBACK('ag9')).thread?.sections).toEqual(['Agent "Rework the pane" finished', 'Report from agent "Rework the pane"'])
  expect(file(live.threads, HANDBACK('nobody')).thread).toBeUndefined()
})

test('unfiled decision: opens a thread from its key and title; the same key joins it; an untagged decide answers it on rebuild', () => {
  const ask = item(['kind: decision', 'key: g', 'title: General?', 'options:', '  - a: Yes', '  - b: No'])
  const rows = [
    { role: 'assistant', text: `General question.\n${ask}` },
    { role: 'user', text: 'The conversations plugin sent a message:\ndecide: g a (Yes)' },
  ]
  const live = apply([], `General question.\n${ask}`)
  expect(live.threads.map(t => [t.id, t.key, t.title, t.cards.map(c => c.key)])).toEqual([['a', 'g', 'General?', ['g']]])
  expect(live.threads.some(t => !t.id)).toBe(false) // nothing in No thread
  expect(live.fresh).toHaveLength(1)
  const again = apply(live.threads, ask.replace('  - b: No', '  - c: Later'))
  expect(again.threads.map(t => [t.id, t.cards.map(c => c.key)])).toEqual([['a', ['g']]])
  expect(again.threads[0]!.cards[0]!.options.map(o => o.id)).toEqual(['a', 'c'])
  expect(rebuild(rows)[0]!.cards[0]!.answered).toBe('a')
})

test('unfiled decision: a closed thread with the key is not reused; a tagged section still wins', () => {
  const ask = item(['kind: decision', 'key: g', 'title: General?', 'options:', '  - a: Yes'])
  const shut = { id: 'q', title: 'G', key: 'g', sections: [], cards: [], closed: true }
  expect(apply([shut], ask).threads.map(t => [t.id, t.cards.map(c => c.key)])).toEqual([['q', []], ['r', ['g']]])
  expect(apply([], `[thread:ab] hi\n${ask}`).threads.map(t => t.id)).toEqual(['ab'])
  // a later thread item with that key reaches the open thread, not the closed one
  const out = apply([shut], `${ask}\n${item(['kind: thread', 'key: g', 'title: G', 'body: B'])}`).threads
  expect(out.map(t => [t.id, t.sections])).toEqual([['q', []], ['r', ['B']]])
})

test('unfiled decision: a valid thread: key is unchanged and opens nothing new', () => {
  const ask = item(['kind: decision', 'key: g', 'title: General?', 'thread: x', 'options:', '  - a: Yes'])
  const x = { id: 'q', title: 'X', key: 'x', sections: [], cards: [], closed: false }
  const out = apply([x], ask).threads
  expect(out.map(t => [t.id, t.cards.map(c => c.key)])).toEqual([['q', ['g']]])
})

test('withdrawn: a decision retired live and on rebuild; new options reopen it', () => {
  const ask = item(['kind: decision', 'key: u', 'title: Untagged?', 'options:', '  - a: A', '  - b: B'])
  const rows = [
    { role: 'user', text: '[thread:ad] distribute' },
    { role: 'assistant', text: `[thread:ad] question\n${ask}` },
    { role: 'assistant', text: '[thread:ad] superseded by the new plan\n[thread:ad] withdrawn u' },
  ]
  const t = rebuild(rows)[0]!
  expect(t.cards[0]!.answered).toBe(WITHDRAWN)
  expect(t.sections).toEqual(['question', 'superseded by the new plan']) // the withdrawn line is no reply text
  expect(apply(rebuild(rows), `[thread:ad] again\n${ask}`).threads[0]!.cards[0]!.answered).toBe(WITHDRAWN)
  expect(apply(rebuild(rows), `[thread:ad] again\n${ask.replace('  - b: B', '  - c: C')}`).threads[0]!.cards[0]!.answered).toBe(null)
})

test('withdrawn: a bare line inside a tagged section is only text', () => {
  const ask = item(['kind: decision', 'key: g', 'title: General?', 'options:', '  - a: Yes'])
  const out = apply(apply([], ask).threads, '[thread:ab] note\nwithdrawn g').threads
  expect(out.find(t => t.key === 'g')!.cards[0]!.answered).toBe(null)
  expect(out.find(t => t.id === 'ab')!.sections).toEqual(['note\nwithdrawn g'])
})

test('gist: the status skips protocol-only lines and falls back to the previous reply', () => {
  expect(gist(['first reply', 'resolved\n\nThe count is running from 11 to 20.'])).toBe('The count is running from 11 to 20.')
  expect(gist(['earlier news', 'resolved', 'stale.', '', '[thread:ad]', 'withdrawn untagged-decisions\nclosed'])).toBe('earlier news')
  expect(gist(['[thread:ad] resolved'])).toBe('')
  expect(gist(['resolved the flaky test'])).toBe('resolved the flaky test')
})

test('rebuild: an operator prompt to a closed thread reopens it; a delivery the mod tagged does not', () => {
  const rows = [
    { role: 'user', text: '[thread:c] old work' },
    { role: 'assistant', text: '[thread:c] done\n[thread:c] closed' },
  ]
  const note = { role: 'user', text: '[thread:c] <task-notification>\n<task-id>x</task-id>\n</task-notification>' }
  expect(rebuild([...rows, note])[0]!.closed).toBe(true)
  expect(rebuild([...rows, { role: 'user', text: '[thread:c] back to this' }])[0]!.closed).toBe(false)
})

test('parts: text, thread-item blocks with titles, other fences left in the text, an unclosed block stays text', () => {
  const card = ['```thread-item', 'kind: thread', 'key: w', 'title: Work', '```'].join('\n')
  expect(parts(`one\n\n${card}\n\`\`\`ts\nx\n\`\`\`\ntwo`)).toEqual([{ text: 'one' }, { title: 'Work', block: card }, { text: '```ts\nx\n```\ntwo' }])
  expect(parts('a\n```thread-item\ntitle: T')).toEqual([{ text: 'a' }, { text: '```thread-item\ntitle: T' }])
})

test('labelled and relabel: display splits by tag lines, fences kept whole', () => {
  expect(labelled('lead\n[thread:ab] resolved\nafter\n[thread:b] body\nmore')).toEqual([
    { id: null, text: 'lead', verb: false },
    { id: 'ab', text: 'resolved', verb: true },
    { id: null, text: 'after', verb: false },
    { id: 'b', text: 'body\nmore', verb: false },
  ])
  expect(labelled('```\n[thread:a] x\n```')).toEqual([{ id: null, text: '```\n[thread:a] x\n```', verb: false }])
  expect(relabel('[thread:ab] hi\n  [thread:c] there\nnot [thread:d] here')).toBe('Thread AB · hi\n  Thread C · there\nnot [thread:d] here')
})

test('decision thread: names a thread by key, including one opened in the same reply; an unknown or closed key falls back to the section', () => {
  const open = item(['kind: thread', 'key: x', 'title: New topic'])
  const ask = (t: string) => item(['kind: decision', 'key: d', 'title: Pick', 'thread: ' + t, 'options:', '  - a: One'])
  const named = apply([], `${open}\n${ask('x')}`).threads
  expect(named.filter(t => t.key).map(t => [t.id, t.key, t.cards.map(c => c.key)])).toEqual([['a', 'x', ['d']]])
  expect(named.some(t => !t.id)).toBe(false)
  expect(named[0]!.cards[0] ?? named[1]!.cards[0]).not.toHaveProperty('thread')
  const q = { id: 'q', title: 'Q', key: 'q', sections: [], cards: [], closed: false }
  const lost = apply([q], `[thread:q] hi\n${ask('nope')}`).threads
  expect(lost.map(t => [t.id, t.cards.map(c => c.key)])).toEqual([['q', ['d']]])
  const shut = apply([{ ...q, closed: true }], `[thread:a] hi\n${ask('q')}`).threads
  expect(shut.map(t => [t.id, t.cards.map(c => c.key)])).toEqual([['q', []], ['a', ['d']]])
})

test('decision thread: an untagged withdrawn <key> retires a decision placed on a model-opened thread; order of sections is as without thread:', () => {
  const open = item(['kind: thread', 'key: x', 'title: New topic'])
  const ask = item(['kind: decision', 'key: d', 'title: Pick', 'thread: x', 'options:', '  - a: One'])
  const one = apply([], `${open}\n${ask}`).threads
  expect(apply(one, 'withdrawn d').threads.find(t => t.key === 'x')!.cards.map(c => c.answered)).toEqual([WITHDRAWN])
  const body = item(['kind: thread', 'key: ka', 'title: K', 'body: B'])
  const a = { id: 'a', title: 'A', key: 'ka', sections: [], cards: [], closed: false }
  expect(apply([a], `[thread:a] hi\n${body}`).threads[0]!.sections).toEqual(['hi', 'B'])
})
