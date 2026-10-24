# Vitals — Vision

> This document is the shared reference for what Vitals is, why it exists, and where it is going.
> When a decision is unclear, come back here.

## Pitch

`npm outdated` tells you a newer version exists.
`npm audit` tells you about known vulnerabilities.
**Vitals tells you whether the packages you depend on are alive, finished, or dying — and what to do about it.**

A package can be fully up to date, have zero known CVEs, and still be abandoned. Vitals catches that.

## Problem

- Projects quietly depend on packages maintained by one person, with no activity in years.
- Teams only notice when something breaks, a security issue goes unpatched, or a package gets deprecated.
- Existing tools focus on **versions** or **vulnerabilities**, not on **maintenance health**.
- Raw signals exist (deps.dev, OpenSSF Scorecard, registry metadata), but nobody turns them into a
  clear, trustworthy, developer-friendly answer.

## Scope

- ✅ Maintenance health, abandonment risk, bus factor, upgrade risk
- ❌ Not a vulnerability scanner — that is `npm audit`, Snyk, Socket
- ❌ Not a version checker — that is `npm outdated`, Renovate, Dependabot

## Principles

1. **Trust beats coverage.** A false "abandoned" flag on a healthy package costs more than missing a
   real problem. Every score is explainable — we always show _why_.
2. **Finished is not abandoned.** A small, stable package with no releases in years can be perfectly
   healthy. Scoring must separate "done" from "dead".
3. **Actionable over informative.** Every warning points to an action: which direct dependency pulled
   it in, and what to replace it with.
4. **Zero setup.** `npx vitals` works with no token and no config. Tokens and config only make it better.
5. **Fast and polite.** Cache aggressively, batch requests, use deps.dev as the primary data source and
   GitHub only for enrichment.
6. **Ecosystem-agnostic core.** JavaScript first, but nothing in `core` assumes npm.

## Business model: open-core

- **Open source (MIT):** `core`, `cli`, and later the GitHub Action and MCP server.
- **Paid (later):** hosted product for organizations — multi-repo monitoring, alerts, history,
  policies, compliance reports.
- The paid product is built _on top of_ the same open core. The open-source tool must always be
  genuinely useful on its own.

---

## MVP — v0.1 (JavaScript)

| #   | Feature                                                                               | Notes                                                        |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | Read `package-lock.json` and `pnpm-lock.yaml`                                         | yarn and bun later                                           |
| 2   | Health verdict + reasons per dependency, with a 0–100 score                           | separates finished from abandoned — see Scoring model        |
| 3   | Flags: deprecated, archived repo, single active maintainer, stale + unanswered issues | bus factor from recent commit authors, not npm `maintainers` |
| 9   | Legacy advice — "consider `date-fns` / `dayjs`" for packages like `moment`            | from e18e `module-replacements`; never changes the verdict   |
| 4   | "Why is this here?" — dependency path for transitive packages                         |                                                              |
| 5   | Terminal report — shows problems only by default                                      | `--all` shows everything                                     |
| 6   | `--json` output                                                                       | versioned schema                                             |
| 7   | `--ci` diff mode — fail only on **newly added** unhealthy dependencies                | the adoption hook for teams                                  |
| 8   | Local cache                                                                           | fast repeat runs, fewer API calls                            |

### Planned usage

```bash
npx vitals                       # terminal report of risky dependencies
npx vitals --all                 # every dependency, including healthy ones
npx vitals --json                # machine-readable output
npx vitals --ci --fail-on=high   # non-zero exit if a newly added dependency is unhealthy
```

### Data sources

- **deps.dev API** (primary) — package → repo mapping, versions, OpenSSF Scorecard, multi-ecosystem, no auth
- **npm registry** — weekly downloads (bulk API); per-version metadata for package size
  (small documents, immutable, cached long-term). The full package document is too large to fetch.
- **GitHub API** (optional `GITHUB_TOKEN`, part of the MVP) — archived status, active committers
  (bus factor), issue responsiveness. Enriches direct dependencies and flagged packages; Vitals works
  without it.
- **e18e `module-replacements`** — curated legacy/replacement data for advice
- **Local cache** — on-disk, with TTLs per signal

### Scoring model

Decided after looking at real data for ~25 well-known packages (deprecated, finished, abandoned,
stale, legacy and healthy ones).

**Verdict first, score second.** Each package gets a verdict with human-readable reasons; the 0–100
score is secondary and used for sorting, trends and CI thresholds.

| Verdict           | Meaning                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴 **Deprecated** | The author deprecated the package — overrides everything. If only the installed version is deprecated, the advice is to upgrade.               |
| 🔴 **Abandoned**  | Long without releases, no repository activity, **and** evidence of neglect: unmet demand (many open issues for its usage) or an archived repo. |
| 🟠 **Stale**      | Activity stopped on a non-trivial package, without clear evidence of neglect yet.                                                              |
| 🟢 **Finished**   | Small, stable, inactive, little unmet demand (e.g. `ms`, `inherits`). Healthy, labelled so users understand why.                               |
| 🟢 **Active**     | Recent releases or commits.                                                                                                                    |

Lessons from the data:

- Release age alone flags `ms` and `inherits` as dead — the false positive that kills trust.
  Finished packages are **tiny**, have **few open issues for their usage**, and are heavily used.
- What separates `colors` (abandoned) from `inherits` (finished) is **unmet demand**.
- npm `maintainers` is useless for bus factor (`ms` lists ~50 people); use commit authors.
- "Legacy" (`moment`) cannot be seen in the numbers — it comes from curated data, as advice.
- OpenSSF Scorecard is ~2 months old and missing for ~25% of repos; never the only activity source.

**Golden set.** ~100 hand-labelled packages kept as a test. Every scoring change must keep it passing.

**Default report** shows only problems (Deprecated, Abandoned, Stale) plus a one-line summary;
`--all` shows everything.

### Tech

- TypeScript, Node.js ≥ 22.12 (Node 20 is end-of-life)
- pnpm workspaces monorepo
- Vitest for tests
- Published to npm

```
packages/
  core/   # reads lockfiles, fetches data, computes scores — a library, no CLI assumptions
  cli/    # thin command-line layer over core
```

---

## Growth stages

1. **CLI tool** (free, open source) — `npx vitals`. Goal: adoption and credibility.
2. **CI / GitHub Action / GitHub App** (free for open source) — block unhealthy new dependencies in
   PRs. Goal: become part of the team workflow.
3. **Hosted org dashboard** (paid) — connect a GitHub org, monitor all repos continuously, alert when
   a dependency's health drops. First revenue.
4. **Public health index** — a page per package (e.g. `vitals.dev/npm/<name>`), badges, API. Growth
   engine through search, and a data moat through historical health data.
5. **Compliance & enterprise** — policies, audit reports, SBOM enrichment. Tailwinds: EU Cyber
   Resilience Act due-diligence obligations (phasing in 2026–2027) and SBOM requirements.
6. **AI agents** — MCP server / API so coding agents check a package's health before installing it.

### Ecosystem expansion

npm → PyPI → Go, Cargo, Maven, NuGet, RubyGems, Packagist (largely via deps.dev).
Beyond packages: GitHub Actions, Docker base images, editor extensions.

## Roadmap

### Phase 1 — MVP (v0.1, JavaScript)

- [x] Monorepo scaffold (`core`, `cli`)
- [x] Lockfile readers: npm, pnpm
- [x] Data fetchers: deps.dev, npm downloads
- [x] Data fetchers: npm package size
- [x] Data fetchers: GitHub (optional token) — archived repositories, single maintainer (issue responsiveness: later)
- [x] Local cache
- [x] Scoring model v1: verdicts, reasons, score + golden set test (65 packages)
- [x] Legacy advice from e18e `module-replacements`
- [x] Dependency paths ("why is this here?")
- [x] Terminal report + `--json`
- [x] `--ci` diff mode
- [x] README
- [x] Packaging: one self-contained file, checked by `pnpm release:check`
- [x] Demo GIF for the README (`docs/demo`, recorded with VHS)
- [x] Publish to npm as `dependency-vitals`

### Phase 2 — Adoption

- [x] GitHub Action: PR comment and job summary (`action.yml`, `--markdown`)
- [ ] Health trend between runs
- [ ] README badge / project report card
- [ ] yarn and bun lockfiles
- [ ] MCP server for AI agents

### Phase 3 — More ecosystems

- [ ] Python (`requirements.txt`, `pyproject.toml`, `poetry.lock`, `uv.lock`)
- [ ] Go, Rust, others via deps.dev

### Phase 4 — Product

- [ ] Hosted org dashboard, continuous monitoring, alerts
- [ ] Public health index website + API
- [ ] Policies and compliance reports

## Competitive landscape

| Tool                                 | Focus                                   | How Vitals differs                                                      |
| ------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------- |
| `npm outdated`, Renovate, Dependabot | versions                                | Vitals measures maintenance, not version lag                            |
| `npm audit`, Snyk, Socket, Sonatype  | vulnerabilities / supply-chain security | maintenance health done in depth, free, explainable                     |
| OpenSSF Scorecard, deps.dev          | raw security / project signals          | Vitals builds on them and turns them into a clear answer for developers |

Main risk: larger players add similar features. Defense: speed, accuracy and trust, community, and
historical data.

## Open questions

- Exact thresholds for size, "long without releases" and unmet demand — tuned against the golden set.
- Severity levels and default `--fail-on` threshold for CI.
- History storage — SQLite in a user cache dir for local runs; JSON snapshot for CI.
- ~~npm package name~~ Decided: `dependency-vitals`. (`vitals`, `vitals-cli` and `depvitals` are
  taken, and npm rejected `dep-vitals` as too similar to `depvitals`: it ignores dashes when it
  compares names.)

## Known limitations

- **Issue counts are per repository, not per package.** A tiny package that lives in a large
  monorepo inherits the whole repository's backlog (e.g. `confusing-browser-globals`, 2,408 issues
  from the Create React App repo), which can make it look abandoned. Needs per-package signals.
- **"Superseded by something built in" is invisible to the numbers.** Packages like
  `source-map-support` are small and stable but replaced by platform features. The e18e data knows
  this; using it as a signal for inactive packages is a candidate for a later version.
- **Thresholds sit on edges.** Any cutoff misjudges packages just either side of it
  (`cookie-parser` is a few percent over the small-package bar).
- **Scorecard data is about two months old** and missing for roughly a quarter of repositories.
