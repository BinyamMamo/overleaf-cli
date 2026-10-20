# olf browser extension (optional)

Shows which sections an olf agent is editing in the Overleaf editor, and asks
before you type inside one. olf works without it: the claim comment and the
agent's cursor already show where the agent works.

Supported: Chrome, Edge, Brave (Manifest V3). Not supported yet: Firefox, Safari.

## Install

- **No install:** `olf browser "<project>"` opens Chrome with the extension
  loaded and paired.
- **Your own browser:** `olf extension install --browser edge` (or chrome,
  brave). It prepares a paired copy, copies its path to the clipboard and
  opens the extensions page. Then: turn on **Developer mode**, click
  **Load unpacked**, paste the path.
- **From the zip:** load the unzipped folder as above, then run
  `olf extension pair` and paste the code into the extension's popup.

## What you see

- The claimed section is tinted and tagged "Agent editing".
- A note says what the agent is doing, whether it edits directly or suggests,
  and how many edits it made.
- If you type in a claimed section: **Wait** or **Edit anyway**. Edit anyway
  pauses the agent (the tint turns grey). When you finish, press
  **Done, let it continue**.

## Privacy and security

The extension runs only on overleaf.com project pages. It talks only to olf on
`http://127.0.0.1:47321`, and olf answers only requests that carry the pairing
code (`olf extension pair --rotate` replaces it). Nothing leaves your computer.

It reads Overleaf's own page (line numbers, the active line, the file tree).
If Overleaf changes that markup, the extension stops drawing until it is
updated; olf itself keeps working.
