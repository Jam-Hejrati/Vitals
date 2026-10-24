import type { CiResult, PackageReport, Report, Verdict } from '@vitals/core';
import {
  FAIL_CRITERIA,
  isProblem,
  nameOf,
  npmUrl,
  plural,
  suggestionList,
  truncate,
} from './format.js';

/** Starts every Markdown report, so a pull request comment can be found and updated in place. */
export const MARKER = '<!-- dependency-vitals';

const MAX_ROWS = 50;
const WHY_WIDTH = 120;
const PROJECT_URL = 'https://github.com/Jam-Hejrati/Vitals';

const ICON: Record<Verdict, string> = {
  deprecated: '🔴',
  abandoned: '🔴',
  stale: '🟡',
  unknown: '⚪',
  finished: '🟢',
  active: '🟢',
};

/**
 * The result of `--ci` as Markdown, for pull request comments and job summaries. The first line is
 * a hidden marker with the outcome: `fail`, `warn` (passed, with problems below the threshold) or
 * `pass`.
 */
export function formatCiMarkdown(report: Report, ci: CiResult): string {
  const status = !ci.passed ? 'fail' : ci.watch.length > 0 ? 'warn' : 'pass';
  const scope = ci.base === undefined ? '' : 'new ';
  const count = ci.offenders.length;
  const title = ci.passed
    ? `✅ Vitals: no ${scope}dependency is ${FAIL_CRITERIA[ci.failOn]}`
    : `❌ Vitals: ${count} ${scope}${count === 1 ? 'dependency is' : 'dependencies are'} ` +
      FAIL_CRITERIA[ci.failOn];
  const compared =
    ci.base === undefined
      ? `Checked all ${plural(ci.newPackages, 'package')}`
      : `Compared with \`${escape(ci.base)}\`: ${plural(ci.newPackages, 'new package')}`;

  const lines = [
    `${MARKER} status=${status} -->`,
    `### ${title}`,
    '',
    `${compared} · fails on \`${ci.failOn}\``,
    '',
  ];
  if (count > 0) lines.push(...table(ci.offenders), '');
  if (ci.watch.length > 0) {
    lines.push(
      '<details>',
      `<summary>${plural(ci.watch.length, 'more package')} worth a look (not failing the check)</summary>`,
      '',
      ...table(ci.watch),
      '',
      '</details>',
      '',
    );
  }
  lines.push(footer());
  return lines.join('\n') + '\n';
}

/** The whole report as Markdown: the summary and every package that needs attention. */
export function formatReportMarkdown(report: Report): string {
  const { summary } = report;
  const { verdicts } = summary;
  const healthy =
    summary.total === 0
      ? 100
      : Math.floor(((verdicts.finished + verdicts.active) / summary.total) * 100);
  const counts = (Object.keys(ICON) as Verdict[])
    .filter((verdict) => verdicts[verdict] > 0)
    .map((verdict) => `${verdicts[verdict]} ${verdict}`)
    .join(' · ');
  const problems = report.packages.filter(isProblem);

  const lines = [
    `${MARKER} -->`,
    `### Vitals · ${escape(report.project.name)}`,
    '',
    `${plural(summary.total, 'package')} checked (${summary.direct} direct), **${healthy}% healthy**: ${counts || 'nothing to check'}`,
    '',
  ];
  lines.push(
    ...(problems.length > 0 ? table(problems) : ['✅ No dependency needs attention.']),
    '',
  );
  lines.push(footer());
  return lines.join('\n') + '\n';
}

function table(packages: PackageReport[]): string[] {
  const rows = packages.slice(0, MAX_ROWS).map((pkg) => {
    const label = `[\`${pkg.name}@${pkg.version}\`](${npmUrl(pkg)})`;
    const why = truncate(
      pkg.reasons.map((r) => r.replace(/^deprecated: /, '')).join('; '),
      WHY_WIDTH,
    );
    const instead = [
      ...pkg.advice,
      ...(pkg.replacements.length > 0 ? [suggestionList(pkg.replacements, 3)] : []),
    ].join('; ');
    const via = pkg.direct
      ? 'direct'
      : pkg.introducedBy.map((id) => `\`${nameOf(id)}\``).join(', ');
    return `| ${ICON[pkg.verdict]} | ${label} | **${pkg.verdict}** | ${escape(why)} | ${via || '?'} | ${escape(instead) || '–'} |`;
  });
  const more = packages.length - rows.length;
  return [
    '| | Package | Verdict | Why | Brought in by | Use instead |',
    '| - | - | - | - | - | - |',
    ...rows,
    ...(more > 0
      ? ['', `…and ${plural(more, 'more package')} (see the full report with \`--all\`).`]
      : []),
  ];
}

function footer(): string {
  return `<sub>Checked by [dependency-vitals](${PROJECT_URL}) · [what the verdicts mean](${PROJECT_URL}#what-you-get)</sub>`;
}

/**
 * Text from package metadata (deprecation messages, names) is written by third parties: keep it
 * from turning into links, images, HTML or table cells.
 */
export function escape(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[\\`*_[\]|!]/g, (char) => `\\${char}`)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
