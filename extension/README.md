# olf browser extension (optional)

Shows which sections an olf agent is editing in the Overleaf editor, and asks
before you type inside one. olf works without it. The extension only adds
these visual cues.

## Install (Chrome or Edge)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this `extension` folder.

## What you see

- A band down the left of each claimed section, tagged "Agent editing".
- A short banner saying what the agent is doing.
- If you type in a claimed section: a dialog with **Wait** and **Edit anyway**.
  Edit anyway pauses the agent (the band turns grey). When you finish, press
  **Done, let it continue** in the banner.

## How it talks to olf

It asks `olf-mcp` on `http://127.0.0.1:47321` (this machine only) for the
claims of the open project. Nothing leaves your computer. If `olf-mcp` is not
running, the extension shows nothing.

It reads Overleaf's own page (line numbers, the active line, the file tree).
If Overleaf changes that markup, the extension stops drawing until it is
updated. The comment, the agent's cursor and pausing still work.
