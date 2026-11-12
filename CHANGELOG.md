# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

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
