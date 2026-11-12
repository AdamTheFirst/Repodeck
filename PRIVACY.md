# Privacy policy

Repodeck is an app that runs on your own computer. Its makers do not operate any server for it and receive no data from it.

## What Repodeck does with your information

- **No account with us, no telemetry, no analytics, no advertising.** Repodeck does not collect, store or send information about you or your use of the app to its makers or to anyone else.
- **Your repositories stay on your computer.** Repodeck reads and changes them only through the `git` program installed on your computer, and only when you ask.
- **GitHub.** When you sign in to GitHub inside the app, the sign-in is handled by GitHub's own command-line program (`gh`). Repodeck then asks GitHub, as your account, for the things it shows you: your repositories, pull requests, issues and workflow runs. That traffic goes directly from your computer to GitHub and is covered by [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement). Repodeck never stores your GitHub token.
- **Update check.** A few times a day the app asks GitHub's public API for the number of the latest Repodeck release. The request contains no account, token or information about your computer or repositories. You can turn it off under Settings → About. The Microsoft Store version does not do this; the Store updates it.
- **Setup.** If a required tool is missing, Setup can download it from its official source (winget, git-scm.com via GitHub, cli.github.com via GitHub). Those downloads are ordinary web requests to those sites.

## What is kept on your computer

Settings, logs, a status cache, unsent review comments and safety copies of changes you discarded are kept in `%LOCALAPPDATA%\Repodeck`. Safety copies are deleted after 30 days. Uninstalling can delete this folder if you tick the box.

## Children

Repodeck is a developer tool and is not directed at children.

## Changes and contact

Changes to this policy are made in this file, with its history visible in the repository. Questions: open an issue at https://github.com/AdamTheFirst/Repodeck/issues.
