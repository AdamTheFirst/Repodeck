# Security

## How Repodeck is exposed

Repodeck runs a small HTTP server on your own machine so its window can talk to it. The window is a WebView2 view that only ever loads that local address: links to other sites open in your default browser, and it has no browser profile, sign-in, sync or extensions.

- It listens on `127.0.0.1` only. Other machines on your network cannot reach it.
- Every request must carry a random session token created at each start. The token is embedded in the page served to the app window and is never written anywhere other web pages can read.
- Requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` are refused (protection against DNS rebinding).
- Requests from any other web origin are refused, and the API only accepts `application/json`, so ordinary cross-site form posts cannot reach it.
- The API is a fixed list of operations. Repositories are addressed by an id from the scan of your configured folders; arbitrary paths are refused.
- The page uses a strict Content Security Policy (`script-src 'self'`). Text from repositories and from GitHub (branch names, file names, commit messages, pull request descriptions) is inserted as text, never as HTML. Markdown is rendered by building DOM nodes; raw HTML in Markdown is not rendered. Links open in your default browser.

## Commands and credentials

- git and the GitHub CLI (`gh`) are started with argument lists, never through a shell, so names and messages cannot inject commands.
- Repodeck never stores tokens. Each window works as one GitHub account. If that account is signed in to `gh` but is not the one `gh` uses by default, Repodeck asks `gh auth token --user <account>` for its token, keeps it in memory for up to ten minutes, passes it to `gh` through the `GH_TOKEN` environment variable and removes it from anything it logs. Other signed-in accounts are never used.
- When an account is set to SSH, Repodeck rewrites `https://github.com/` addresses to that account's SSH connection for the one git command it runs. Repository settings are not changed.
- git's SSH runs with `StrictHostKeyChecking=accept-new`: a host seen for the first time is added to `known_hosts`, because there is no terminal to answer the question; a host whose key has changed is still refused. If you set `core.sshCommand`, `GIT_SSH_COMMAND` or `GIT_SSH` yourself, yours is used unchanged.
- Nothing is sent anywhere except by git and gh themselves. There is no telemetry.

## Data on disk

Settings, logs, a status cache, pending review comments and safety copies of discarded changes are kept in `%LOCALAPPDATA%\Repodeck`. Safety copies can contain your source code; they are deleted after 30 days.

## Reporting a problem

Please report vulnerabilities privately: on the repository's **Security** tab choose **Report a vulnerability** ([direct link](https://github.com/AdamTheFirst/Repodeck/security/advisories/new)). Do not file public issues for vulnerabilities.
