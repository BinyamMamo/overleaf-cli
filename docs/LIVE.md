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
   Reply exactly **done** in that comment (or "continue", "resume", "ok"; the
   whole reply must be that one word), or resolve the comment, and the agent
   re-reads the section and carries on. "not done yet" does nothing.
4. **It leaves the PDF compiling.** Before it releases a claim, olf compiles
   the project. If there are LaTeX errors, the claim stays open and the agent
   gets the errors to fix.
5. **Every task can be undone.** Each edit is logged locally.
   `olf undo <task>` reverts a task's edits, but only where the agent's text
   is still unchanged. Anything you rewrote since is left alone.

## Setup

```bash
olf login                     # a browser window opens; sign in any way you like
olf setup claude-code         # or codex, cursor, claude-desktop, windsurf
olf doctor                    # check every stage
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
| `suggest_edit` | Put a suggestion in a comment; you reply exactly "accept" or "reject" |
| `check_suggestions` | Apply accepted suggestions, drop rejected ones |
| `set_edit_mode` | `direct` edits or `suggest` (every edit becomes a suggestion) |
| `undo_task`, `task_log` | Revert or review earlier tasks |
| `open_in_browser` | Open the project for the person, signed in, extension loaded |

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
olf fails closed: when the base is missing, both sides changed the same words,
the live connection fails, or the agent has claimed the section, the file is
skipped and left unchanged on Overleaf, with the reason. `--overwrite` makes
Overleaf match your file instead (still sent as live edits when possible).
Every file reports its transport (`live edit`, `live merge`, `live overwrite`,
`uploaded (new)`, `REPLACED`, `skipped`); `--json` prints them for scripts.
Binary files still upload whole. `OLF_LIVE_PUSH=off` turns live pushing off,
in which case text files are skipped unless you pass `--overwrite`.

## The optional browser extension

`extension/` holds a small Chrome, Edge and Brave extension. olf works without
it. With it, a claimed section is tinted, a note shows the task and the edit
mode, and typing inside the section first asks "Edit anyway?". Choosing to
edit pauses the agent; "Done, let it continue" resumes it.

The easiest way to get it is `olf browser "<project>"`, which opens Chrome with
the extension already loaded and paired. For your own browser, run
`olf extension install --browser edge` (or chrome, brave). The extension talks
only to olf on `127.0.0.1`, and only with the pairing code olf created. See
[extension/README.md](../extension/README.md).

## Limits

- Overleaf has no public API, so all of this rests on the web editor's own
  socket protocol. An Overleaf update can break it until olf is patched.
- The agent's claims live in the `olf-mcp` process. If it stops, its claims
  are released the next time it starts on that project.
- Claims are a signal between you and the agent, not a lock enforced by
  Overleaf. The compile check runs after the edits; a failed compile keeps the
  claim open but does not roll anything back.
- Undo is text-based. If you edited the agent's sentence afterwards, that
  edit is kept and the sentence is reported as skipped.
