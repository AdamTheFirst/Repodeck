<p align="center"><img src="ui/icon-256.png" width="96" height="96" alt=""></p>
<h1 align="center">Repodeck</h1>
<p align="center">All your git repositories in one window: source control, commit graph, pull requests and GitHub Actions.</p>
<p align="center">
  <a href="https://github.com/AdamTheFirst/Repodeck/releases/latest/download/RepodeckSetup.exe"><b>Download for Windows</b></a>
  &nbsp;·&nbsp; <a href="https://github.com/AdamTheFirst/Repodeck/releases">All releases</a>
  &nbsp;·&nbsp; <a href="CHANGELOG.md">Changelog</a>
</p>

Repodeck is a small Windows app for people who work in many repositories at once. It shows every repository under your folders in one tree, highlights the ones that need attention, and gives you the everyday git and GitHub work without opening an IDE.

It runs entirely on your computer. A small local server drives the `git` and `gh` (GitHub CLI) programs you already have, and the interface opens in its own window. There are no other runtime dependencies, no account to create and no telemetry.

## Install

1. Download [`RepodeckSetup.exe`](https://github.com/AdamTheFirst/Repodeck/releases/latest/download/RepodeckSetup.exe).
2. Run it and follow the four steps.

Setup lets you choose:

- **Just me** (default): installs in your user profile. No administrator rights needed.
- **All users**: installs in Program Files for everyone on the computer. Windows asks for administrator rights once.
- The folder, a desktop shortcut, and whether to install missing tools.

**Required tools.** Repodeck needs Git, GitHub CLI and Node.js 20 or later. Setup shows which are present and installs the missing ones with `winget` if you leave the box ticked. You sign in to GitHub inside the app, not during setup.

Run Setup again later to update, repair or uninstall; it is also listed under Installed apps in Windows. Uninstalling keeps your settings unless you tick the box, and never touches your repositories.

> Setup is not code-signed yet. Windows SmartScreen may show "Windows protected your PC" the first time: choose **More info**, then **Run anyway**. On computers where **Smart App Control** is on, Windows blocks unsigned apps without that choice; there Repodeck can only be run from source until releases are signed. Each release lists SHA-256 checksums in `SHA256SUMS.txt`.

Requirements: Windows 10 or 11.

<details>
<summary>Command line options for Setup</summary>

| Option | Meaning |
| --- | --- |
| `/install`, `/repair`, `/uninstall` | What to do |
| `/quiet` | No window |
| `/allusers` | Install for everyone (asks for administrator rights) |
| `/dir "<folder>"` | Install somewhere else |
| `/desktop` | Add a desktop shortcut |
| `/notools` | Do not install missing tools |
| `/wipedata` | With `/uninstall`: also delete settings |
| `/portable` | No shortcuts and no Installed apps entry |

</details>

## What it does

**Repositories**
- Scans the folders you choose, including repositories nested inside other repositories.
- Highlights repositories with uncommitted changes, commits to push or pull, a merge or rebase in progress, or a locked index.
- Filter, saved filters, favourites, a "needs attention" view and quick open (Ctrl+P).
- Hide repositories you do not work on. They move to a Hidden section and stay out of counts, Fetch all and the Actions board.
- Clone, create, and open in Explorer, a terminal, your editor or on GitHub.

**Source control**
- Staged, changed, untracked and conflicted files as a list or a tree, with unified or side-by-side diffs.
- Stage, unstage or discard whole files, single hunks or individual lines.
- Every discard keeps a safety copy for 30 days, restorable from "Recently discarded".
- Commit, amend, undo, reword and squash; push, pull, fetch and sync; force push only with lease.
- After a fetch, a plain statement of where the branch stands: how far behind, with a Pull button.
- Branches, tags, remotes, worktrees, submodules and stashes.
- Merge conflicts: accept current, incoming or both per conflict; continue, skip or abort.
- File history, blame, and any file at any commit.

**Commit graph**
- Lanes for branches, remote branches, tags and stashes, plus a row for uncommitted changes.
- Filter by branch (all, local only, current, or a selection), author and date; search by message or hash.
- Compare any two commits; checkout, branch, tag, cherry-pick, revert, merge, rebase and reset from the menu.

**Pull requests**
- Lists for yours, review requested, assigned, merged and closed.
- Conversation, files, commits and checks; inline review comments and suggested changes.
- Create with template and reviewers, check out (forks too), update branch, merge and auto-merge.

**GitHub Actions**
- A board with the latest run on the default branch of every repository, using one GitHub request per account.
- Every push, sync or merge you make is followed until its workflows finish, with a Windows notification.
- Jobs, steps and logs with the error lines first; re-run, cancel and manual dispatch.

**Many repositories at once**
- Find every repository that has a feature branch, with its state, pull request and checks.
- Switch, pull, push or update all of them, create the pull requests together, or merge them in order.
- Bulk operations show what will run and what will be skipped, and why, before anything happens.

## Accounts and SSH

Each signed-in GitHub account is a separate workspace with its own folders, repositories, Actions board and pull requests. Switch from the account button at the top right, or open two accounts side by side in two windows. GitHub is only ever contacted as the open account.

- **Settings → Accounts & folders** sets whether an account connects with HTTPS or SSH. An account set to SSH uses its key for fetch, pull and push in every repository, including ones cloned with an `https://` address. The repositories themselves are not changed.
- **Settings → SSH connections** lists host aliases and keys, creates a connection, tests it against GitHub and removes it. The SSH config file is backed up before every change, and private keys are never read.
- **Settings → Git configuration** edits common global git settings. **Settings → Guides** explains the usual multi-account setups.

## Keyboard

| Key | Action |
| --- | --- |
| Ctrl+P | Go to a repository (type `>` for commands) |
| Alt+1 … Alt+7 | Changes, Graph, Branches, Stashes, Pull requests, Issues, Actions |
| Ctrl+Enter | Commit (in the message box) |
| ↑ / ↓, S, Delete, E | In the changes list: move, stage or unstage, discard, open in editor |
| F5 or Ctrl+R | Refresh |
| Ctrl+Shift+B | Actions board |
| Ctrl+click | Compare two commits in the graph |
| Shift+click / Ctrl+click | Select a range or more lines in a diff |

## Safety and privacy

- Nothing changes in your repositories unless you click something that says so. Background refresh only reads.
- Destructive actions ask first and say exactly what will be lost. Discards and hard resets keep a safety copy.
- Failures show git's real output and the exact command; every command is listed under **Activity**.
- The local server listens on `127.0.0.1` only and needs a per-start token. Repodeck never stores GitHub tokens.
- See [SECURITY.md](SECURITY.md) for the details and for how to report a vulnerability.

## Troubleshooting

- **"… cannot see this repository"**: the repository was deleted or renamed, or it belongs to another account. Switch accounts at the top right and add the folder to that account.
- **Push or fetch times out**: Repodeck cannot type passwords or SSH passphrases. Use Git Credential Manager (installed with Git for Windows) for HTTPS, or a key without a passphrase or ssh-agent for SSH.
- **"The index is locked"**: another git program is running in that repository, or one crashed. If none is running, delete `.git\index.lock`.
- **The window closed but Repodeck is still running**: the close button hides it to the tray. Click the tray icon to open it, right-click it to quit, or turn this off in Settings → Appearance & app.
- Logs are in `%LOCALAPPDATA%\Repodeck\logs`.

## Build from source

```
node server/main.js                    # run without installing
npm test                               # unit and integration tests, in throwaway repositories
npm run playground                     # the app against generated test repositories
powershell -File scripts\build.ps1     # Repodeck.exe and Setup, into dist\
```

There is no build step for the app and there are no npm dependencies. The build script uses the C# compiler that ships with Windows and downloads the WebView2 SDK from nuget.org, checked against a pinned SHA-256.

To publish a release, set the version in `package.json`, commit, and push a tag such as `v1.0.0`. The Release workflow tests, builds Setup and attaches it to the release.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the ground rules.

## Limitations

- Windows only, and GitHub.com only; GitHub Enterprise Server hosts are not detected as GitHub.
- Full interactive rebase is not offered; squash, reword, drop and reset cover the common cases.
- Hunk and line staging is not available for untracked or binary files.
- When run from source instead of installed, notifications appear under "Windows PowerShell".

## Code signing policy

Release files are built by GitHub Actions from the source in this repository ([release workflow](.github/workflows/release.yml)); nothing is built or signed on a personal computer. Signed releases, once available: free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

- **Committers and reviewers:** [AdamTheFirst](https://github.com/AdamTheFirst), the owner of this repository. Changes from anyone else arrive as pull requests and are reviewed before they are merged.
- **Approvers:** [AdamTheFirst](https://github.com/AdamTheFirst). Every signing request is approved by hand.

**Privacy.** This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. Repodeck talks to GitHub only through the `git` and `gh` programs on your computer, as the account you signed in with, and has no telemetry.

## License

[MIT](LICENSE)
