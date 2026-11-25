# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## 1.3.1

- "Working…" no longer stays on with many repositories. Coming back to the window re-read every repository and waited for it, which takes many seconds with dozens of them; now it re-reads the open repository at once and all of them at most every two minutes. What the app does by itself in the background (following changes, tab counts, the repository list from GitHub) is not shown as waiting any more, and routine status reads that overlap share one round instead of queueing a second one (that queueing came in with 1.3.0)
- The count on the Branches tab is read again when a branch actually moved, not on every status read
- New pull request: in a narrow window, or with a very long branch name in the list, the form ran off the right edge. The commits now move below the form and the base branch list is capped in width
- Merging in a repository that deletes merged branches itself: "Reference does not exist" is no longer reported or listed as a failure
- The pills at the top right keep to one line in a narrow window
- Compare branches: the dialog opens on the first changed file instead of an empty box, marks the file that is shown, and says so when there is nothing to compare

## 1.3.0

- Pull requests can always open into a branch you choose, for example `develop`. Set it for every repository under Settings → Behaviour, or for one repository on the New pull request page ("Always use … for this repository"). The branch is used when the repository has it; otherwise the default branch is used and the page says so. Feature branches → Create pull requests follows the same setting
- New pull request: changing the base branch reloads the commits, and the title and description as long as you have not edited them. The page uses the width of the window, with the commits beside the form
- Write with Copilot: a button in the commit box writes the commit message from the changes about to be committed, and one on the New pull request page writes the title and description from the branch's commits and diff, filling in the repository's template when there is one. It runs the GitHub Copilot CLI as the open account, sends nothing until you press it, asks once, and can be undone. Hide the buttons under Settings → Behaviour
- Five more themes: Ember (orange), Midnight (blue) and Orchid (violet) are dark, Sand and Sky are light. Settings → Appearance shows a preview of each
- Every dark theme, Dark included, now has a true black background; the dark themes differ only in their accent colour
- Buttons show a spinner and ignore a second click while their action runs, a thin line under the top bar shows when the app is waiting for an answer, and a repository's header buttons are off while an operation runs in it
- The sidebar, the repository header and the open tab follow a change at once. After a merge with clean-up, the new branch and the counts are there without clicking the repository
- The commit graph and the Branches tab reload when the repository changes underneath them. The Actions board and the review and failing counts at the top refresh after a pull request is created, closed, merged or reviewed
- After a merge without clean-up the repository is fetched, so the base branch shows what there is to pull
- Branch cleanup: "Fetch and prune all" prunes; before, it only fetched
- Changes tab: the pane beside the file list says where the branch stands, shows its pull request and lists the commits waiting to be pushed
- Smaller things on every page: placeholders while a page loads instead of an empty pane, search boxes that keep the cursor while the list updates, empty states that say what to do next, the same words for the same thing ("passed", "failed"), issue and pull request pages that use the window's width, and headings whose buttons no longer get squeezed

## 1.2.1

- Pull requests: while a merge runs, the page is dimmed, says what is happening (merging, cleaning up, refreshing) and cannot be clicked, until the merged state is on screen. Before, nothing happened for a few seconds and the page could stay on the open pull request after the message. The same goes for close, reopen, draft and ready, update branch, check out, clean up and posting a comment

## 1.2.0

- Pull requests: after a merge, one step switches to the base branch, pulls it, and deletes the merged branch in your folder and on GitHub. Tick it in the merge box, or use "Clean up branch" on a pull request that is already merged. It asks first when you have uncommitted changes (stash or bring along) or are on an unrelated branch (stay or switch). A branch with commits that were not part of the pull request is kept, with a button to delete it anyway. Whatever could not be done is explained, and the rest still happens
- Actions board: checks for new runs the moment you open it and keeps the faster refresh for as long as it is on screen. Before, the first refresh could take up to two minutes, and the board slowed down again after five

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
