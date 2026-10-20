# olf browser extension (optional)

Shows and steers what an olf agent does in Overleaf. olf works without it:
the claim comment and the agent's cursor already show where the agent works.

Supported: Chrome, Edge, Brave (Manifest V3). Not supported yet: Firefox, Safari.

## Install

- **No install:** `olf browser "<project>"` opens Chrome with the extension
  loaded and paired.
- **Your own browser:** `olf extension install --browser edge` (or chrome,
  brave). It prepares a paired copy, copies its path to the clipboard and
  opens the extensions page. Then: turn on **Developer mode**, click
  **Load unpacked**, paste the path.
- **From the zip** ([download](https://github.com/BinyamMamo/overleaf-cli/releases/latest/download/olf-extension.zip)):
  load the unzipped folder as above, open the olf panel, run
  `olf extension pair` and paste the code.

## In the editor

- The claimed section is tinted and tagged "Agent editing".
- A note says what the agent is doing, whether it edits directly or suggests,
  and how many edits it made. "Open the olf panel" opens the side panel.
- If you type in a claimed section: **Wait** or **Edit anyway**. Edit anyway
  pauses the agent (the tint turns grey). When you finish, press
  **Done, let it continue**.

## The side panel

Click the olf icon in the toolbar. The panel follows the Overleaf project in
the active tab.

| Tab | What it shows |
|---|---|
| Now | Sections the agent has claimed, with Pause, Let it continue, and Show in editor |
| Review | Pending suggestions as a word diff, with Accept and Reject |
| History | Each agent task and its changes; Undo shows which edits can still be reverted, then asks |
| Snapshots | Git snapshots: save one, compare with now, restore (after a plan and a confirmation) |

The status line says whether the agent is connected, its edit mode, and the
result of the last build.

## Privacy and security

The content script runs only on overleaf.com project pages. The extension
talks only to olf on `http://127.0.0.1:47321`, and olf answers only requests
that carry the pairing code (`olf extension pair --rotate` replaces it).
Nothing leaves your computer. Permissions: `storage` (the pairing code) and
`sidePanel`.

It reads Overleaf's own page (line numbers, the active line, the file tree and
outline). If Overleaf changes that markup, the in-editor drawing stops until it
is updated; the side panel and olf itself keep working.

olf is not affiliated with or endorsed by Overleaf. The icon adapts the
Overleaf mark; Overleaf is a trademark of its owner.
