# Working live with an agent

olf lets an AI agent (Claude Code, Cursor, anything that speaks MCP) edit an
Overleaf project while you keep writing in the browser. The agent's edits
reach your editor as you watch, the same way a co-author's do. Nothing you
type gets overwritten.

## How it works

Overleaf's editor sends small edit operations over a live socket and merges
concurrent edits with operational transformation (OT). olf joins the same
socket and sends its edits the same way, so the server merges them with yours.
Uploading a whole file, as olcli does, would replace the file.

On top of that, the agent follows a few rules:

1. **It claims a section before it edits.** A claim covers one `\section` or
   `\subsection`. The section gets an open comment that says what the agent is
   doing, so it is highlighted in the editor, and the agent's cursor sits there.
2. **It edits only inside its claim.** Each change replaces one exact piece of
   text. If the text changed in the meantime, the edit is refused and the agent
   reads the section again.
3. **It steps back when you type in its section.** The claim pauses at once,
   the agent posts "Paused" in the comment, and every further edit is refused.
   Reply **done** in that comment (or "continue", "ok", "go ahead", or resolve
   it) and the agent re-reads the section and carries on.
4. **It leaves the PDF compiling.** Before it releases a claim, olf compiles
   the project. If there are LaTeX errors, the claim stays open and the agent
   gets the errors to fix.
5. **Every task can be undone.** Each edit is logged locally.
   `olf undo <task>` reverts a task's edits, but only where the agent's text
   is still unchanged. Anything you rewrote since is left alone.

## Setup

```bash
olf login                     # a browser window opens; sign in any way you like
claude mcp add olf -- olf-mcp # or add olf-mcp to Cursor/Claude Desktop
```

`olf login` keeps its own browser profile. When the session cookie expires,
olf gets a new one from that profile without opening a window. You only see
the login window again if Overleaf really logs you out.

### Use a second account for the agent

Make a free Overleaf account for the agent, sign in to it with `olf login`,
and invite it to your project as a collaborator. Then its edits, cursor and
comments carry its own name and colour, and Overleaf's history shows who
wrote what. If its cookie ever leaks, only that account is exposed, and you
can remove it from a project in one click. The free plan allows one
collaborator per project, which is enough for this.

Using your own account also works, but then the agent's edits show up under
your name.

## Tools the agent gets

| Tool | What it does |
|---|---|
| `live_status` | Mode, active claims (with any replies you wrote), docs, who is online |
| `live_read` | Current live text of a doc or one section |
| `claim_section` | Claim a section with a short task description |
| `live_replace` | Replace exact text inside the claim, as live edits |
| `claim_status` | Paused or active, plus your replies; can wait for "done" |
| `release_claim` | Compile, then release (or return errors) |
| `suggest_edit` | Put a suggestion in a comment; you reply "accept" or "reject" |
| `check_suggestions` | Apply accepted suggestions, drop rejected ones |
| `set_edit_mode` | `direct` edits or `suggest` (every edit becomes a suggestion) |
| `undo_task`, `task_log` | Revert or review earlier tasks |

Overleaf's tracked changes need a paid plan, so suggestions use comments,
which work on every plan.

## Terminal commands

| Command | What it does |
|---|---|
| `olf login [--profile name]` | Sign in through a browser window |
| `olf tasks [project] [--diff]` | Recent agent tasks and what they changed |
| `olf undo [task] [project]` | Undo a task's edits, live |
| `olf push`, `olf sync` | Text files are merged as live edits (see below) |

### Push and sync merge

`olf pull` keeps a copy of what it downloaded in `.olf/base/`. `olf push` and
`olf sync` use that copy to merge three ways: your changes since the pull are
moved past the changes others made since the pull, then sent as live edits.
Both sides survive, and the local file is updated to the merged text. A file
the agent has claimed is skipped while the claim is open. Binary files still
upload as before. Set `OLF_LIVE_PUSH=off` to use plain uploads.

## The optional browser extension

`extension/` holds a small Chrome/Edge extension. olf works without it. With
it, a claimed section gets a coloured band and a banner, and typing inside it
first asks "Edit anyway?". If you choose to edit, the agent pauses, and a
"Done, let it continue" button resumes it. See
[extension/README.md](../extension/README.md).

## Limits

- Overleaf has no public API, so all of this rests on the web editor's own
  socket protocol. An Overleaf update can break it until olf is patched.
- The agent's claims live in the `olf-mcp` process. If it stops, its claims
  are released the next time it starts on that project.
- Undo is text-based. If you edited the agent's sentence afterwards, that
  edit is kept and the sentence is reported as skipped.
