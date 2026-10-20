import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type $T = Parameters<TestBody>[0]
type OnT = Parameters<TestBody>[1]

const PANE = {
  plugin: 'conversations',
  component: 'Pane',
  requestId: 'thread-pane',
  surface: 'terminal',
  props: { title: 'Threads', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const DECISION = ['```thread-item', 'kind: decision', 'key: k1', 'title: Pick one', 'options:', '  - a: Yes', '  - b: No', 'recommendation: a', '```'].join('\n')

// Thread A asks a decision, thread B has a result, thread C is closed.
const ROWS = [
  { role: 'user', text: '[thread:a] decide the thing' },
  { role: 'assistant', text: `[thread:a] need you\n${DECISION}` },
  { role: 'user', text: '[thread:b] run the build' },
  { role: 'assistant', text: '[thread:b] build is green' },
  { role: 'user', text: '[thread:c] old work' },
  { role: 'assistant', text: '[thread:c] done\n[thread:c] closed' },
]

const start = async ($: $T, on: OnT, rows = () => ROWS, panes: () => { id: string }[] = () => []) => {
  on('command.register', () => ({ value: { command: 'thread' } }))
  on('session.messages', () => ({ value: rows() }) as never)
  on('ui.panes', () => ({ value: panes() }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

const reply = ($: $T, answer: string) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

test('/thread list: one markdown list item per thread', async ($, on) => {
  await start($, on)
  const r = await $.command.run({ command: 'thread', args: 'list', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const lines = (r.text ?? '').split('\n')
  expect(lines).toHaveLength(3)
  expect(lines.every(l => l.startsWith('- Thread '))).toBe(true)
  expect(lines[0]).toBe('- Thread A  decide the thing  [●]')
  expect(lines[2]).toBe('- Thread C  old work  [closed]')
})

test('pane: decision first, result with ack, closed hidden; ack hides, new reply returns', async ($, on) => {
  await start($, on)
  let ui = await $.ui.mount(PANE)
  const heads = (await ui.findAll({ type: 'Text', text: /^Thread / })).map(x => x.text)
  expect(heads).toEqual(['Thread A · decide the thing', 'Thread B · run the build'])
  expect(await ui.find({ key: 'opt:a:k1:a' })).toBeDefined()
  expect(await ui.find({ key: 'ack:a' })).toBeUndefined()
  expect(await ui.find({ key: 'ack:c' })).toBeUndefined()

  await ui.press({ key: 'ack:b' })
  expect(await ui.find({ key: 'ack:b' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Thread B/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Thread A/ })).toBeDefined()
  await ui.unmount()

  await reply($, '[thread:b] deploy finished')
  ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'ack:b' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^new: / }))?.text).toBe('new: deploy finished')
  expect(JSON.stringify(await ui.drawn())).not.toContain('Markdown') // no reply stream in the pane
  await ui.unmount()
})

test('decide: answered card hides, stays hidden after a re-register, never sends twice', async ($, on) => {
  const sent: string[] = []
  let rows = ROWS
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await start($, on, () => rows)
  const ui = await $.ui.mount(PANE)
  // Two presses on the same drawn button: only one decide goes out.
  await Promise.all([ui.press({ key: 'opt:a:k1:a' }), ui.press({ key: 'opt:a:k1:a' }).catch(() => undefined)])
  expect(sent).toEqual(['[thread:a] decide: k1 a (Yes)'])
  expect(await ui.find({ key: 'opt:a:k1:a' })).toBeUndefined()
  await ui.unmount()

  // A reload runs session.start again and rebuilds from the transcript, which now holds the decide prompt.
  rows = [...ROWS, { role: 'user', text: sent[0]! }, { role: 'assistant', text: '[thread:a] resolved' }]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const again = await $.ui.mount(PANE)
  expect(await again.find({ key: 'opt:a:k1:a' })).toBeUndefined()
  await again.press({ key: 'opt:a:k1:a' }).catch(() => undefined)
  expect(sent).toHaveLength(1)
  await again.unmount()
})

const BAND = {
  plugin: 'conversations',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 80, scroll: { offset: 0, bodyRows: 7 }, view: {} },
} as const

test('band: one row per open thread with full titles and status; collapse to a summary and back', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ key: 'a' }))?.text).toBe('Thread A  decide the thing  needs answer')
  expect((await ui.find({ key: 'b' }))?.text).toBe('Thread B  run the build  ●')
  expect(await ui.find({ key: 'c' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /\+1 closed/ })).toBeDefined()

  expect((await ui.find({ type: 'Text', text: /^─+$/ }))?.text).toHaveLength(80)
  // Every thread row leads with the same fixed-width cell; only the first holds the − toggle.
  const lead = async (k: string) => (await ui.find({ key: k }))?.children[0] as { props: { width?: number }; children?: unknown[] }
  const [a, b] = [await lead('line:a'), await lead('line:b')]
  expect([a.props.width, b.props.width, b.children?.length ?? 0]).toEqual([5, 5, 0])
  expect(a.children?.length).toBe(1)

  await ui.press({ key: 'collapse' })
  expect(await ui.find({ key: 'a' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /threads/ }))?.text).toBe('2 threads · 1 needs answer · 1 unseen')

  await ui.press({ key: 'expand' })
  expect(await ui.find({ key: 'a' })).toBeDefined()
  await ui.unmount()
})

test('band: a long title is kept whole and cut to the band width with …', async ($, on) => {
  const long = 'wondering how to distribute the mod on the marketplace and in the docs for everyone'
  await start($, on, () => [{ role: 'user', text: `[thread:a] ${long}\nsecond line` }])
  const wide = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 120 } })
  expect((await wide.find({ key: 'a' }))?.text).toBe(`Thread A  ${long}`)
  await wide.unmount()
  const narrow = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 60 } })
  const text = (await narrow.find({ key: 'a' }))?.text ?? ''
  expect(text.endsWith('…')).toBe(true)
  expect(text.length).toBeLessThanOrEqual(60 - 13)
  await narrow.unmount()
})

test('select: band row opens the pane on that thread; none turns it back to the list', async ($, on) => {
  const opened: { title?: string; focus?: true }[] = []
  let open = false
  on('ui.open', (_, e) => {
    opened.push({ title: e.title, focus: e.focus })
    open = true
    return { value: { isPlaced: true } } as never
  })
  await start($, on, () => ROWS, () => (open ? [{ id: 'thread-pane' }] : []))
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'b' })
  expect(opened.at(-1)).toEqual({ title: 'Thread B · run the build', focus: undefined })
  let pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Text', text: /^new: / }))?.text).toBe('new: build is green')
  expect(JSON.stringify(await pane.drawn())).not.toContain('Markdown')
  expect(await pane.find({ key: 'ack:b' })).toBeDefined()
  expect(await pane.find({ key: 'opt:a:k1:a' })).toBeUndefined() // thread A's card is not in thread B's view
  await pane.unmount()

  await band.press({ key: 'a' })
  pane = await $.ui.mount(PANE)
  expect(await pane.find({ key: 'opt:a:k1:a' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^needs answer$/ })).toBeDefined()
  expect(JSON.stringify(await pane.drawn())).not.toContain('need you') // thread A's reply body
  await pane.unmount()

  await band.press({ key: 'none' })
  expect(opened.at(-1)?.title).toBe('Threads')
  pane = await $.ui.mount(PANE)
  expect((await pane.findAll({ type: 'Text', text: /^Thread / })).map(x => x.text)).toEqual(['Thread A · decide the thing', 'Thread B · run the build'])
  await pane.unmount()
  await band.unmount()
})

test('decide: k1 and k2 answered through wrapped decide prompts stay answered in the thread view after a reload', async ($, on) => {
  const card = (k: string) => ['```thread-item', 'kind: decision', `key: ${k}`, 'title: Continue?', 'options:', '  - a: Continue', '  - b: Stop', '```'].join('\n')
  const wrap = (t: string) => `The conversations plugin sent a message:\n${t}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns.`
  const rows = [
    { role: 'user', text: '[thread:ac] count' },
    { role: 'assistant', text: `[thread:ac] reached 10\n${card('k1')}` },
    { role: 'user', text: wrap('[thread:ac] decide: k1 a (Continue)') },
    { role: 'assistant', text: '[thread:ac] resolved' },
    { role: 'assistant', text: `[thread:ac] reached 20\n${card('k2')}` },
    { role: 'user', text: wrap('[thread:ac] decide: k2 a (Continue)') },
    { role: 'assistant', text: '[thread:ac] resolved' },
  ]
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  await start($, on, () => rows) // session.start after a reload: rebuild from the transcript
  await $.command.run({ command: 'thread', args: 'ac', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const ui = await $.ui.mount(PANE)
  // The very first tree drawn holds no option button of an answered key.
  expect(JSON.stringify(await ui.drawn())).not.toContain('opt:ac:')
  expect(await ui.find({ key: 'opt:ac:k1:a' })).toBeUndefined()
  expect(await ui.find({ key: 'opt:ac:k2:a' })).toBeUndefined()
  expect(JSON.stringify(await ui.drawn())).not.toContain('answered:')
  await ui.press({ key: 'opt:ac:k1:a' }).catch(() => undefined)
  expect(sent).toEqual([])
  await ui.unmount()
})

test('live: an untagged lead is not filed under the selected thread', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  await start($, on)
  await $.command.run({ command: 'thread', args: 'b', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await reply($, 'The band fixes are in.\n\n[thread:a] a section')
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^new: / }))?.text).toBe('new: build is green')
  expect(JSON.stringify(await ui.drawn())).not.toContain('band fixes')
  await ui.unmount()
})

test('view: the needs-you list shows a decision from a non-leading section while another thread is selected', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.notify', () => ({ value: {} }) as never)
  await start($, on)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'b' }) // thread B selected: the pane shows thread B
  await reply($, ['[thread:b] No change in this thread.', '', '[thread:d] The count reached 50.', DECISION.replace('key: k1', 'key: k51')].join('\n'))
  await band.press({ key: 'view' })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'opt:d:k51:a' })).toBeDefined()
  expect(await ui.find({ key: 'opt:a:k1:a' })).toBeDefined()
  await ui.unmount()
  await band.unmount()
})

test('pane: status line is the latest reply cut to the width; seen in the thread view leaves no open items', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  const long = 'the deploy finished on every host and the canary stayed green for the whole window'
  await start($, on, () => [...ROWS, { role: 'assistant', text: `[thread:b] ${long}\nsecond line` }])
  const narrow = { ...PANE, props: { ...PANE.props, bodyColumns: 40 } }
  let ui = await $.ui.mount(narrow)
  const status = (await ui.find({ type: 'Text', text: /^new: / }))?.text ?? ''
  expect(status.startsWith('new: the deploy finished')).toBe(true)
  expect(status.endsWith('…')).toBe(true)
  expect(status.length).toBeLessThanOrEqual(40 - 18 + 5)
  await ui.unmount()

  await $.command.run({ command: 'thread', args: 'b', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  ui = await $.ui.mount(PANE)
  await ui.press({ key: 'ack:b' })
  expect(await ui.find({ type: 'Text', text: /^no open items$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^new: / })).toBeUndefined()
  await ui.unmount()
})

const NOTE = (id: string, desc: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "${desc}" finished</summary>\n</task-notification>`
const WORK = ['```thread-item', 'kind: thread', 'key: w', 'title: Rework the pane', 'body: agent started', 'agent: Rework the pane', '```'].join('\n')

test('deliveries: a bound notification is tagged in its text, a hidden hand-back gets the tag as context', async ($, on) => {
  const got: { text: string; context?: readonly string[] }[] = []
  on('prompt.submit', (_, e) => {
    got.push({ text: e.text, context: e.context })
    return { text: e.text }
  })
  let rows: { role: string; text: string; toolUses: unknown[] }[] = [{ role: 'assistant', text: `Starting.\n${WORK}`, toolUses: [] }]
  await start($, on, () => rows as never)
  await $.prompt.submit({ text: NOTE('ag1', 'Rework the pane'), origin: { kind: 'task-notification' } } as never)
  expect(got.at(-1)?.text.startsWith('[thread:a] <task-notification>')).toBe(true)
  // Hand-back from an agent the mod has not bound yet: learned from the Agent tool use in the transcript.
  rows = [...rows, { role: 'assistant', text: '', toolUses: [{ tool: 'Agent', input: { description: 'Rework the pane' }, agentId: 'ag2', tool_use_id: 'x' }] }]
  await $.prompt.submit({ text: 'Another Claude session sent a message:\n<agent-message from="ag2">\nreport\n</agent-message>', origin: { kind: 'peer' }, isMeta: true } as never)
  expect(got.at(-1)?.text.startsWith('Another Claude session')).toBe(true)
  expect(got.at(-1)?.context?.at(-1)).toBe('This message belongs to thread [thread:a]: start your reply with [thread:a].')
  // An unbound delivery is left untagged, whatever thread is selected.
  await $.command.run({ command: 'thread', args: 'a', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }).catch(() => undefined)
  await $.prompt.submit({ text: NOTE('ag3', 'Other work'), origin: { kind: 'task-notification' } } as never)
  expect(got.at(-1)?.text.startsWith('<task-notification>')).toBe(true)
})

test('pane: an untagged decision shows under "No thread" and answers with an untagged decide', async ($, on) => {
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('ui.notify', () => ({ value: {} }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await start($, on, () => [{ role: 'assistant', text: `A general question.\n${DECISION.replace('key: k1', 'key: g')}` }])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^No thread$/ })).toBeDefined()
  await ui.press({ key: 'opt::g:a' })
  expect(sent).toEqual(['decide: g a (Yes)'])
  await ui.unmount()
  const band = await $.ui.mount(BAND) // no thread row: the empty-band hint
  expect((await band.find({ type: 'Text', text: /^No threads/ }))?.text).toBe('No threads · /thread new <message> to start one')
  await band.unmount()
})

test('pane: status skips a protocol-only latest reply', async ($, on) => {
  await start($, on, () => [...ROWS, { role: 'assistant', text: '[thread:b] resolved' }])
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^new: / }))?.text).toBe('new: build is green')
  await ui.unmount()
})

test('everything the mod writes uses the [thread:<id>] tag and the thread-item block', async ($, on) => {
  const written: string[] = []
  on('prompt.compose', () => ({ sections: [] }))
  on('prompt.submit', (_, e) => {
    written.push(e.text, ...(e.context ?? []))
    return { text: e.text }
  })
  on('ui.open', (_, e) => {
    written.push(e.title ?? '')
    return { value: { isPlaced: true } } as never
  })
  on('ui.notify', (_, e) => {
    written.push(JSON.stringify(e))
    return { value: {} } as never
  })
  await start($, on)
  const composed = await $.prompt.compose({
    model: 'm',
    promptModel: 'm',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: { name: 'default', isKeepingCodingInstructions: true },
    traits: [],
  })
  written.push(...composed.sections.map(s => s.text))
  const list = await $.command.run({ command: 'thread', args: 'list', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  written.push(list.text ?? '')
  const band = await $.ui.mount(BAND)
  written.push(JSON.stringify(await band.drawn()))
  await band.press({ key: 'b' })
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false })
  await reply($, `[thread:b] news\n${DECISION.replace('key: k1', 'key: k9')}`)
  await band.press({ key: 'view' })
  const pane = await $.ui.mount(PANE)
  written.push(JSON.stringify(await pane.drawn()))
  await pane.press({ key: 'opt:b:k9:a' })
  await band.unmount()
  await pane.unmount()
  expect(written).toContain('[thread:b] hello')
  expect(written).toContain('[thread:b] decide: k9 a (Yes)')
  expect(written.some(w => w.includes('[thread:<letters>]'))).toBe(true) // the coordinator instructions were captured
  const all = written.join('\n')
  expect([...all.matchAll(/\[[A-Za-z-]+:[a-z]+\]/g)].map(m => m[0]).filter(t => !t.startsWith('[thread:'))).toEqual([])
  expect([...all.matchAll(/\b[a-z]+-item\b/g)].map(m => m[0]).filter(t => t !== 'thread-item')).toEqual([])
})

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

test('/thread new <message> starts and selects a thread with the message as the draft; bare /thread new creates nothing; the band has no + new', async ($, on) => {
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true } as never
  })
  const opened: (string | undefined)[] = []
  on('ui.open', (_, e) => {
    opened.push(e.title)
    return { value: { isPlaced: true } } as never
  })
  await start($, on)
  const bare = await $.command.run({ command: 'thread', args: 'new', ...RUN })
  expect(bare.text).toBe('Usage: /thread new <message>')
  expect([sent, filled]).toEqual([[], []])
  expect((await $.command.run({ command: 'thread', args: 'list', ...RUN })).text?.split('\n')).toHaveLength(3)

  const r = await $.command.run({ command: 'thread', args: 'new Hello there', ...RUN })
  expect(r.text).toBe('Thread D started: press Enter to send.')
  expect(filled).toEqual(['[thread:d] Hello there'])
  expect(sent).toEqual([])
  expect(opened.at(-1)).toBe('Thread D · Hello there')
  const band = await $.ui.mount(BAND)
  expect((await band.find({ key: 'd' }))?.props.variant).toBe('primary') // selected
  expect(await band.find({ key: 'new' })).toBeUndefined()
  expect((await band.findAll({ type: 'Button' })).map(b => b.key).filter(k => k === 'none' || k === 'view')).toEqual(['none', 'view'])
  await band.unmount()
})

test('/thread close: hides threads from band, list status and pane, survives a re-register; unknown ids and both orders', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await start($, on)
  expect((await $.command.run({ command: 'thread', args: 'close A zz', ...RUN })).text).toBe('Thread A closed. No thread ZZ.')
  expect((await $.command.run({ command: 'thread', args: 'b close', ...RUN })).text).toBe('Thread B closed.')
  const check = async () => {
    const list = (await $.command.run({ command: 'thread', args: 'list', ...RUN })).text ?? ''
    expect(list.split('\n').map(l => l.endsWith('[closed]'))).toEqual([true, true, true])
    const pane = await $.ui.mount(PANE)
    expect((await pane.find({ type: 'Text', text: /Nothing needs you/ }))?.text).toBe('Nothing needs you.')
    await pane.unmount()
    const band = await $.ui.mount(BAND) // no open thread and none selected: the band steps aside
    expect((await band.find({ type: 'Text', text: /^No threads/ }))?.text).toBe('No threads · /thread new <message> to start one')
    await band.unmount()
  }
  await check()
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }) // a reload rebuilds from the transcript
  await check()
})

test('a tagged prompt to a closed thread reopens it, live and on rebuild; selecting it reopens it too', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  const typed: { role: string; text: string }[] = []
  on('prompt.submit', (_, e) => {
    typed.push({ role: 'user', text: e.text })
    return { text: e.text }
  })
  await start($, on, () => [...ROWS, ...typed] as never)
  await $.command.run({ command: 'thread', args: 'close a b', ...RUN })
  await $.prompt.submit({ text: '[thread:a] back to this', origin: { kind: 'composer' }, wait: false })
  const open = async () => ((await $.command.run({ command: 'thread', args: 'list', ...RUN })).text ?? '').split('\n').map(l => l.endsWith('[closed]'))
  expect(await open()).toEqual([false, true, true])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(await open()).toEqual([false, true, true])
  // Thread C was closed by the assistant ("[thread:c] closed"); selecting it reopens it.
  expect((await $.command.run({ command: 'thread', args: 'c', ...RUN })).text).toBe('Thread C selected.')
  expect(await open()).toEqual([false, true, false])
  // A delivery the mod tagged does not reopen a closed thread.
  await $.prompt.submit({ text: '[thread:b] <task-notification>\n<task-id>x</task-id>\n</task-notification>', origin: { kind: 'task-notification' }, wait: false } as never)
  expect(await open()).toEqual([false, true, false])
})

test('/thread show-band, hide-band, show-view, hide-view', async ($, on) => {
  const opened: (string | undefined)[] = []
  const closed: string[] = []
  let open = false
  on('ui.open', (_, e) => {
    opened.push(e.title)
    open = true
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)
    open = false
    return { value: {} } as never
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await start($, on, () => ROWS, () => (open ? [{ id: 'thread-pane' }] : []))
  const run = async (args: string) => (await $.command.run({ command: 'thread', args, ...RUN })).text
  const band = async () => {
    const ui = await $.ui.mount(BAND)
    const has = (await ui.find({ key: 'a' })) !== undefined
    await ui.unmount()
    return has
  }
  expect(await band()).toBe(true)
  expect(await run('hide-band')).toBe('Band hidden.')
  expect(await band()).toBe(false)
  expect(await run('show-band')).toBe('Band shown. If it is still hidden, Claude Code collapsed it: press ctrl+x ctrl+a.')
  expect(await band()).toBe(true)

  await run('a') // a thread view first: show-view must turn it to the needs-you list
  expect(await run('show-view')).toBe('View shown.')
  expect(opened.at(-1)).toBe('Threads')
  const pane = await $.ui.mount(PANE)
  expect((await pane.findAll({ type: 'Text', text: /^Thread / })).map(x => x.text)).toEqual(['Thread A · decide the thing', 'Thread B · run the build'])
  await pane.unmount()
  expect(await run('hide-view')).toBe('View hidden.')
  expect(closed).toEqual(['thread-pane'])
  expect(await run('hide-view')).toBe('View hidden.')
  expect(closed).toEqual(['thread-pane']) // already closed: nothing more to close
})

test('pane: Close thread in the thread view only; it closes like /thread close and the pane returns to the list', async ($, on) => {
  const opened: (string | undefined)[] = []
  on('ui.open', (_, e) => {
    opened.push(e.title)
    return { value: { isPlaced: true } } as never
  })
  await start($, on, () => ROWS, () => [{ id: 'thread-pane' }])
  const run = async (args: string) => (await $.command.run({ command: 'thread', args, ...RUN })).text ?? ''
  let pane = await $.ui.mount(PANE)
  expect(await pane.findAll({ type: 'Button', text: /Close thread/ })).toEqual([]) // needs-you list: no Close
  await pane.unmount()

  await run('b')
  pane = await $.ui.mount(PANE)
  expect((await pane.find({ key: 'close:b' }))?.text).toBe('Close thread')
  await pane.press({ key: 'close:b' })
  expect(opened.at(-1)).toBe('Threads')
  expect(await pane.find({ key: 'close:b' })).toBeUndefined()
  expect((await pane.findAll({ type: 'Text', text: /^Thread / })).map(x => x.text)).toEqual(['Thread A · decide the thing'])
  await pane.unmount()

  const closed = async () => (await run('list')).split('\n').map(l => l.endsWith('[closed]'))
  expect(await closed()).toEqual([false, true, true])
  const band = await $.ui.mount(BAND)
  expect(await band.find({ key: 'b' })).toBeUndefined()
  expect((await band.find({ key: 'none' }))?.props.variant).toBe('primary') // the closed selection was dropped
  await band.unmount()
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(await closed()).toEqual([false, true, true])
})

test('band: the empty-band hint shows with no threads, not when hidden, not once a thread exists', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('prompt.fill', () => ({ isFilled: true }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  await start($, on, () => [])
  const run = (args: string) => $.command.run({ command: 'thread', args, ...RUN })
  const text = async () => {
    const ui = await $.ui.mount(BAND)
    const t = (await ui.findAll({ type: 'Text' })).map(x => x.text)
    await ui.unmount()
    return t
  }
  expect(await text()).toEqual(['No threads · /thread new <message> to start one'])
  await run('hide-band')
  expect(await text()).toEqual(['engine'])
  await run('show-band')
  await run('new first')
  expect((await text()).some(t => t.startsWith('No threads'))).toBe(false)
})

const MSG = {
  plugin: 'conversations',
  component: 'AssistantMessage',
  requestId: 'msg1',
  surface: 'terminal',
} as const

test('transcript: a thread-item block draws as one line between the text, opens on a press; the stored reply is unchanged', async ($, on) => {
  on('ui.notify', () => ({ value: {} }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await start($, on)
  const text = `[thread:a] Before the card.\n\n${DECISION}\n\nAfter the card.`
  // The stored reply: turn.complete hands on the answer untouched, and the card still reaches its thread.
  expect((await reply($, text)).text).toBe(text)
  const ui = await $.ui.mount({ ...MSG, props: { text, isFirstOfReply: true } })
  const drawn = async () => ((await ui.drawn()) as { children: { type: string; props: { text?: string } }[] }).children
  let rows = await drawn()
  expect(rows.map(r => r.type)).toEqual(['Box', 'Box', 'Markdown']) // labelled section, the block's line, the text after
  expect(JSON.stringify(rows[0])).toContain('Before the card.')
  expect(rows[2]!.props.text).toBe('After the card.')
  expect((await ui.find({ type: 'Text', text: /^thread-item: / }))?.text).toBe('thread-item: Pick one')
  expect((await ui.find({ key: 'item:msg1:1' }))?.text).toBe('+')
  expect(JSON.stringify(rows)).not.toContain('kind: decision')
  await ui.press({ key: 'item:msg1:1' })
  expect((await ui.find({ key: 'item:msg1:1' }))?.text).toBe('−')
  expect(JSON.stringify(await drawn())).toContain('kind: decision')
  await ui.press({ key: 'item:msg1:1' })
  expect(JSON.stringify(await drawn())).not.toContain('kind: decision')
  await ui.unmount()

  const plain = await $.ui.mount({ ...MSG, requestId: 'msg2', props: { text: 'Just text.\n```ts\nconst x = 1\n```', isFirstOfReply: true } })
  expect((await plain.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine') // no block, no tag: the engine draws its own
  await plain.unmount()
})

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: { name: 'default', isKeepingCodingInstructions: true }, traits: [] } as const
const instructed = async ($: $T) => (await $.prompt.compose({ ...COMPOSE, surfaces: ['terminal'], tools: [], traits: [] })).sections.some(s => s.id === 'conversations:coordinator')

test('instructions: none in a fresh session; on after /thread, a tagged prompt or a thread-item, and they stay on', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  on('prompt.fill', () => ({ isFilled: true }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await start($, on, () => [])
  expect(await instructed($)).toBe(false)
  await $.prompt.submit({ text: 'plain question', origin: { kind: 'composer' }, wait: false })
  await reply($, 'plain answer')
  expect(await instructed($)).toBe(false)
  await $.command.run({ command: 'thread', args: 'list', ...RUN })
  expect(await instructed($)).toBe(true)
  expect(await instructed($)).toBe(true)
})

test('instructions: a tagged prompt turns them on', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await start($, on, () => [])
  await $.prompt.submit({ text: '[thread:q] hello', origin: { kind: 'composer' }, wait: false })
  expect(await instructed($)).toBe(true)
})

test("instructions: the model's thread-item alone does not turn them on; a tagged prompt in a resumed transcript does", async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  on('ui.notify', () => ({ value: {} }) as never)
  let rows: { role: string; text: string; toolUses: unknown[] }[] = []
  await start($, on, () => rows as never)
  await reply($, ['Starting.', '```thread-item', 'kind: thread', 'key: w', 'title: Work', '```', DECISION].join('\n'))
  expect(await instructed($)).toBe(false)
  rows = [{ role: 'user', text: '[thread:a] earlier work', toolUses: [] }]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(await instructed($)).toBe(true)
})

test('transcript labels: a leading tag becomes a dim Thread label, a protocol-only line one dim line; untagged rows pass', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await start($, on)
  const text = 'Lead without a tag.\n[thread:ac] resolved\n\nThe count is running.\n[thread:b] Build is green.\n```text\n[thread:z] inside a fence\n```'
  const ui = await $.ui.mount({ ...MSG, requestId: 'm3', props: { text, isFirstOfReply: true } })
  const texts = (await ui.findAll({ type: 'Text' })).map(x => x.text)
  expect(texts).toEqual(['Thread AC · resolved', 'Thread B ·'])
  const md = JSON.stringify(await ui.drawn())
  expect(md).toContain('Lead without a tag.')
  expect(md).toContain('The count is running.')
  expect(md).toContain('[thread:z] inside a fence')
  expect(md).not.toContain('[thread:ac]')
  expect(md).not.toContain('[thread:b]')
  await ui.unmount()
  const plain = await $.ui.mount({ ...MSG, requestId: 'm4', props: { text: 'No tags here.', isFirstOfReply: true } })
  expect((await plain.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await plain.unmount()
})

test('transcript labels: a user row draws Thread labels in place of line-leading tags; untagged rows pass', async ($, on) => {
  const seen: string[] = []
  on('ui.render', ($, e) => {
    seen.push((e.props as { text: string }).text)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await start($, on)
  const USER = { plugin: 'conversations', component: 'UserMessage', requestId: 'u1', surface: 'terminal' } as const
  const props = (text: string) => ({ text, origin: { kind: 'composer' }, isExpanded: false }) as const
  const a = await $.ui.mount({ ...USER, props: props('[thread:ab] fix the build') })
  await a.unmount()
  const b = await $.ui.mount({ ...USER, requestId: 'u2', props: props('The conversations plugin sent a message:\n[thread:ac] decide: k a (Yes)') })
  await b.unmount()
  const c = await $.ui.mount({ ...USER, requestId: 'u3', props: props('no tag') })
  await c.unmount()
  expect(seen).toEqual(['Thread AB · fix the build', 'The conversations plugin sent a message:\nThread AC · decide: k a (Yes)', 'no tag'])
})

const LOOSE = ['General question.', DECISION.replace('key: k1', 'key: g1'), DECISION.replace('key: k1', 'key: g2')].join('\n')

test('No thread: the band shows a row for open untagged decisions, not the empty hint; list and summary count them; view alias', async ($, on) => {
  on('ui.notify', () => ({ value: {} }) as never)
  const opened: (string | undefined)[] = []
  on('ui.open', (_, e) => {
    opened.push(e.title)
    return { value: { isPlaced: true } } as never
  })
  await start($, on, () => [])
  const run = async (args: string) => (await $.command.run({ command: 'thread', args, ...RUN })).text
  let band = await $.ui.mount(BAND)
  expect((await band.find({ type: 'Text', text: /^No threads/ }))?.text).toBe('No threads · /thread new <message> to start one')
  await band.unmount()
  expect(await run('list')).toBe('No threads.')

  await reply($, LOOSE)
  band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /^No threads/ })).toBeUndefined()
  expect((await band.find({ key: 'loose' }))?.text).toBe('No thread  needs answer')
  expect(await band.find({ key: 'collapse' })).toBeDefined()
  await band.press({ key: 'loose' })
  expect(opened.at(-1)).toBe('Threads')
  await band.press({ key: 'collapse' })
  expect((await band.find({ type: 'Text', text: /threads? ·/ }))?.text).toBe('0 threads · 1 needs answer')
  await band.press({ key: 'expand' })
  await band.unmount()
  expect(await run('list')).toBe('- No thread  [● 2 open]')

  expect(await run('view')).toBe('View shown.')
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: /^No thread$/ })).toBeDefined()
  await pane.unmount()

  // Both answered: the group leaves the band and the list.
  await reply($, 'Done.\nwithdrawn g1\nwithdrawn g2')
  band = await $.ui.mount(BAND)
  expect(await band.find({ key: 'loose' })).toBeUndefined()
  expect((await band.find({ type: 'Text', text: /^No threads/ }))?.text).toBe('No threads · /thread new <message> to start one')
  await band.unmount()
  expect(await run('list')).toBe('No threads.')
})
