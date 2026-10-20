# Security Policy

This is **overleaf-cli (olf)**, a fork of [olcli](https://github.com/aloth/olcli),
maintained by Binyam Mamo. Report problems in olf here, not to the upstream
maintainer. Only the latest commit on `main` is supported.

**Please report security issues privately**, not in a public issue:
[report a vulnerability](https://github.com/BinyamMamo/overleaf-cli/security/advisories/new)
on GitHub. Include the olf commit, whether the instance is overleaf.com or
self-hosted, and how to reproduce it. If the issue is in code inherited
unchanged from olcli, it may also affect upstream; say so and we will pass it on.

## What olf stores

| What | Where | Notes |
|---|---|---|
| Session cookie | olf config file (`olf check` prints the path) | Plain JSON. Grants access to the whole Overleaf account |
| Login browser profile | `browser-profiles/` next to the config | Can renew the session. `olf logout` deletes it |
| Extension pairing code | `bridge-token` next to the config (mode 600) | `olf extension pair --rotate` replaces it |
| Agent task log | `tasks/` next to the config | Contains before/after text of agent edits |
| Pull base copies | `.olf/base/` in each pulled project folder | Copies of your own files |

The account password is stored only with `--save-password`. Credentials showing
up anywhere else (output, logs, other folders, network requests to other hosts)
is a bug worth reporting.
