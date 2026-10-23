// The reply protocol (sections by tag, close and withdraw lines, thread-item blocks) and the thread-state
// merge the hooks use live and on --resume.
import type { ThreadCard, Thread } from '../types'

export type Topic = { key: string; title: string; body: string; agent: string }
export type Section = {
  thread: string // '<letters>', or '' for text before the first tag line
  text: string // display text: tag and thread-item blocks removed
  verb: 'resolved' | 'stale' | 'closed' | null
  decisions: (ThreadCard & { thread?: string })[]
  topics: Topic[]
}

const OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
// A tag: `[thread:<letters>]`.
const TAG = String.raw`\[thread:([A-Za-z]+)\]`
const ANY_TAG = String.raw`\[thread:[A-Za-z]+\]`
const ITEM = ['thread-item'] // the block info string
const SECTION = new RegExp(String.raw`^\s*${TAG}`)
export const tagOf = (text: string) => SECTION.exec(text)?.[1]!.toLowerCase() ?? null // the leading tag's id
const VERB = new RegExp(String.raw`^\s*${ANY_TAG}[ \t]*(resolved|stale|closed)\b`, 'i')
const CLOSED = new RegExp(String.raw`^\s*${ANY_TAG}[ \t]+closed[ \t]*[.!]?\s*$`, 'i') // alone on its line

const closes = (fence: string, line: string) => {
  const c = CLOSE.exec(line)
  return !!c && c[1]![0] === fence[0] && c[1]!.length >= fence.length
}

export function letters(n: number): string {
  let s = ''
  for (n += 1; n > 0; n = Math.floor(n / 26)) s = String.fromCharCode(97 + (--n % 26)) + s
  return s
}
export const label = (id: string) => id.toUpperCase()
const num = (id: string) => [...id].reduce((n, c) => n * 26 + c.charCodeAt(0) - 96, 0) - 1 // inverse of letters
// The client mints thread ids, never the coordinator: the one after the highest seen (a, b, ... z, aa ...).
export function mint(threads: { id: string }[]): string {
  return letters(Math.max(-1, ...threads.map(t => num(t.id))) + 1)
}

const USER_TAG = new RegExp(String.raw`^\s*${TAG}[ \t]*([\s\S]*)$`)
// The pane's own decide prompt, tagged or (for a "No thread" decision) not. A plugin-submitted prompt reaches the
// transcript wrapped ("The <plugin> plugin sent a message:\n[thread:ac] decide: ..."), so any line matches.
const DECIDE = new RegExp(String.raw`^\s*(?:${TAG}[ \t]*)?decide:[ \t]+(\S+)[ \t]+(\S+)`, 'gm')

// Agent deliveries, as this session's transcript holds them:
//   task notification: "<task-notification>\n<task-id>ID</task-id>...<summary>Agent \"DESC\" finished</summary>"
//   hand-back (origin peer): "Another Claude session sent a message:\n<agent-message from=\"ID\">..."
const TASK_ID = /<task-notification>\s*<task-id>([^<]+)<\/task-id>/
const SUMMARY = /<summary>([^<]*)<\/summary>/
const AGENT_DESC = /^Agent "([^"]*)"/
const FROM = /<agent-message from="([^"]+)"/
export type ToolUse = { tool: string; input: Record<string, unknown>; agentId?: string }

export const owner = (list: Thread[], agentId: string) => list.find(t => t.agentIds?.includes(agentId))
// Bind an agent to the open thread whose `agent` is its description; an agent binds once.
export function bind(list: Thread[], agentId: string, desc: string): Thread[] {
  if (owner(list, agentId)) return list
  const t = list.find(x => !x.closed && x.agent && x.agent === desc)
  return t ? list.map(x => (x === t ? { ...x, agentIds: [...(x.agentIds ?? []), agentId] } : x)) : list
}
// An Agent tool use names its description and, once spawned, the agent's id.
export const learn = (list: Thread[], uses: readonly ToolUse[] = []) =>
  uses.reduce((l, u) => (u.tool === 'Agent' && u.agentId && typeof u.input.description === 'string' ? bind(l, u.agentId, u.input.description) : l), list)
// A delivery's agent id, its description when the row names one, and the line it files.
export function delivery(text: string): { id: string; desc?: string; line?: string } | null {
  const n = TASK_ID.exec(text)
  if (n) {
    const sum = SUMMARY.exec(text)?.[1]
    return { id: n[1]!, desc: sum ? AGENT_DESC.exec(sum)?.[1] : undefined, line: sum }
  }
  const f = FROM.exec(text)
  return f ? { id: f[1]! } : null
}
// File a delivery into the thread its agent is bound to: one status line, never the report body.
export function file(list: Thread[], text: string): { threads: Thread[]; thread?: Thread } {
  const d = delivery(text)
  if (!d) return { threads: list }
  if (d.desc) list = bind(list, d.id, d.desc)
  const t = owner(list, d.id)
  if (!t) return { threads: list }
  const line = d.line ?? `Report from agent "${t.agent}"`
  const threads = list.map(x => (x === t ? { ...x, sections: [...x.sections, line] } : x))
  return { threads, thread: threads.find(x => x.id === t.id) }
}

// Rebuild threads from transcript rows in order: assistant rows via apply, tagged user prompts create the thread and its first title.
export function rebuild(rows: { role: string; text?: string; toolUses?: readonly ToolUse[] }[]): Thread[] {
  let list: Thread[] = []
  for (const m of rows) {
    if (m.role === 'assistant') {
      if (m.text) list = apply(list, m.text).threads
      list = learn(list, m.toolUses)
    } else if (m.role === 'user' && m.text) {
      const g = USER_TAG.exec(m.text)
      if (g) {
        const [, tag, rest] = g as unknown as [string, string, string]
        const id = tag.toLowerCase()
        if (!list.some(t => t.id === id)) list = [...list, { id, title: '', key: '', sections: [], cards: [], closed: false }]
        const own = !delivery(m.text) // the operator's prompt, not a delivery the mod tagged
        list = list.map(t => (t.id === id ? { ...t, title: t.title || rest.split('\n')[0]!, closed: t.closed && !own } : t)) // a prompt to a closed thread reopens it
      }
      list = file(list, m.text).threads
      // A decide keeps its card answered across a rebuild (a reload, --resume); it also settles a "No thread" copy of the key.
      for (const [, tag = '', key, opt] of m.text.matchAll(DECIDE))
        list = list.map(t => (t.id === tag.toLowerCase() || t.id === '' ? { ...t, cards: t.cards.map(c => (c.key === key ? { ...c, answered: opt! } : c)) } : t))
    }
  }
  return list
}

// Strip one layer of YAML quoting from a plain scalar.
const unq = (v: string) => {
  v = v.trim()
  if (v.length >= 2 && v[0] === v.at(-1) && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1)
  return v
}

// shortcut: a line-based YAML subset (top-level `k: v`, `|`/`>` block scalars, `- a: Label`
// and `- url` lists, inline `[x, y]` refs); upgrade to a real YAML parser if blocks get richer.
function yamlish(body: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_]+):[ \t]*(.*)$/.exec(lines[i]!)
    if (!m) continue
    const [, k, v] = m as unknown as [string, string, string]
    const kids: string[] = []
    while (i + 1 < lines.length && /^[ \t]+\S|^-/.test(lines[i + 1]!)) kids.push(lines[++i]!)
    if (v === '|' || v === '>') out[k] = kids.map(l => l.trim()).join(v === '|' ? '\n' : ' ')
    else if (v === '' && kids.length) out[k] = kids.map(l => l.replace(/^\s*-\s*/, ''))
    else if (/^\[.*\]$/.test(v)) out[k] = v.slice(1, -1).split(',').map(unq).filter(Boolean)
    else out[k] = unq(v)
  }
  return out
}

function item(body: string): { decision?: Section['decisions'][number]; topic?: Topic } {
  const y = yamlish(body)
  const s = (k: string) => (typeof y[k] === 'string' ? (y[k] as string) : '')
  const title = s('title') || s('question')
  if (!title) return {}
  if (s('kind') === 'thread') return s('key') ? { topic: { key: s('key'), title, body: s('body'), agent: s('agent') } } : {}
  const options = ((Array.isArray(y.options) ? y.options : []) as string[]).flatMap(o => {
    const m = /^([^\s:]+):\s*(.+)$/.exec(o)
    return m ? [{ id: m[1]!, label: unq(m[2]!) }] : []
  })
  const refs = Array.isArray(y.refs) ? y.refs : y.refs ? [y.refs] : []
  return {
    decision: { key: s('key') || title, title, description: s('description'), options, recommendation: s('recommendation'), refs, answered: null, ...(s('thread') && { thread: s('thread') }) },
  }
}

// `[thread:<id>] withdrawn <key>`, or bare `withdrawn <key>` in untagged text for a "No thread" decision.
const WITHDRAW = new RegExp(String.raw`^\s*(?:${TAG}[ \t]+)?withdrawn[ \t]+(\S+)[ \t]*$`, 'i')
export const WITHDRAWN = '(withdrawn)'

export function parseAnswer(text: string): { sections: Section[]; closes: string[]; withdrawn: { thread: string; key: string }[] } {
  const sections: Section[] = []
  const closed: string[] = []
  const withdrawn: { thread: string; key: string }[] = []
  let cur: Section | null = null
  let fence = ''
  let block: string[] | null = null // body lines of an open thread-item fence
  const start = (thread: string) => {
    cur = { thread, text: '', verb: null, decisions: [], topics: [] }
    sections.push(cur)
    return cur
  }
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const sec: Section = cur ?? start('')
    if (fence) {
      if (closes(fence, line)) {
        fence = ''
        if (block) {
          const it = item(block.join('\n'))
          if (it.decision) sec.decisions.push(it.decision)
          if (it.topic) sec.topics.push(it.topic)
          block = null
          continue
        }
      } else if (block) {
        block.push(line)
        continue
      }
      sec.text += line + '\n'
      continue
    }
    const o = OPEN.exec(line)
    if (o) {
      fence = o[1]!
      if (ITEM.includes(o[2]!)) block = []
      else sec.text += line + '\n'
      continue
    }
    const w = WITHDRAW.exec(line)
    if (w && (w[1] || !sec.thread)) {
      withdrawn.push({ thread: (w[1] ?? '').toLowerCase(), key: w[2]! })
      continue
    }
    const t = SECTION.exec(line)
    const s = t ? start(t[1]!.toLowerCase()) : sec
    const v = VERB.exec(line)
    if (t && v) {
      s.verb = v[1]!.toLowerCase() as Section['verb']
      // `closed` counts only alone on its line
      if (s.verb === 'closed' && CLOSED.test(line) && !closed.includes(s.thread))
        closed.push(s.thread)
    }
    s.text += (t ? line.replace(SECTION, '').replace(/^[ \t]+/, '') : line) + '\n'
  }
  for (const s of sections) s.text = s.text.trim()
  return { sections: sections.filter(s => s.text || s.decisions.length || s.topics.length || s.verb), closes: closed, withdrawn }
}

// Fold one assistant answer into the threads. Only a `[thread:<id>]` tag claims text: untagged text belongs to no thread,
// but an untagged decision goes to the '' thread ("No thread") so it can still be answered.
export function apply(threads: Thread[], answer: string) {
  const next = threads.map(t => ({ ...t, sections: [...t.sections], cards: [...t.cards] }))
  const fresh: { thread: Thread; card: ThreadCard }[] = []
  const get = (id: string) => {
    let t = next.find(x => x.id === id)
    if (!t) next.push((t = { id, title: '', key: '', sections: [], cards: [], closed: false }))
    return t
  }
  const { sections, closes, withdrawn } = parseAnswer(answer)
  // Thread blocks first, so a decision can name a thread opened in the same reply.
  for (const s of sections)
    for (const p of s.topics) {
      const known = p.key ? next.find(x => x.key === p.key) : undefined
      const t = known ?? get(mint(next))
      if (!known) Object.assign(t, { title: p.title, key: p.key })
      if (p.agent) t.agent = p.agent
      if (p.body) t.sections.push(p.body)
    }
  for (const s of sections) {
    if (s.thread) {
      const sec = get(s.thread)
      if (s.text) sec.sections.push(s.text)
    }
    for (const { thread: named, ...c } of s.decisions) {
      // `thread: <key>` names the thread; an unknown key falls back to the section's thread.
      const t = (named && next.find(x => x.key === named)) || get(s.thread)
      const i = t.cards.findIndex(x => x.key === c.key)
      const old = t.cards[i]
      // Same key re-emitted with the same options keeps its answer; new options reopen it.
      if (old && old.answered !== null && JSON.stringify(old.options) === JSON.stringify(c.options)) {
        t.cards[i] = { ...c, answered: old.answered }
        continue
      }
      if (i >= 0) t.cards[i] = c
      else t.cards.push(c)
      fresh.push({ thread: t, card: c })
    }
  }
  for (const w of withdrawn)
    for (const t of next) if (t.id === w.thread) t.cards = t.cards.map(c => (c.key === w.key ? { ...c, answered: WITHDRAWN } : c))
  for (const id of closes) {
    const t = next.find(x => x.id === id)
    if (t) t.closed = true
  }
  return { threads: next, fresh }
}

// The status line: the first line of the newest reply that says something, skipping protocol words and bare tags.
const PROTOCOL = new RegExp(String.raw`^(?:${ANY_TAG}\s*)?(?:(?:resolved|stale|closed)[.!]?|withdrawn\s+\S+)?$`, 'i')
export const gist = (sections: string[]) => {
  for (let i = sections.length - 1; i >= 0; i--) {
    const line = sections[i]!.split('\n').map(l => l.trim()).find(l => !PROTOCOL.test(l))
    if (line) return line
  }
  return ''
}

// A reply split for drawing: its text, and each thread-item block with its title. An unclosed block stays text.
export type Part = { text: string } | { title: string; block: string }
export function parts(text: string): Part[] {
  const out: Part[] = []
  let buf: string[] = []
  let fence = ''
  let block: string[] | null = null
  const flush = () => {
    const t = buf.join('\n').trim()
    if (t) out.push({ text: t })
    buf = []
  }
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (block) {
      block.push(line)
      if (closes(fence, line)) {
        const y = yamlish(block.slice(1, -1).join('\n'))
        const s = (k: string) => (typeof y[k] === 'string' ? (y[k] as string) : '')
        out.push({ title: s('title') || s('question') || s('key') || 'untitled', block: block.join('\n') })
        block = null
        fence = ''
      }
      continue
    }
    if (fence) {
      if (closes(fence, line)) fence = ''
      buf.push(line)
      continue
    }
    const o = OPEN.exec(line)
    if (o) {
      fence = o[1]!
      if (ITEM.includes(o[2]!)) {
        flush()
        block = [line]
        continue
      }
    }
    buf.push(line)
  }
  if (block) buf.push(...block)
  flush()
  return out
}

// A text part split for display at its tag lines (outside code fences): the thread id (null before the first tag)
// and the text after the tag; `verb` marks a line that is only a tag and a protocol word.
export type Labelled = { id: string | null; text: string; verb: boolean }
const VERB_ONLY = /^(?:(?:resolved|stale|closed)[.!]?|withdrawn\s+\S+)$/i
export function labelled(text: string): Labelled[] {
  const out: Labelled[] = []
  let cur: Labelled | null = null
  let fence = ''
  const start = (id: string | null, line: string, verb = false) => out.push((cur = { id, text: line, verb }))
  const add = (line: string) => (cur && !cur.verb ? (cur.text += '\n' + line) : start(null, line))
  for (const line of text.split('\n')) {
    if (fence) {
      if (closes(fence, line)) fence = ''
      add(line)
      continue
    }
    const o = OPEN.exec(line)
    if (o) {
      fence = o[1]!
      add(line)
      continue
    }
    const t = SECTION.exec(line)
    if (!t) {
      add(line)
      continue
    }
    const rest = line.replace(SECTION, '').trim()
    start(t[1]!.toLowerCase(), rest, VERB_ONLY.test(rest))
  }
  return out.map(s => ({ ...s, text: s.text.trim() })).filter(s => s.text || s.id)
}
// A user row's text with each line-leading tag drawn as a `Thread AB · ` label.
export const relabel = (text: string) => text.replace(new RegExp(String.raw`^([ \t]*)${TAG}[ \t]*`, 'gm'), (_, sp: string, id: string) => `${sp}Thread ${label(id.toLowerCase())} · `)
