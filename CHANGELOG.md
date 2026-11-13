# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## 1.1.2

- Every repository tab shows a count when there is something under it: unpushed commits, branches, stashes, open pull requests, open issues, failing or running workflow runs
- The sidebar shows each repository's number of open pull requests
- A workflow run's steps are a proper list, one per line

## 1.1.1

- Node.js is included with the app, so Setup only needs Git and GitHub CLI (Setup is about 30 MB now)

## 1.1.0

- Update check: the app says when a newer version is out, with a Download button; also under Settings → About, where it can be turned off
- Microsoft Store package (`scripts/build-store.ps1`), with its own copy of Node.js

## 1.0.2

- The taskbar shows the current icon after an update instead of a cached old one
- Setup: the "Install for" choice was partly covered on the options page
- Setup: who-and-where and tools-and-shortcuts are separate pages
- Setup: on a computer without winget, Git, GitHub CLI and Node.js are downloaded from their official sites, checked for a valid publisher signature, and installed
- Setup: a folder that is read-only or already holds other files is refused when you pick it, with a clear message
- Both exe files carry the product name and version (Properties, Details)
- The release workflow can code-sign the app and Setup through SignPath once the project is accepted there

## 1.0.1

- Setup is now named `RepodeckSetup.exe`
- Setup and the app show their icon in Explorer, in browsers' download lists and on the taskbar at every size
- The icon has no background tile
- Tests run on Node 20 as well as Node 22

## 1.0.0

First public release.

**Repositories**
- One tree for many repositories, including repositories nested inside repositories, with the ones that need attention highlighted
- Favourites, saved filters, and a Hidden section for repositories you do not work on
- A section for repositories on GitHub that are not cloned yet; a GitHub page with clone status
- Fetch all leaves alone hidden repositories, repositories with no remote, and ones whose remote was not found or refused access last time
- After a fetch the app says where the branch stands: how many commits behind, with a Pull button, or that it is up to date

**Source control**
- Staging down to single lines, discard with 30-day safety copies, commit, sync, branches, tags, stashes, conflict resolution, file history and blame
- Commit graph with compare, commit, branch and tag actions, and filters by branch (all, local only, current), author and date

**GitHub**
- Pull requests: lists, review with inline comments and suggestions, create, check out, merge, auto-merge
- Actions: a board of every default branch, tracked runs with notifications, logs with errors first, re-run, cancel, manual dispatch
- Work across repositories: feature branches, bulk operations, branch cleanup, overview, commit search

**Accounts**
- Each GitHub account is a separate workspace with its own folders; one window per account, several side by side
- An account set to SSH uses SSH for fetch, pull and push in every repository, including ones cloned with an https:// address
- Settings for SSH connections (create, test, remove, copy keys), global git configuration, and guides for multi-account setups

**App and Setup**
- Its own window with its own taskbar name and icon; closing it hides it to the tray (a setting)
- Light and dark themes
- Setup wizard: install for one user or all users, choose the folder, update, repair and uninstall; it never starts the app by itself
