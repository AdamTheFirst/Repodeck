# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## 0.2.0 (unreleased)

- Renamed to Repodeck; settings and the previous install are migrated automatically
- New look in light and dark, new logo, animated loader and placeholder rows while loading
- Accounts are separate workspaces with their own folders; one window per account, several accounts side by side
- Setup wizard in four steps; nothing is selected or saved until you confirm
- Sidebar section for repositories on GitHub that are not cloned yet
- Hide repositories you do not work on: they move to a Hidden section in the sidebar and stay out of the counts and the Overview, and are not fetched by Fetch all or the periodic fetch (a setting, on by default); the Actions board leaves them out too (also a setting, on by default)
- Fetch all leaves alone repositories with no remote, and ones whose remote was not found or refused access last time, instead of failing on them every time
- GitHub page with clone status; Overview with one-click push, pull and review
- Settings reorganised: Accounts & folders in one place, SSH connections (create, test, remove, copy keys), Git configuration, and Guides
- An account set to SSH uses SSH for fetch, pull and push in every repository, including ones cloned with an https:// address; the repositories themselves are not changed
- Graph: “Local branches only” in the branch filter, branches listed as Local and Remote, and the author filter is a list of everyone with commits
- After a fetch the app says where the branch stands: how many commits behind, with a Pull button, or that it is up to date; the repository header shows “behind” and “ahead” counts
- Its own window instead of a Microsoft Edge app window: own taskbar name and icon, title bar in the app colour, remembered size and position
- Closing the window hides it to the tray (a setting, on by default); the tray icon opens it again or quits
- Setup.exe with Install, Repair and Uninstall and a clear finish screen; it never starts the app by itself

## 0.1.0

First version.

- Repository tree for many repositories, including repositories nested inside repositories, with "needs attention" highlighting
- Source control: staging down to single lines, discard with 30-day safety copies, commit, sync, branches, tags, stashes, conflict resolution, file history and blame
- Commit graph with compare, filters and commit, branch and tag actions
- Pull requests: lists, review with inline comments and suggestions, create, check out, merge, auto-merge
- GitHub Actions: board of every default branch, tracked runs with notifications, logs with errors first, re-run, cancel, manual dispatch
- Work across repositories: feature branches, bulk operations, branch cleanup, overview, commit search
- Accounts as separate workspaces: per-account folders and repositories, in-app sign-in, switch and sign-out
- GitHub page listing remote repositories with clone status
- Setup with Install, Repair and Uninstall; `Repodeck.exe` launcher
