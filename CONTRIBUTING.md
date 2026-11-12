# Contributing

Thanks for looking. A few rules keep this project reliable.

## Ground rules

- **No runtime dependencies and no build step** for the app. Node.js built-ins on the server, plain ES modules in the UI.
- **Never build a command line from text.** git and gh are started with argument arrays (`server/proc.js`). Messages go in through stdin.
- **Machine-readable output only**: `--porcelain=v2 -z`, `for-each-ref --format`, `gh --json`. Do not parse text meant for people.
- **Nothing happens to a repository unless the user clicked something that says so.** Background work is read-only.
- **Destructive actions confirm first** and say exactly what is lost. Discards keep a safety copy.
- **Untrusted text is never HTML.** Use the `h()` helper; do not assign `innerHTML`.
- GitHub calls always pass `-R owner/repo` and run as the open account only.

## Working on it

```
npm test              # unit + integration tests; creates throwaway repositories in %TEMP%
npm run playground    # the app against generated test repositories, with separate settings
```

Tests that change repositories must use the helpers in `test/helpers.js`. Never point tests at real repositories.
GitHub behaviour is tested against a stubbed `gh` (`test/integration/gh.test.js`) with hand-written fixtures; do not commit recorded output from real repositories.

## Layout

- `server/` local HTTP server, git and gh layers, state and polling
- `ui/` the interface (no framework)
- `installer/src/` Setup and launcher sources (C#, compiled by `scripts/build.ps1`)
- `test/` unit and integration tests

## Pull requests

Keep them small, include a test for behaviour changes, and add a line to `CHANGELOG.md`.
