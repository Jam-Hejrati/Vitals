import type { CiResult, FailLevel, PackageReport, Report, Suggestion, Verdict } from '@vitals/core';

export interface FormatOptions {
  /** List healthy packages too, and every nested problem instead of the first few. */
  all: boolean;
  color: boolean;
  /** Whether GitHub data was used. When explicitly false, the report mentions how to enable it. */
  github?: boolean;
}

type Problem = 'deprecated' | 'abandoned' | 'stale';

/** Verdicts that need attention, worst first. */
const PROBLEM_ORDER: Record<Problem, number> = { deprecated: 0, abandoned: 1, stale: 2 };

const MAX_NESTED = 5;
const MAX_SHARED = 8;
const DETAIL_WIDTH = 100;
const MAX_SUGGESTIONS = 3;
const MAX_SUGGESTIONS_INLINE = 2;

const STYLES = { red: 31, yellow: 33, green: 32, gray: 90, bold: 1 } as const;
type Style = keyof typeof STYLES;
type Paint = (style: Style, text: string) => string;

const VERDICT_STYLE: Record<Verdict, { icon: string; color: Style }> = {
  deprecated: { icon: '✖', color: 'red' },
  abandoned: { icon: '✖', color: 'red' },
  stale: { icon: '▲', color: 'yellow' },
  finished: { icon: '✔', color: 'green' },
  active: { icon: '✔', color: 'green' },
  unknown: { icon: '?', color: 'gray' },
};

/** A direct dependency to act on, and the problems that only it is responsible for. */
interface Group {
  id: string;
  /** Absent for local packages (workspaces), which are never assessed. */
  head: PackageReport | undefined;
  children: PackageReport[];
}

function createPaint(options: FormatOptions): Paint {
  return (style, text) => (options.color ? `\x1b[${STYLES[style]}m${text}\x1b[0m` : text);
}

export function formatReport(report: Report, options: FormatOptions): string {
  const paint = createPaint(options);
  const { summary } = report;
  const { groups, shared } = groupProblems(report.packages, report.packages.filter(isProblem));
  const displayed = new Set<string>();
  const lines: string[] = [];

  lines.push(
    `${paint('bold', 'Vitals')} · ${report.project.name} · ${report.project.lockfile}`,
    `${plural(summary.total, 'package')} checked (${summary.direct} direct)`,
    '',
  );

  for (const group of groups) {
    lines.push(...formatGroup(group, options, paint), '');
    if (group.head) displayed.add(group.head.id);
    for (const child of visible(group.children, MAX_NESTED, options)) displayed.add(child.id);
  }

  const sharedSection = formatShared(shared, options, paint);
  lines.push(...sharedSection.lines);
  for (const pkg of sharedSection.shown) displayed.add(pkg.id);

  lines.push(...formatNotices(report, paint));

  if (groups.length === 0 && shared.length === 0) {
    lines.push(paint('green', '✔ No dependency needs attention.'), '');
  }

  if (options.all) {
    const rest = report.packages.filter((pkg) => !displayed.has(pkg.id));
    if (rest.length > 0) {
      lines.push(paint('bold', 'Everything else:'));
      for (const pkg of rest) lines.push(`  ${oneLine(pkg, paint)}`);
      lines.push('');
    }
  }

  lines.push(formatSummary(report, paint));

  // Problems cut off by a cap say so where they are listed; this counts what --all would add.
  const hidden = report.packages.filter((p) => !isProblem(p) && !displayed.has(p.id)).length;
  if (!options.all && hidden > 0) {
    lines.push(
      paint(
        'gray',
        `Not shown: ${plural(hidden, 'healthy or unassessed package')}. Use --all to list them.`,
      ),
    );
    if (summary.verdicts.unknown > 0) {
      lines.push(
        paint(
          'gray',
          `${summary.verdicts.unknown} could not be assessed (not found in the public npm registry).`,
        ),
      );
    }
  }
  if (options.github === false) {
    lines.push(
      paint(
        'gray',
        'Tip: set GITHUB_TOKEN to also check archived repositories and single-maintainer packages.',
      ),
    );
  }
  return lines.join('\n') + '\n';
}

const FAIL_CRITERIA: Record<FailLevel, string> = {
  deprecated: 'deprecated',
  abandoned: 'deprecated or abandoned',
  stale: 'deprecated, abandoned or stale',
};

/** The result of `--ci`: only what the check is about, and whether it passed. */
export function formatCi(report: Report, ci: CiResult, options: FormatOptions): string {
  const paint = createPaint(options);
  const lines = [
    `${paint('bold', 'Vitals CI')} · ${report.project.name} · ${report.project.lockfile}`,
    ci.base === undefined
      ? `No base given: checking all ${plural(ci.newPackages, 'package')}`
      : `Compared with ${ci.base}: ${plural(ci.newPackages, 'new package')}`,
    '',
  ];

  const { groups, shared } = groupProblems(report.packages, ci.offenders);
  for (const group of groups) lines.push(...formatGroup(group, options, paint), '');
  lines.push(...formatShared(shared, options, paint).lines);
  if (ci.watch.length > 0) {
    lines.push(paint('bold', 'Worth a look (not failing the check):'));
    for (const pkg of ci.watch) lines.push(`  ${oneLine(pkg, paint)}`);
    lines.push('');
  }

  const scope = ci.base === undefined ? '' : 'new ';
  const count = ci.offenders.length;
  const noun = `${scope}${count === 1 ? 'dependency' : 'dependencies'}`;
  lines.push(
    ci.passed
      ? paint('green', `✔ Passed: no ${scope}dependency is ${FAIL_CRITERIA[ci.failOn]}.`)
      : paint(
          'red',
          `✖ Failed: ${count} ${noun} ${count === 1 ? 'is' : 'are'} ${FAIL_CRITERIA[ci.failOn]} ` +
            `(--fail-on ${ci.failOn}).`,
        ),
  );
  return lines.join('\n') + '\n';
}

/**
 * Arranges the problems by what the user can do about them. A transitive problem belongs to a
 * direct dependency only when that is the single dependency bringing it in, so replacing it
 * really makes the problem go away; the others are listed separately.
 */
function groupProblems(
  all: PackageReport[],
  problems: PackageReport[],
): { groups: Group[]; shared: PackageReport[] } {
  const byId = new Map(all.map((pkg) => [pkg.id, pkg]));
  const groups = new Map<string, Group>();
  const groupFor = (id: string): Group => {
    let group = groups.get(id);
    if (!group) {
      group = { id, head: byId.get(id), children: [] };
      groups.set(id, group);
    }
    return group;
  };

  const shared: PackageReport[] = [];
  for (const pkg of problems) {
    if (pkg.direct) groupFor(pkg.id);
    else if (pkg.introducedBy.length === 1) groupFor(pkg.introducedBy[0]!).children.push(pkg);
    else shared.push(pkg);
  }

  const members = (group: Group) =>
    [group.head, ...group.children].filter((p) => p && isProblem(p));
  const worst = (group: Group) =>
    Math.min(...members(group).map((pkg) => PROBLEM_ORDER[pkg!.verdict as Problem]));
  const ordered = [...groups.values()].sort(
    (a, b) =>
      worst(a) - worst(b) || members(b).length - members(a).length || a.id.localeCompare(b.id),
  );
  return { groups: ordered, shared };
}

/** Problems that several direct dependencies bring in: all of those dependencies have to change. */
function formatShared(
  shared: PackageReport[],
  options: FormatOptions,
  paint: Paint,
): { lines: string[]; shown: PackageReport[] } {
  if (shared.length === 0) return { lines: [], shown: [] };
  const shown = visible(shared, MAX_SHARED, options);
  const lines = [paint('bold', 'Shared by several dependencies (all of them need to change):')];
  for (const pkg of shown) {
    lines.push(`  ${oneLine(pkg, paint)}${paint('gray', `  via ${viaNames(pkg)}`)}`);
  }
  if (shown.length < shared.length) {
    lines.push(paint('gray', `  …and ${shared.length - shown.length} more (use --all)`));
  }
  lines.push('');
  return { lines, shown };
}

function formatGroup(group: Group, options: FormatOptions, paint: Paint): string[] {
  const { head, children } = group;
  const lines: string[] = [];

  if (head && isProblem(head)) {
    lines.push(...describeProblem(head, paint));
  } else if (head) {
    const { icon, color } = VERDICT_STYLE[head.verdict];
    lines.push(
      `${paint(color, icon)}  ${paint('bold', `${head.name}@${head.version}`)}  ${tags(head, paint)}`,
    );
  } else {
    lines.push(
      `${paint('gray', '▸')}  ${paint('bold', nameOf(group.id))}  ${paint('gray', '(local package)')}`,
    );
  }

  if (children.length > 0) {
    const also = head && isProblem(head) ? 'Also brings in' : 'Brings in';
    const needs = children.length === 1 ? 'needs' : 'need';
    lines.push(
      paint('gray', `    ${also} ${plural(children.length, 'package')} that ${needs} attention:`),
    );
    const shown = visible(children, MAX_NESTED, options);
    for (const child of shown) lines.push(`      ${oneLine(child, paint)}`);
    if (shown.length < children.length) {
      lines.push(paint('gray', `      …and ${children.length - shown.length} more (use --all)`));
    }
  }
  return lines;
}

function describeProblem(pkg: PackageReport, paint: Paint): string[] {
  const { icon, color } = VERDICT_STYLE[pkg.verdict];
  const heading = [
    paint(color, icon),
    paint('bold', `${pkg.name}@${pkg.version}`),
    paint(color, pkg.verdict.toUpperCase()),
    tags(pkg, paint),
  ];
  const lines = [heading.filter(Boolean).join('  ')];
  for (const reason of pkg.reasons) lines.push(`    · ${reason}`);
  for (const warning of pkg.warnings) lines.push(paint('yellow', `    ! ${warning.message}`));
  for (const advice of pkg.advice) lines.push(`    → ${advice}`);
  if (pkg.replacements.length > 0) {
    lines.push(`    → instead: ${suggestionList(pkg.replacements, MAX_SUGGESTIONS)}`);
  }
  if (pkg.unknowns.length > 0) {
    lines.push(paint('gray', `    ? could not check: ${pkg.unknowns.join('; ')}`));
  }
  return lines;
}

/** `✖ name@1.0.0  deprecated  reasons → advice`, short enough to sit in a list. */
function oneLine(pkg: PackageReport, paint: Paint): string {
  const { icon, color } = VERDICT_STYLE[pkg.verdict];
  const reasons = pkg.reasons.map((reason) => reason.replace(/^deprecated: /, ''));
  const detail =
    reasons.length > 0
      ? reasons.join(', ')
      : `could not check: ${pkg.unknowns.join('; ') || 'no data'}`;
  const advice = [
    ...pkg.advice,
    ...(pkg.replacements.length > 0
      ? [`instead: ${suggestionList(pkg.replacements, MAX_SUGGESTIONS_INLINE)}`]
      : []),
  ];
  return (
    `${paint(color, icon)} ${pkg.name}@${pkg.version}  ${paint(color, pkg.verdict)}  ` +
    `${paint('gray', truncate(detail, DETAIL_WIDTH))}${advice.map((a) => ` → ${a}`).join('')}`
  );
}

/** Direct dependencies that are healthy, but worth knowing about. Needs GitHub data. */
function formatNotices(report: Report, paint: Paint): string[] {
  const lines: string[] = [];
  const notice = (code: 'single-maintainer' | 'archived', title: string) => {
    const names = report.packages
      .filter((p) => p.direct && !isProblem(p) && p.warnings.some((w) => w.code === code))
      .map((p) => p.name);
    if (names.length > 0) lines.push(paint('bold', title), `  ${names.join(', ')}`, '');
  };
  notice('archived', 'Archived repositories (no further fixes expected):');
  notice('single-maintainer', 'Maintained by one person (direct dependencies):');
  return lines;
}

function suggestionList(suggestions: Suggestion[], max: number): string {
  return suggestions
    .slice(0, max)
    .map((s) => (s.kind === 'native' ? `${s.name} (built in)` : s.name))
    .join(', ');
}

function tags(pkg: PackageReport, paint: Paint): string {
  const labels = [pkg.direct ? 'direct' : undefined, pkg.dev ? 'dev' : undefined].filter(
    (label) => label !== undefined,
  );
  return labels.length > 0 ? paint('gray', `(${labels.join(', ')})`) : '';
}

function formatSummary(report: Report, paint: Paint): string {
  const { verdicts } = report.summary;
  const parts: string[] = [];
  const add = (verdict: Verdict, style: Style) => {
    if (verdicts[verdict] > 0) parts.push(paint(style, `${verdicts[verdict]} ${verdict}`));
  };
  add('deprecated', 'red');
  add('abandoned', 'red');
  add('stale', 'yellow');
  add('finished', 'green');
  add('active', 'green');
  add('unknown', 'gray');
  return parts.length > 0 ? parts.join(' · ') : 'No packages to check.';
}

/** The first `max` items, or all of them with --all. */
function visible<T>(items: T[], max: number, options: FormatOptions): T[] {
  return options.all ? items : items.slice(0, max);
}

function isProblem(pkg: PackageReport): boolean {
  return pkg.verdict in PROBLEM_ORDER;
}

function viaNames(pkg: PackageReport): string {
  return pkg.introducedBy.length > 0 ? pkg.introducedBy.map(nameOf).join(', ') : 'unknown';
}

/** `name@1.2.3` or `@scope/name@1.2.3` → the package name. */
function nameOf(id: string): string {
  return id.slice(0, id.lastIndexOf('@'));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1).trimEnd()}…`;
}
