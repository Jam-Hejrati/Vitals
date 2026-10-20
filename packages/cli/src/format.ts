import type { PackageReport, Report, Verdict } from '@vitals/core';

export interface FormatOptions {
  /** List healthy packages too, not just the ones that need attention. */
  all: boolean;
  color: boolean;
}

const NEEDS_ATTENTION: ReadonlySet<Verdict> = new Set(['deprecated', 'abandoned', 'stale']);

const STYLES = { red: 31, yellow: 33, green: 32, gray: 90, bold: 1 } as const;
type Style = keyof typeof STYLES;

const VERDICT_STYLE: Record<Verdict, { icon: string; color: Style }> = {
  deprecated: { icon: '✖', color: 'red' },
  abandoned: { icon: '✖', color: 'red' },
  stale: { icon: '▲', color: 'yellow' },
  finished: { icon: '✔', color: 'green' },
  active: { icon: '✔', color: 'green' },
  unknown: { icon: '?', color: 'gray' },
};

export function formatReport(report: Report, options: FormatOptions): string {
  const paint = (style: Style, text: string) =>
    options.color ? `\x1b[${STYLES[style]}m${text}\x1b[0m` : text;
  const { summary } = report;
  const lines: string[] = [];

  lines.push(
    `${paint('bold', 'Vitals')} · ${report.project.name} · ${report.project.lockfile}`,
    `${summary.total} ${summary.total === 1 ? 'package' : 'packages'} checked ` +
      `(${summary.direct} direct)`,
    '',
  );

  const shown = report.packages.filter((p) => options.all || NEEDS_ATTENTION.has(p.verdict));
  for (const pkg of shown) lines.push(...formatPackage(pkg, paint), '');

  const attention = [...NEEDS_ATTENTION].reduce((n, v) => n + summary.verdicts[v], 0);
  if (attention === 0) {
    lines.push(paint('green', '✔ No dependency needs attention.'), '');
  }

  lines.push(formatSummary(report, paint));

  const hidden = summary.total - shown.length;
  if (!options.all && hidden > 0) {
    const unknown = summary.verdicts.unknown;
    lines.push(
      paint('gray', `Not shown: ${hidden} healthy or unassessed packages. Use --all to list them.`),
    );
    if (unknown > 0) {
      lines.push(
        paint('gray', `${unknown} could not be assessed (not found in the public npm registry).`),
      );
    }
  }
  return lines.join('\n') + '\n';
}

function formatPackage(
  pkg: PackageReport,
  paint: (style: Style, text: string) => string,
): string[] {
  const { icon, color } = VERDICT_STYLE[pkg.verdict];
  const tags = [pkg.direct ? 'direct' : undefined, pkg.dev ? 'dev' : undefined]
    .filter((tag) => tag !== undefined)
    .join(', ');
  const head = [
    paint(color, icon),
    paint('bold', `${pkg.name}@${pkg.version}`),
    paint(color, pkg.verdict.toUpperCase()),
    tags && paint('gray', `(${tags})`),
  ];

  const lines = [head.filter(Boolean).join('  ')];
  for (const reason of pkg.reasons) lines.push(`    · ${reason}`);
  for (const advice of pkg.advice) lines.push(`    → ${advice}`);
  if (pkg.unknowns.length > 0) {
    lines.push(paint('gray', `    ? could not check: ${pkg.unknowns.join('; ')}`));
  }
  for (const path of pkg.paths.slice(0, 2)) {
    lines.push(paint('gray', `    via ${path.slice(0, -1).map(nameOf).join(' › ')}`));
  }
  if (pkg.paths.length > 2) lines.push(paint('gray', `    …and ${pkg.paths.length - 2} more`));
  return lines;
}

function formatSummary(report: Report, paint: (style: Style, text: string) => string): string {
  const { verdicts } = report.summary;
  const parts: string[] = [];
  const add = (verdict: Verdict, label: string, style: Style) => {
    if (verdicts[verdict] > 0) parts.push(paint(style, `${verdicts[verdict]} ${label}`));
  };
  add('deprecated', 'deprecated', 'red');
  add('abandoned', 'abandoned', 'red');
  add('stale', 'stale', 'yellow');
  add('finished', 'finished', 'green');
  add('active', 'active', 'green');
  add('unknown', 'unknown', 'gray');
  return parts.length > 0 ? parts.join(' · ') : 'No packages to check.';
}

/** `name@1.2.3` or `@scope/name@1.2.3` → the package name. */
function nameOf(id: string): string {
  return id.slice(0, id.lastIndexOf('@'));
}
