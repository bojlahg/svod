# svod plugin for Claude Code

Connects your knowledge bases to the agent over MCP.

## Install

```bash
/plugin marketplace add bojlahg/svod
/plugin install svod@svod
```

Then set your token — make one at `/settings/tokens`, which fills it into
the command for you:

```bash
export SVOD_TOKEN=...
```

Put that line in your shell profile so it survives a new terminal. Restart
Claude Code and `/brains` will list what you can read.

## What the agent gets

Fourteen tools. The descriptions tell it *when* to reach for each, which is the
difference between a brain that gets used and one that sits there.

| Tool | For |
|---|---|
| `brain_list` | What am I allowed to read? Also shows open handoffs waiting to be taken |
| `brain_brief` | What does this brain cover, and what is it known to be missing? |
| `brain_search` | Find what this project actually decided, before answering from general knowledge |
| `brain_read` | Open one note in full |
| `brain_verify` | Check a claim against the brain before acting on it — supported / contradicted / not_covered, with evidence. Unconfirmed claims are flagged to the owner as gaps |
| `brain_handoff` | The baton between sessions and agents: leave working state when you stop mid-task, and the next session — this agent or a different tool entirely — takes it and continues |
| `brain_write` | Save a convention or a pitfall worth keeping — on a brain you only read it goes to its owner as a proposal, so nothing you learn is thrown away |
| `brain_write_batch` | Save a whole set of notes from a training session in one call |
| `brain_feedback` | Report how a note held up in real use — wrong and outdated, or correct and useful. Shifts how it ranks for the next agent |
| `brain_create` | Start a new brain without leaving the editor |
| `brain_add_source` | Feed it documentation pages or a block of text |
| `brain_refresh` | Re-read a brain you own against its sources; only changed pages cost anything |
| `library_add` | Put a catalogue brain on your shelf without opening a browser |
| `library_remove` | Take one off again; the brain itself is untouched |

## Commands

- `/mozg:brains` — the map: what you can read and which one fits what you are doing
- `/mozg:add [subject]` — find a brain in the catalogue and shelve it from here
- `/mozg:sync` — write the shelf into `.mozg/brains.md` so every session starts knowing it
- `/mozg:update [handle]` — re-read your brains against their sources, then re-sync the map
- `/mozg:learn [handle]` — save what this session worked out back into a brain
- `/mozg:train <handle> <material>` — teach a brain from docs you point at, on your own subscription
- `/mozg:teach [handle]` — an interview that fills the brain's known gaps

## The shelf, locally

`/mozg:sync` writes `.mozg/brains.md` and offers to import it from `CLAUDE.md`.
After that the session-start hook names your brains offline, in milliseconds,
without a call — including private ones and whatever you added yesterday, which
no amount of guessing from `package.json` could know. Add a brain on the web or
with `/mozg:add`, re-run `/mozg:sync`, and this project knows about it.

The file is a map, never a copy: handles, goals and exam scores. Notes stay on
the server, where they keep being updated.

## The baton, before the context goes

The other hook runs just before Claude Code compacts the conversation — the
last moment the session still remembers what it was doing. Compaction takes
working state first, and nobody thinks to save it at the moment they are about
to lose the reason to. So the hook says it once: if this is mid-task, leave a
`brain_handoff`. Tomorrow's session — or a different agent on a different
machine — picks up the baton and continues from that exact point. Offline,
two lines, and silent in a project with no brains on its shelf.

## Nothing is downloaded

A brain is read live over MCP. It stays with its author and keeps improving as
they add to it, which a copy on your disk would not. If you do want it offline,
export any brain you can read as `CLAUDE.md`, a Claude Skill or `AGENTS.md` from
its page — that snapshot keeps working with no account at all.
