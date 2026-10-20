export type ThreadCard = {
  key: string
  title: string
  description: string
  options: { id: string; label: string }[]
  recommendation: string
  refs: string[]
  answered: string | null // the chosen option id, or WITHDRAWN ('(withdrawn)') when the coordinator retired it
}

export type Thread = {
  id: string // 'a', 'b', ... 'ab', minted by the mod; '' holds untagged decisions ("No thread")
  title: string
  key: string // coordinator key of a `kind: thread` item, '' otherwise
  sections: string[] // oldest first
  cards: ThreadCard[]
  closed: boolean
  agent?: string // a `kind: thread` item's agent description
  agentIds?: string[] // agents bound to the thread by that description
}

declare module 'claude-code' {
  interface PluginState {
    conversations: { threads: Thread[]; selected: string | null; shown: string | null; acked: Record<string, number>; collapsed: boolean; closedIds: Record<string, true>; bandHidden: boolean; expanded: Record<string, true>; active: boolean; dismissed: Record<string, string> } // dismissed: `<thread id>:<key>` -> the options it was dismissed with // closedIds: threads the operator closed with /thread close // acked: thread id -> sections.length when the operator marked it seen
  }
}
