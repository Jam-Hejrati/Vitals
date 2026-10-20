# Vitals

> `npm outdated` tells you a newer version exists.
> **Vitals tells you whether the packages you depend on are alive, finished, or dying.**

A package can be fully up to date, have no known vulnerabilities, and still be abandoned. Vitals
looks at the **maintenance health** of every package in your lockfile (direct and transitive), tells
you which ones are a risk and why, and points at the dependency to change.

**Status: early preview (0.1).** It works and is tested, but the verdicts are young. Please open an
issue when one looks wrong; that is how the model gets better.

## Quick start

```bash
npx dep-vitals            # in a folder with a package-lock.json or pnpm-lock.yaml
npx dep-vitals --all      # include healthy packages
npx dep-vitals --json     # machine-readable report
```

Requires Node.js 22.12 or newer. No setup, no account, no token needed. The command is `vitals`
once installed (`npm i -g dep-vitals`).

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

Fail a pull request only when it **adds** an unhealthy dependency; existing ones are not your PR's
problem:

```yaml
# .github/workflows/dependency-health.yml
name: Dependency health
on: pull_request
jobs:
  vitals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Vitals compares with the base branch's lockfile
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx dep-vitals --ci
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

On a pull request the base defaults to `origin/$GITHUB_BASE_REF`. Elsewhere, pass it yourself:

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

A token with no scopes is enough (public data). Without one, everything else works unchanged.

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
