# Security

## How git-helper is exposed

git-helper runs a small HTTP server on your own machine so its window (a Microsoft Edge app window) can talk to it.

- It listens on `127.0.0.1` only. Other machines on your network cannot reach it.
- Every request must carry a random session token created at each start. The token is embedded in the page served to the app window and is never written anywhere other web pages can read.
- Requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` are refused (protection against DNS rebinding).
- Requests from any other web origin are refused, and the API only accepts `application/json`, so ordinary cross-site form posts cannot reach it.
- The API is a fixed list of operations. Repositories are addressed by an id from the scan of your configured folders; arbitrary paths are refused.
- The page uses a strict Content Security Policy (`script-src 'self'`). Text from repositories and from GitHub (branch names, file names, commit messages, pull request descriptions) is inserted as text, never as HTML. Markdown is rendered by building DOM nodes; raw HTML in Markdown is not rendered. Links open in your default browser.

## Commands and credentials

- git and the GitHub CLI (`gh`) are started with argument lists, never through a shell, so names and messages cannot inject commands.
- git-helper never stores tokens. When a repository owner is mapped to a GitHub account that is signed in to `gh` but not active, git-helper asks `gh auth token --user <account>` for that account's token, keeps it in memory for up to ten minutes, passes it to `gh` through the `GH_TOKEN` environment variable and removes it from anything it logs.
- Nothing is sent anywhere except by git and gh themselves. There is no telemetry.

## Data on disk

Settings, logs, a status cache, pending review comments and safety copies of discarded changes are kept in `%LOCALAPPDATA%\git-helper`. Safety copies can contain your source code; they are deleted after 30 days.

## Reporting a problem

Please open a private security advisory on the project's GitHub page, or contact the maintainer listed there. Do not file public issues for vulnerabilities.
