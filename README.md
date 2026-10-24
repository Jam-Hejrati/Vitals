# Vitals

> `npm outdated` tells you a newer version exists.
> **Vitals tells you whether the packages you depend on are alive, finished, or dying.**

![Vitals checking a project: request and left-pad are deprecated, colors is abandoned, and each comes with what to use instead](docs/demo/demo.gif)

A package can be fully up to date, have no known vulnerabilities, and still be abandoned. Vitals
looks at the **maintenance health** of every package in your lockfile (direct and transitive), tells
you which ones are a risk and why, and points at the dependency to change.

**Status: early preview (0.x).** It works and is tested, but the verdicts are young. Please open an
issue when one looks wrong; that is how the model gets better.

## Quick start

```bash
npx dependency-vitals          # in a folder with a package-lock.json or pnpm-lock.yaml
npx dependency-vitals --all    # include healthy packages
npx dependency-vitals --json   # machine-readable report
```

Requires Node.js 22.12 or newer. No setup, no account, no token needed. The command is `vitals`
once installed (`npm i -g dependency-vitals`).

## What you get

```text
Vitals · known · package-lock.json
302 packages checked (23 direct)

✖  request@2.88.2  DEPRECATED  (direct)
    · deprecated: "request has been deprecated, see https://github.com/request/request/issues/3142"
    → instead: fetch (built in), ofetch, ky
    Also brings in 4 packages that need attention:
      ✖ uuid@3.4.0  deprecated  version 3.4.0 is deprecated: "Please upgrade to version 7 or hig… → upgrade to 14.0.3
      ✖ sshpk@1.18.0  abandoned  no release in 3 years, no commits in the last 90 days, 30 open issues…
      ▲ tweetnacl@0.14.5  stale  no release in 6 years, no commits in the last 90 days, 171 KB of code
      ▲ psl@1.15.0  stale  no release in 22 months, no commits in the last 90 days, 28 open issues…

20 deprecated · 6 abandoned · 3 stale · 132 finished · 141 active
```

Every package gets one of these verdicts, always with the evidence behind it:

| Verdict        | Meaning                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **deprecated** | The author deprecated it (or your installed version). Overrides everything else.                                                     |
| **abandoned**  | Long without releases, no repository activity, **and** evidence of neglect (a pile of unanswered issues, or an archived repository). |
| **stale**      | Activity has stopped on a non-trivial package, without clear evidence of neglect yet.                                                |
| **finished**   | Small, stable and inactive, with little unmet demand (`ms`, `inherits`). Healthy.                                                    |
| **active**     | Recent releases or commits.                                                                                                          |

Problems are grouped under the **direct dependency that brings them in**, so you see "replacing
`request` fixes these 5 packages" instead of a flat list of 40 warnings. Problems that several of your
dependencies bring in are listed separately, with their sources.

**Finished is not abandoned.** A tiny package with no release in years (`inherits`, `ms`, `co`) is
often simply done. Vitals weighs package size and open issues against how widely the package is used
before calling anything abandoned.

## Use it in CI

### GitHub Action

Fail a pull request only when it **adds** an unhealthy dependency (existing ones are not your PR's
problem), and say why in a comment on the pull request:

```yaml
# .github/workflows/dependency-health.yml
name: Dependency health
on: pull_request
permissions:
  contents: read
  pull-requests: write # for the comment
jobs:
  vitals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Jam-Hejrati/Vitals@v1
```

The comment lists every new problem with the reason, the dependency that brings it in, and what to
use instead. It is updated on every push, and only created when there is something to report. The
same report goes to the job summary.

| Input          | Default        | Description                                                                        |
| -------------- | -------------- | ---------------------------------------------------------------------------------- |
| `fail-on`      | `abandoned`    | `deprecated`, `abandoned` or `stale`                                               |
| `directory`    | `.`            | Folder with the lockfile                                                           |
| `base`         | PR base branch | Git ref to compare with; `none` checks every package                               |
| `prod`         | `false`        | Ignore packages that are only used for development                                 |
| `comment`      | `true`         | Comment on the pull request                                                        |
| `version`      | `latest`       | Version of `dependency-vitals` to run                                              |
| `github-token` | `github.token` | For the comment, and the GitHub checks (archived repositories, single maintainers) |

Outputs: `passed` (`true`/`false`), `status` (`pass`, `warn` or `fail`) and `report` (path to the
Markdown report). Pull requests from forks get a read-only token, so they get the job summary but no
comment.

### Any other CI

```bash
npx dependency-vitals --ci                          # exit code 1 when the check fails
npx dependency-vitals --ci --markdown report.md     # also write the report as Markdown
```

The base branch has to be in the clone (with `actions/checkout`, `fetch-depth: 0`). On a GitHub pull
request the base defaults to `origin/$GITHUB_BASE_REF`. Elsewhere, pass it yourself:

```bash
vitals --ci --base origin/main --fail-on abandoned
```

- `--fail-on deprecated | abandoned | stale` sets how bad a new dependency must be to fail
  (default: `abandoned`, which includes deprecated).
- A package counts as **new** when its name is not in the base lockfile, so upgrading an existing
  dependency never trips the check.
- Exit code `0` passes, `1` fails, `2` is an error. With `--json` the verdict is in the `ci` field.

## Options

| Option              | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `--all`             | List healthy packages too, and every nested problem                  |
| `--prod`            | Ignore packages that are only used for development                   |
| `--json`            | Print the full report as JSON (`schemaVersion` is included)          |
| `--markdown <file>` | Also write the report as Markdown (`-` prints it instead)            |
| `--no-github`       | Do not use the GitHub API even if a token is set                     |
| `--no-color`        | Disable colors (also set by `NO_COLOR`)                              |
| `--ci`              | Check mode for CI, see above                                         |
| `--base <git-ref>`  | With `--ci`: only check packages that are new compared with this ref |
| `--fail-on <level>` | With `--ci`: `deprecated`, `abandoned` or `stale`                    |

## Optional: GitHub signals

Set `GITHUB_TOKEN` (or `GH_TOKEN`) and Vitals also checks your direct dependencies and any inactive
package on GitHub:

- **Archived repositories**: read-only means no more fixes.
- **Single maintainers**: one person wrote almost all recent commits (bots are ignored; npm's own
  "maintainers" list is not used because it says who can publish, not who works on the code).

Without a token, everything else works unchanged.

### Getting and setting a token

1. Create a token at <https://github.com/settings/personal-access-tokens/new>: choose **Public
   repositories (read-only)** and grant no permissions. Vitals only reads public data. (A classic
   token with no scopes also works.) If you use the GitHub CLI, `gh auth token` prints one.
2. Put it in the environment before running Vitals:

   ```powershell
   # Windows PowerShell: this terminal only
   $env:GITHUB_TOKEN = "your-token"
   # ...or for every new terminal
   setx GITHUB_TOKEN "your-token"
   ```

   ```bash
   # macOS / Linux
   export GITHUB_TOKEN=your-token
   ```

3. Run `vitals` as usual. The report no longer ends with the "set GITHUB_TOKEN" tip.

The token is read only from the environment (`GITHUB_TOKEN`, or `GH_TOKEN` as the GitHub CLI uses),
never from a command-line flag, so it does not end up in your shell history. In GitHub Actions the
built-in `secrets.GITHUB_TOKEN` is enough (see the workflow above). Use `--no-github` to skip GitHub
even when a token is set.

## Where the data comes from

- [deps.dev](https://deps.dev) (Google): release history, deprecation, repository, OpenSSF Scorecard
- The [npm registry](https://registry.npmjs.org) and download counts: package size, popularity
- The [GitHub API](https://docs.github.com/rest) (optional)
- [`module-replacements`](https://github.com/es-tooling/module-replacements) by the e18e community
  (MIT): the "instead" suggestions. These are advice only and never change a verdict.

Results are cached on disk (`VITALS_CACHE_DIR` to move it), so repeat runs take a fraction of a
second. A first run on a big project takes about 10 seconds.

## Known limitations

- Reads `package-lock.json` (v2/v3) and `pnpm-lock.yaml` (v9). Yarn and Bun are not supported yet.
- Open-issue counts are per repository, so a small package inside a big monorepo inherits the whole
  repository's backlog.
- Packages that are superseded by a built-in feature but still small and stable (for example
  `source-map-support`) can look healthy.
- Thresholds are first estimates, tuned on a hand-labelled set of 65 packages and a review of about
  4,300 packages from 12 real projects. Expect the occasional wrong call near a boundary.

## Development

```bash
pnpm install
pnpm build         # compile everything
pnpm test          # run the tests (offline)
pnpm lint
pnpm vitals .      # run the CLI from source on this repository
```

The scoring is pinned by a **golden set**: `packages/core/test/golden/labels.json` lists packages
whose correct verdict is known, tested against signals recorded from the live registries
(`pnpm golden:record` refreshes them). Every change to the scoring must keep it passing. See
[docs/VISION.md](docs/VISION.md) for the plan.

| Package         | Description                                                  |
| --------------- | ------------------------------------------------------------ |
| `packages/core` | The engine: lockfile readers, data sources, scoring, report. |
| `packages/cli`  | The `vitals` command-line tool.                              |

## License

[MIT](LICENSE)
