import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ThreadCard, Thread } from '../types'
import { apply, delivery, file, WITHDRAWN, gist, label, labelled, learn, mint, parts, rebuild, relabel, tagOf } from './parse'

const PANE = 'thread-pane'
const threads = atom({ plugin: 'conversations', key: 'threads' } as const, [])
const selected = atom({ plugin: 'conversations', key: 'selected' } as const, null)
const shown = atom({ plugin: 'conversations', key: 'shown' } as const, null) // the pane's thread; null is the needs-you list
const acked = atom({ plugin: 'conversations', key: 'acked' } as const, {})
const TOGGLE = 5 // cells of the `[ - ]` button; rows 2..n get an empty Box this wide
const closedIds = atom({ plugin: 'conversations', key: 'closedIds' } as const, {}) // operator closes: not in the transcript, so applied after every rebuild
// Close or reopen threads by the operator's hand; a reopen also clears the operator's close.
const setClosed = async ($: EngineInterface, ids: string[], closed: boolean) => {
  await update($, closedIds, m => {
    const n = { ...m }
    for (const id of ids) if (closed) n[id] = true
    else delete n[id]
    return n
  })
  await update($, threads, l => l.map(t => (ids.includes(t.id) ? { ...t, closed } : t)))
}
const bandHidden = atom({ plugin: 'conversations', key: 'bandHidden' } as const, false)
// `/thread close` and the pane's Close button: close the known ids, drop a closed selection. Returns the known ids.
const closeThreads = async ($: EngineInterface, ids: string[]) => {
  const all = (await read($, threads)).filter(t => t.id)
  const known = ids.filter(i => all.some(t => t.id === i))
  await setClosed($, known, true)
  const sel = await read($, selected)
  if (sel && known.includes(sel)) await select($, null)
  return known
}
const expanded = atom({ plugin: 'conversations', key: 'expanded' } as const, {}) // `<message id>:<part index>` of thread-item blocks drawn open
const active = atom({ plugin: 'conversations', key: 'active' } as const, false) // the operator used threads: a /thread command or a tagged prompt
// Operator dismissals: not in the transcript, so applied after every rebuild. Kept with the options they were
// dismissed with, so a re-emit with new options reopens the decision (as for a model's `withdrawn`).
const dismissed = atom({ plugin: 'conversations', key: 'dismissed' } as const, {})
const sig = (c: ThreadCard) => JSON.stringify(c.options)
const withDismissals = (list: Thread[], d: Record<string, string>) =>
  list.map(t => ({ ...t, cards: t.cards.map(c => (c.answered === null && d[`${t.id}:${c.key}`] === sig(c) ? { ...c, answered: WITHDRAWN } : c)) }))
// Drop open decisions without answering them: no prompt is sent. Returns how many were open.
const dismiss = async ($: EngineInterface, pick: (t: Thread, c: ThreadCard) => boolean) => {
  const hit = (await read($, threads)).flatMap(t => t.cards.filter(c => c.answered === null && pick(t, c)).map(c => [`${t.id}:${c.key}`, sig(c)] as const))
  await update($, dismissed, m => ({ ...m, ...Object.fromEntries(hit) }))
  await update($, threads, l => withDismissals(l, Object.fromEntries(hit)))
  return hit.length
}
const collapsed = atom({ plugin: 'conversations', key: 'collapsed' } as const, false)

// What the coordinator (the main session's model) is told about the protocol.
const COORDINATOR =
  'The operator uses a client that tags prompts with threads and renders `thread-item` blocks as cards. ' +
  'Whenever you need an operator decision, emit a `thread-item` block, one block per decision: a fenced code block with the info string `thread-item` and these YAML keys: ' +
  '`kind` (decision), `key` (short slug), `title`, `description` (the context and trade-offs the operator needs, plain text), ' +
  '`options` (a YAML list, one `- <id>: <label>` per line, for example `- a: Squash`), `recommendation` (an option id) and optional `refs` (a list of URLs). ' +
  'When you update a decision that is still open, reuse the same `key`. ' +
  'A prompt that starts with a tag `[thread:<letters>]` is an operator question in that thread; start your reply with the same tag. ' +
  'The `<id>` in a tag is assigned by the client and differs from your `key`; an answer reads `decide: <key> <option>`. ' +
  'After you have acted on a decision, reply `[thread:<id>] resolved`; reply `[thread:<id>] stale` instead, without acting, only when that decision was already settled or changed after you asked it. ' +
  "When you answer another thread's question, do not mention that thread inline: put that answer in its own section on a new line that begins with that thread's tag, for example `[thread:b] <answer>`. " +
  'Use only tags from prompts you received; never make one up. ' +
  'To open a thread for a topic or a piece of work, emit a `thread-item` block with `kind: thread`, `key`, `title`, optional `body` and, when an agent does that work, `agent` set to the exact `description` you give the Agent tool; that agent\'s reports then arrive tagged with the thread. ' +
  "To put a decision in a thread you open, emit the `kind: thread` block and set `thread: <that block's key>` in the decision block; `thread:` takes a key, never a tag id. " +
  'When a decision belongs to a thread already open, set `thread:` to that thread\'s key, which the prompt gives; a decision outside any tag with no `thread:` opens a thread from its `key` and `title`. ' +
  'A decision without `thread:` goes to the tagged section it sits in, or opens a thread from its `key` and `title`. Withdraw such a decision with `withdrawn <key>` before any tag. ' +
  'To retire a decision you no longer need answered, write `[thread:<id>] withdrawn <key>` on its own line, or `withdrawn <key>` before any tag for an untagged decision. ' +
  "Write `[thread:<id>] closed` on its own line only when the operator's prompt asks you to close that thread. " +
  'When the prompt does not start with a `[thread:<id>]` tag, start your reply without a tag.'

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
const head = (t: Thread) => `Thread ${label(t.id)} · ${t.title || 'untitled'}`
const OWN = ['composer', 'bridge', 'sdk'] // the operator's own prompts; every other origin is a delivery
const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)
// No `focus`: the pane opens beside the prompt and the prompt keeps the keys.
const openPane = async ($: EngineInterface) => {
  const id = await read($, shown)
  const t = (await read($, threads)).find(x => x.id === id)
  return $.ui.open({ id: PANE, title: t ? head(t) : 'Threads', closeOnEscape: true })
}
// A thread opens the pane on it; `none` turns an open pane back to the needs-you list.
const select = async ($: EngineInterface, id: string | null) => {
  await update($, selected, () => id)
  await update($, shown, () => id)
  if (id || (await isOpen($))) await openPane($)
}
// A new thread titled by its first message, selected.
const startThread = async ($: EngineInterface, text: string) => {
  let id = ''
  await update($, threads, l => [...l, { id: (id = mint(l)), title: text.split('\n')[0]!, key: '', sections: [], cards: [], closed: false }])
  await select($, id)
  return id
}
// A prompt from a model-opened thread carries its key, so a decision can name the thread with `thread:`.
const withKey = async <E extends { context?: readonly string[] }>($: EngineInterface, e: E, id: string): Promise<E> => {
  const key = (await read($, threads)).find(t => t.id === id)?.key
  return key ? { ...e, context: [...(e.context ?? []), `Thread [thread:${id}] has key ${key}: set \`thread: ${key}\` on a decision that belongs to it.`] } : e
}
const pending = (t: Thread) => t.cards.some(c => c.answered === null)
const unseen = (t: Thread, seen: Record<string, number>) => !pending(t) && t.sections.length > (seen[t.id] ?? 0)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'thread', description: 'Threads: toggle the pane, list threads, start one with a message, select one, close some, none, or show/hide the band and the view', argumentHint: '[letters | list | none | new <message> | close <ids> | show-band | hide-band | view | show-view | hide-view]' })
    // --resume: rebuild threads from the tagged user and assistant rows already in the transcript.
    const shut = await read($, closedIds)
    const rows = await $.session.messages()
    const list = withDismissals(rebuild(rows), await read($, dismissed)).map(t => (shut[t.id] ? { ...t, closed: true } : t))
    await update($, threads, () => list)
    // --resume: an operator prompt tagged earlier in the transcript means threads were in use.
    if (rows.some(m => m.role === 'user' && tagOf(m.text) !== null && !delivery(m.text))) await update($, active, () => true)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    // Only once the operator uses threads; `active` is never cleared, so the prompt cache breaks once. A model's own
    // thread-item block does not turn it on: without the instructions it should not write one.
    if (!(await read($, active))) return r
    return { sections: [...r.sections, { id: 'conversations:coordinator', text: COORDINATOR, scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    const own = OWN.includes(e.origin.kind)
    const tag = tagOf(e.text)
    if (tag !== null && own) await update($, active, () => true)
    if (tag !== null) {
      if (own && (await read($, threads)).some(t => t.id === tag && t.closed)) await setClosed($, [tag], false)
      return next(await withKey($, e, tag))
    }
    if (!own) {
      // An agent's notification or hand-back: file it into its bound thread and tag it so the reply lands there.
      let list = await read($, threads)
      const d = file(list, e.text)
      if (!d.thread && /<agent-message from="/.test(e.text)) list = learn(list, (await $.session.messages()).flatMap(m => m.toolUses)) // a hand-back can precede the notification that names the agent
      const r = d.thread ? d : file(list, e.text)
      if (!r.thread) return next(e)
      await update($, threads, () => r.threads)
      const tag = `[thread:${r.thread.id}]`
      // A hidden prompt that starts its own turn takes no text rewrite; context reaches the model either way.
      return e.isMeta
        ? next({ ...e, context: [...(e.context ?? []), `This message belongs to thread ${tag}: start your reply with ${tag}.`] })
        : next({ ...e, text: `${tag} ${e.text}` })
    }
    const id = await read($, selected)
    if (!id) return next(e)
    await update($, active, () => true)
    if ((await read($, threads)).some(t => t.id === id && t.closed)) await setClosed($, [id], false)
    await update($, threads, l => l.map(t => (t.id === id && !t.title ? { ...t, title: e.text.split('\n')[0]! } : t))) // whole first line: the band and list cut it to their width
    if (await isOpen($)) await openPane($) // retitle
    return next(await withKey($, { ...e, text: `[thread:${id}] ${e.text}` }, id))
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && e.answer) {
      const id = await read($, selected)
      const { threads: list, fresh } = apply(await read($, threads), e.answer)
      await update($, threads, () => list)
      if (id && list.find(t => t.id === id)?.closed) await select($, null)
      for (const { thread, card } of fresh) void $.ui.notify(`Thread ${label(thread.id)} needs you: ${card.title}`, { title: 'Threads' })
    }
    return next(e)
  })

  on('command.run', { command: 'thread' }, async ($, e) => {
    await update($, active, () => true)
    const raw = e.args.trim()
    const arg = raw.toLowerCase()
    if (!arg) {
      if (await isOpen($)) {
        await $.ui.close({ id: PANE })
        return { text: 'Thread pane closed.' }
      }
      await openPane($)
      return { text: 'Thread pane opened.' }
    }
    if (arg === 'show-band' || arg === 'hide-band') {
      await update($, bandHidden, () => arg === 'hide-band')
      // No API expands a band the engine collapsed (its `[-]`, ctrl+x ctrl+a): only the person can.
      return { text: arg === 'hide-band' ? 'Band hidden.' : 'Band shown. If it is still hidden, Claude Code collapsed it: press ctrl+x ctrl+a.' }
    }
    if (arg === 'show-view' || arg === 'view') {
      await update($, shown, () => null)
      await openPane($)
      return { text: 'View shown.' }
    }
    if (arg === 'hide-view') {
      if (await isOpen($)) await $.ui.close({ id: PANE })
      return { text: 'View hidden.' }
    }
    if (arg === 'none') {
      await select($, null)
      return { text: 'Prompts go untagged.' }
    }
    if (arg === 'list') {
      const all = await read($, threads)
      const room = Math.max(10, e.presentation.columns - 30)
      // The row is markdown: bare newlines are soft breaks that join into one paragraph, so one list item per thread.
      const lines = all.map(t => `- Thread ${label(t.id)}  ${cut(t.title || 'untitled', room)}  [${t.closed ? 'closed' : pending(t) ? '●' : t.cards.length ? 'answered' : 'open'}]`)
      return { text: lines.join('\n') || 'No threads.' }
    }
    if (arg === 'new' || arg.startsWith('new ')) {
      const text = raw.slice(3).trim()
      if (!text) return { text: 'Usage: /thread new <message>' }
      // The host refuses $.prompt.submit from a command.run (and a prompt.submit) hook, so the message becomes the draft.
      const id = await startThread($, text)
      await $.prompt.fill({ text: `[thread:${id}] ${text}` })
      return { text: `Thread ${label(id)} started: press Enter to send.` }
    }
    const words = arg.split(/\s+/)
    // `/thread close a b`, or `/thread a close` as first typed.
    const ids = words[0] === 'close' ? words.slice(1) : words[1] === 'close' && words.length === 2 ? [words[0]!] : null
    if (ids) {
      if (!ids.length) return { text: 'Usage: /thread close <ids>' }
      const known = await closeThreads($, ids)
      return { text: ids.map(i => (known.includes(i) ? `Thread ${label(i)} closed.` : `No thread ${label(i)}.`)).join(' ') }
    }
    const id = arg // the letters the band shows: `/thread b` is Thread B
    if (!(await read($, threads)).some(t => t.id === id)) return { text: `No thread ${arg.toUpperCase()}.` }
    await setClosed($, [id], false) // selecting a closed thread reopens it
    await select($, id)
    return { text: `Thread ${label(id)} selected.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const all = await read($, threads)
    const list = all.filter(t => !t.closed)
    const nClosed = all.length - list.length
    const id = await read($, selected)
    if (e.props.hasSurvey || (await read($, bandHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const view = async () => (await update($, shown, () => null), openPane($))
    // One line, so no rule row above it.
    if (list.length === 0 && !id) return <Text dimColor>No threads · /thread new &lt;message&gt; to start one</Text>
    const seen = await read($, acked)
    const toggle = () => update($, collapsed, c => !c)
    if (await read($, collapsed)) {
      const nAsk = list.filter(pending).length
      const nNew = list.filter(t => unseen(t, seen)).length
      return (
        <Box flexDirection="row" columnGap={1}>
          <Button key="expand" label="+" onPress={toggle} />
          <Text>
            {`${list.length} thread${list.length === 1 ? '' : 's'} · ${nAsk} needs answer${nNew ? ` · ${nNew} unseen` : ''}`}
          </Text>
        </Box>
      )
    }
    // No row cap: a band taller than maxRows scrolls and the engine draws `n more`.
    const row = (t: Thread, i: number) => {
      const status = pending(t) ? '  needs answer' : unseen(t, seen) ? '  ●' : ''
      const lead = `Thread ${label(t.id)}  `
      const room = Math.max(6, e.props.bodyColumns - lead.length - status.length - TOGGLE - 1 - 7) // toggle + gap, `[ ]` and a `1: ` hotkey
      return (
        <Button
          key={t.id}
          label={lead + cut(t.title || 'untitled', room) + status}
          variant={t.id === id ? 'primary' : undefined}
          hotkey={i < 9 ? String(i + 1) : undefined}
          onPress={() => select($, t.id)}
        />
      )
    }
    return (
      <Box flexDirection="column">
        <Text dimColor>{'─'.repeat(e.props.bodyColumns)}</Text>
        {list.map((t, i) => [t.id, row(t, i)] as const).map(
          ([k, el], i) => (
            <Box key={`line:${k}`} flexDirection="row" columnGap={1}>
              <Box width={TOGGLE} flexShrink={0}>
                {i === 0 ? <Button key="collapse" label="−" onPress={toggle} /> : null}
              </Box>
              {el}
            </Box>
          ),
        )}
        <Box flexDirection="row" columnGap={1}>
          <Button key="none" label="none" variant={id ? undefined : 'primary'} onPress={() => select($, null)} />
          <Text dimColor>·</Text>
          <Button key="view" label="view" onPress={view} />
          {nClosed > 0 ? <Text dimColor>+{nClosed} closed</Text> : null}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const all = await read($, threads)
    const seen = await read($, acked)
    const id = await read($, shown)
    const decide = (t: Thread, c: ThreadCard, o: { id: string; label: string }) => async () => {
      let open = false // set inside the update so two presses cannot both see the card open
      await update($, threads, l => {
        open = !!l.find(x => x.id === t.id)?.cards.some(y => y.key === c.key && y.answered === null)
        return open ? l.map(x => (x.id === t.id ? { ...x, cards: x.cards.map(y => (y.key === c.key ? { ...y, answered: o.id } : y)) } : x)) : l
      })
      if (!open) return
      await $.prompt.submit({ text: `[thread:${t.id}] decide: ${c.key} ${o.id} (${o.label})` })
    }
    const ack = (t: Thread) => () => update($, acked, m => ({ ...m, [t.id]: t.sections.length }))
    // No reply bodies here: header, one status line, open cards. The full text stays in the transcript.
    // The thread view's Close: the same close as `/thread close`; dropping the selection turns the pane back to the needs-you list.
    const close = (t: Thread) => () => closeThreads($, [t.id])
    const block = (t: Thread, single = false) => (
      <Box key={`th:${t.id}`} flexDirection="column">
        {single ? (
          <Box flexDirection="row" columnGap={1}>
            <Text bold>{head(t)}</Text>
            <Button key={`close:${t.id}`} label="Close thread" onPress={close(t)} />
          </Box>
        ) : (
          <Text bold>{head(t)}</Text>
        )}
        {pending(t) ? (
          <Text>needs answer</Text>
        ) : t.sections.length > (seen[t.id] ?? 0) ? (
          <Box flexDirection="row" columnGap={1}>
            <Button key={`ack:${t.id}`} label="☐ seen" onPress={ack(t)} />
            <Text>{`new: ${cut(gist(t.sections) || 'reply', Math.max(10, e.props.bodyColumns - 18))}`}</Text>
          </Box>
        ) : (
          <Text dimColor>no open items</Text>
        )}
        {t.cards
          .filter(c => c.answered === null)
          .map(c => (
            <Box key={`card:${t.id}:${c.key}`} flexDirection="column" borderStyle="round" paddingX={1}>
              <Text bold>{c.title}</Text>
              {c.description ? <Text>{c.description}</Text> : null}
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                {c.options.map(o => (
                  <Button
                    key={`opt:${t.id}:${c.key}:${o.id}`}
                    label={`${o.id}: ${o.label}${o.id === c.recommendation ? ' (recommended)' : ''}`}
                    variant={o.id === c.recommendation ? 'primary' : undefined}
                    onPress={decide(t, c, o)}
                  />
                ))}
                <Button key={`dismiss:${t.id}:${c.key}`} label="dismiss" onPress={() => dismiss($, (x, y) => x.id === t.id && y.key === c.key)} />
              </Box>
            </Box>
          ))}
      </Box>
    )

    const sel = all.find(x => x.id === id)
    if (sel) return block(sel, !!sel.id)
    const open = all.filter(t => !t.closed)
    // Open decisions first, then threads with replies past what the operator acked.
    const active = [...open.filter(pending), ...open.filter(t => unseen(t, seen))]
    if (!active.length) return <Text dimColor>Nothing needs you.</Text>
    return (
      <Box flexDirection="column" gap={1}>
        {active.map(t => block(t))}
      </Box>
    )
  })

  // Transcript drawing only; the stored reply, what the model reads, keeps every tag and block.
  // A reply: each thread-item block as one line, `[+] thread-item: <title>`, opened in place on a press; a line-leading
  // `[thread:<id>]` as a dim `Thread AB ·` label; a tag-and-protocol-word line as one dim line. Untagged, block-less replies pass.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)
    const ps = parts(e.props.text).map(p => ('block' in p ? p : labelled(p.text)))
    if (!ps.some(p => 'block' in p || p.some(s => s.id))) return next(e)
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const open = await read($, expanded)
    const toggle = (k: string) => () =>
      update($, expanded, m => {
        const n = { ...m }
        if (n[k]) delete n[k]
        else n[k] = true
        return n
      })
    return (
      <Box flexDirection="column">
        {ps.flatMap((p, i) => {
          if (Array.isArray(p))
            return p.map((s, j) =>
              s.verb ? (
                <Text key={`verb:${i}:${j}`} dimColor>{`Thread ${label(s.id!)} · ${s.text}`}</Text>
              ) : s.id ? (
                <Box key={`sec:${i}:${j}`} flexDirection="row" columnGap={1}>
                  <Text dimColor>{`Thread ${label(s.id)} ·`}</Text>
                  <Box flexShrink={1} flexDirection="column">
                    <Markdown key={`text:${i}:${j}`} text={s.text} />
                  </Box>
                </Box>
              ) : (
                <Markdown key={`text:${i}:${j}`} text={s.text} />
              ),
            )
          const k = `${e.requestId}:${i}`
          return [
            <Box key={`item:${i}`} flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                <Button key={`item:${k}`} label={open[k] ? '−' : '+'} onPress={toggle(k)} />
                <Text dimColor>{`thread-item: ${p.title}`}</Text>
              </Box>
              {open[k] ? <Markdown key={`block:${i}`} text={p.block} /> : null}
            </Box>,
          ]
        })}
      </Box>
    )
  })

  // A user row: line-leading tags drawn as `Thread AB · ` in the engine's own row (a text rewrite, no dim).
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const text = relabel(e.props.text)
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  })
}
