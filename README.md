# Conversation threads for Claude CLI

Often times when working with multiple agents and responding prompts from them, or signing them up for follow-on work, the user can end up with interlaced answers from multiple agents. The same is valid when running multiple bash commands that can complete at different order, etc. 
This behavior of interlaced options, analysis results, report-outs, can create the need to scroll up and down the CLI window constantly, which can be tedious as it is not the most precise operation and leads to jumping over things in text.

This repo implements a Claude Code plugin that splits one conversation into threads. Prompts and replies carry a thread tag, decisions the model asks for show as cards with option buttons, a band above the prompt lists the open threads, and a pane lists what needs you.

You can as easily continue working in your current mode in single CLI, or take advantage of the plugin's views and quick access to questions waiting for you, without having to learn shortcuts, new methods or change your workflow. This is not an agent launching, session tracking plugin. It just organizes your current flow of information in your current session.

## How it works

### Tags

A thread has a short letter id (`a`, `b`, ... `ab`), shown as "Thread AB". A prompt sent while a thread is selected goes out as `[thread:<id>] <prompt>`. The plugin tells the model the protocol, and the model starts its reply with the same tag.

A reply can answer several threads: each line that starts with `[thread:<id>]` begins a section for that thread, up to the next tag line. Text before the first tag belongs to no thread.

### `thread-item` blocks

The model asks for a decision with a fenced block whose info string is `thread-item`:

````
```thread-item
kind: decision
key: merge-strategy
title: Merge strategy for the release branch
description: Squash keeps history linear; a flag lets QA run both paths.
options:
  - a: Squash
  - b: Ship behind a flag
recommendation: b
```
````

It opens a thread for a topic or a piece of work with `kind: thread`:

````
```thread-item
kind: thread
key: fix-login
title: Fix the login timeout
body: An agent is reproducing the timeout.
agent: Fix the login timeout
```
````

A thread item creates a thread with the next free id, unless a thread with that `key` exists. A decision emitted outside any tag is listed under "No thread".

In the transcript each `thread-item` block is drawn as one line, `[+] thread-item: <title>`, that opens to the full block on a press; the stored reply keeps the block.

### Answers and protocol lines

- Pressing an option sends `[thread:<id>] decide: <key> <option>` (untagged for a "No thread" decision). The card is marked answered at once and is not sent twice.
- The model replies `[thread:<id>] resolved` after acting on it, or `[thread:<id>] stale` when the decision was already settled.
- `[thread:<id>] withdrawn <key>` on its own line retires a decision; a bare `withdrawn <key>` before any tag retires a "No thread" one.
- `[thread:<id>] closed` on its own line closes the thread.
- Re-emitting a decision with the same `key` and the same options keeps its answer; new options reopen it.

### Agent reports

When a `kind: thread` item has an `agent` field equal to the `description` given to the Agent tool, that agent's task notifications and hand-back messages are filed into the thread as a status line, and the prompt that carries them is tagged with the thread, so the model's reply lands there too.

## The `/thread` command

| Command | Effect |
|---|---|
| `/thread` | Open or close the pane |
| `/thread <id>` | Select a thread (reopens it if closed); prompts are tagged with it |
| `/thread none` | Clear the selection; prompts go untagged |
| `/thread list` | One line per thread with its status (`●` needs an answer, `answered`, `open`, `closed`) |
| `/thread new <message>` | Create and select a thread titled by the message, and put `[thread:<id>] <message>` in the prompt |
| `/thread close <ids>` | Close one or more threads (`/thread <id> close` also works) |
| `/thread show-band`, `/thread hide-band` | Show or hide the band |
| `/thread show-view`, `/thread hide-view` | Open the pane on the needs-you list, or close it |

## Band and pane

The band above the prompt has one row per open thread: hotkey `1`-`9`, "Thread AB", the title cut to fit, and `needs answer` or `●` (unseen replies) at the end. Pressing a row selects the thread and opens the pane on it. `−` collapses the band to one summary line (`3 threads · 1 needs answer`), `+` expands it. The footer has `none`, `view` and a count of closed threads. With no open thread and none selected, the band shows one dim line instead: `No threads · /thread new <message> to start one`.

The pane shows, per active thread, a header, one status line (`needs answer`, or `new:` with the first meaningful line of the latest reply and a `☐ seen` button) and the open decision cards. With no thread selected, or after `view`, it lists the threads that need you: open decisions first, then unseen replies. Reply bodies stay in the transcript. When the pane shows one thread, its header has a `Close thread` button: it closes the thread as `/thread close` does and the pane goes back to the needs-you list.

A thread closes when the model writes `[thread:<id>] closed` or you run `/thread close`. A prompt tagged with a closed thread, or selecting it, reopens it.

## Limits

- Threads live in the session. A reload rebuilds them from the transcript; which replies you marked seen and which threads you closed by command are kept for the session only.
- If Claude Code itself collapsed the band (its `[-]` or ctrl+x ctrl+a), only ctrl+x ctrl+a brings it back.
- `/thread new` cannot send the prompt for you: it fills the prompt, and you press Enter.

## Install

At the Claude Code prompt:

```
/plugin install conversations --marketplace ferhan/claude-conversations
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install conversations --marketplace ferhan/claude-conversations
```

## Development

```
claude --plugin-dir <folder>
claude plugin validate .
claude plugin test .
```

## License

MIT
