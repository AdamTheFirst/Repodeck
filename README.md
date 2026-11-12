# git-helper

A small Windows app for people who work in many git repositories at once. It shows every repository under your folders in one tree with the ones that need attention highlighted, and gives you source control, a commit graph, pull requests and GitHub Actions status in one window. It is built for working from a terminal, without an IDE.

It runs locally: a tiny Node.js server on `127.0.0.1` drives the `git` and `gh` (GitHub CLI) programs you already have, and the interface opens as a Microsoft Edge app window. It has no other dependencies and no telemetry.

## What it does

**Repositories**
- Scans the folders you choose, including repositories nested inside other repositories (for example a platform repository with independent service repositories inside it).
- Highlights repositories with uncommitted changes, unpushed or unpulled commits, a merge or rebase in progress, or a locked index. Also shows branch, how far a branch is behind the default branch, your open pull requests and the latest default-branch workflow result.
- Filter, favourites, "needs attention" view, quick open (Ctrl+P), clone, create, and open in Explorer, terminal, editor or GitHub.

**Source control**
- Staged, changed, untracked and conflicted files, as a list or a tree. Unified or side-by-side diffs with changed words highlighted. Images are shown before and after.
- Stage, unstage or discard whole files, single hunks or individual lines.
- Every discard keeps a safety copy for 30 days, restorable from "Recently discarded".
- Commit, amend, sign-off, skip hooks, commit and push, and commit and sync.
- Also: undo last commit, reword, squash unpushed commits, push/pull/fetch/sync, publish, and force push only with lease.
- Branches, tags, remotes, worktrees, submodules and stashes.
- Merge conflicts: accept current, incoming or both per conflict, or take a whole side. Continue, skip or abort merges, rebases, cherry-picks and reverts.
- File history, blame, and viewing a file at any commit.

**Commit graph**
- Lanes for all branches, remote branches, tags and stashes, plus an "uncommitted changes" row.
- Commit details with per-file diffs. Compare any two commits (Ctrl+click), or a commit with the working tree.
- Checkout, branch, tag, cherry-pick, revert, merge, rebase, reset, drop and copy actions from the context menu.
- Filters by branch, author and date; search by message or hash.

**Pull requests**
- Lists (yours, review requested, assigned, merged, closed) with filters.
- Pull request detail with conversation, files, commits and checks. Inline review comments on single lines or ranges, including suggested changes.
- Review threads (reply, resolve), viewed files, and approve or request changes.
- Create with template and reviewers; edit; check out (forks too); update branch; merge with the methods the repository allows; auto-merge.

**GitHub Actions**
- **Actions board:** the latest run on the default branch of every repository, grouped into failing, running and passing. It uses one GitHub request per account, however many repositories you have.
- **Tracked runs:** every push, sync or pull request merge you make in git-helper is followed until its workflows finish, and you get a Windows notification with a link to the failure.
- New commits pushed to a default branch from elsewhere are tracked too (optional).
- Run detail shows jobs, steps, and the log with the error lines first.
- Re-run all or only failed jobs, cancel, start a workflow manually with its inputs, and see deployment environments.

**Many repositories at once**
- **Feature branches:** find every repository with a branch, see its state, pull request and checks.
- Switch, pull, push, update from default or return to default in all of them at once.
- Create all the pull requests in one go with cross-links, or merge them in a chosen order, stopping at the first failure.
- Bulk operations with a preview of what will run and what will be skipped and why, then a result per repository.
- Branch cleanup (merged branches, or branches whose remote was deleted); an overview of everything uncommitted, unpushed or stashed; commit search across all repositories.

## Install

Download or clone this repository, then double-click `installer\Install.cmd`.

The installer:
1. Checks for Git, GitHub CLI and Node.js and, after asking, installs missing ones with `winget` (package ids `Git.Git`, `GitHub.cli`, `OpenJS.NodeJS.LTS`).
2. Copies git-helper to `%LOCALAPPDATA%\Programs\git-helper` and adds Start menu and (optionally) desktop shortcuts and an uninstall entry. No admin rights are needed for this part.
3. Offers to sign in to GitHub (`gh auth login`) and to set your git name and email if they are not set.

Re-running the installer upgrades in place and keeps your settings. To remove it, use Settings → Apps → Installed apps → git-helper, or run `installer\uninstall.ps1`. Git, GitHub CLI and Node.js stay installed.

Requirements: Windows 10 or 11 with winget (App Installer) for automatic tool installation, or Git 2.30+, GitHub CLI 2.40+ and Node.js 20+ installed yourself.

### Run without installing

```
node server/main.js
```

## First start

Choose the folders that contain your repositories. Then open **Settings → Diagnostics → Run check**: it verifies that each remote is reachable and which GitHub account can see it.

## Keyboard

| Key | Action |
| --- | --- |
| Ctrl+P | Go to a repository (type `>` for commands) |
| Alt+1 … Alt+7 | Changes, Graph, Branches, Stashes, Pull requests, Issues, Actions |
| Ctrl+Enter | Commit (in the message box) |
| ↑ / ↓, S, Delete, E | In the changes list: move, stage/unstage, discard, open in editor |
| F5 or Ctrl+R | Refresh |
| Ctrl+Shift+B | Actions board |
| Ctrl+click | Compare two commits in the graph |
| Shift+click / Ctrl+click | Select a range / more lines in a diff |

## Several GitHub accounts and SSH host aliases

Remotes such as `git@github.com-work:owner/repo.git` use a host alias from your SSH config, which the GitHub CLI cannot map to a repository by itself. git-helper reads the owner and repository name from the remote URL and passes them to `gh` explicitly, so aliases work.

If you are signed in to `gh` with more than one account, git-helper finds the account that can see each owner and remembers it. You can override the choice, or turn automatic detection off, in **Settings → GitHub accounts**.

## Safety

- Nothing changes in your repositories unless you click something that says so. Background refresh only reads; background fetch is off by default.
- Destructive actions ask first and say exactly what will be lost. Discards and hard resets keep a safety copy.
- One operation per repository at a time. Failures show git's real output and the exact command; every command is listed under **Activity**.
- See [SECURITY.md](SECURITY.md) for how the local server is protected.

## Troubleshooting

- **"No access with the GitHub account used for …"**: pick another account for that owner in Settings, or run `gh auth login` with an account that can see it.
- **Push or fetch times out**: git-helper cannot type passwords or SSH passphrases. Use Git Credential Manager (installed with Git for Windows) for HTTPS, or load your key into ssh-agent.
- **"The index is locked"**: another git program is running in that repository, or one crashed. If none is running, delete `.git\index.lock`.
- **Notifications do not appear**: allow notifications for "Windows PowerShell" in Windows Settings → System → Notifications.
- Logs are in `%LOCALAPPDATA%\git-helper\logs`.

## Development

```
npm test                 # unit and integration tests (throwaway repositories in %TEMP%)
npm run playground       # starts the app against a generated set of test repositories
node scripts/make-icon.js
```

No build step and no npm dependencies.

## Limitations

- GitHub.com only; GitHub Enterprise Server hosts are not detected as GitHub.
- Full interactive rebase is not offered (squash recent commits, reword, drop and reset cover the common cases).
- Hunk and line staging is not available for untracked files (stage the whole file) or binary files.
- Notifications appear under "Windows PowerShell" in the Windows notification centre.
