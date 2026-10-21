import type { Progress, Stage } from '@vitals/core';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 80;
const BAR_WIDTH = 24;

const LABELS: Record<Stage, string> = {
  packages: 'reading release history',
  details: 'looking up licenses and repositories',
  inactive: 'measuring quiet packages',
  github: 'asking GitHub who maintains them',
};

/** Share of the run each stage takes, roughly: one request per package makes the first the slowest. */
const WEIGHTS: Record<Stage, number> = {
  packages: 0.6,
  details: 0.15,
  inactive: 0.15,
  github: 0.1,
};

export interface ProgressLineOptions {
  /** Whether the GitHub stage will run. */
  github: boolean;
  color: boolean;
}

/**
 * An animated line on a terminal while the lookups run:
 * `⠹ Checking dependencies  ██████░░░░  42%  reading release history 214/380`.
 */
export class ProgressLine {
  private readonly stages: Stage[];
  private frame = 0;
  private fraction = 0;
  private current: Progress | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly restore = () => this.stream.write('\x1b[?25h');
  private readonly interrupt = () => {
    this.stop();
    process.exit(130);
  };

  constructor(
    private readonly stream: NodeJS.WriteStream,
    private readonly options: ProgressLineOptions,
  ) {
    this.stages = (Object.keys(WEIGHTS) as Stage[]).filter((s) => s !== 'github' || options.github);
  }

  start(): void {
    this.stream.write('\x1b[?25l');
    process.once('exit', this.restore);
    process.once('SIGINT', this.interrupt);
    this.timer = setInterval(() => this.render(), FRAME_MS);
    this.timer.unref();
    this.render();
  }

  update(progress: Progress): void {
    this.current = progress;
    // Never move backwards, even when a stage starts with an estimate that later shrinks.
    this.fraction = Math.max(this.fraction, overall(progress, this.stages));
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
    process.off('exit', this.restore);
    process.off('SIGINT', this.interrupt);
    this.stream.write('\r\x1b[K');
    this.restore();
  }

  private render(): void {
    const paint = (code: string, text: string) =>
      this.options.color ? `\x1b[${code}m${text}\x1b[0m` : text;
    const filled = Math.round(this.fraction * BAR_WIDTH);
    const bar = paint('36', '█'.repeat(filled)) + paint('90', '░'.repeat(BAR_WIDTH - filled));
    const percent = `${Math.floor(this.fraction * 100)}%`.padStart(4);
    const { current } = this;
    const step =
      current === undefined
        ? 'starting'
        : current.stage === 'details'
          ? LABELS.details
          : `${LABELS[current.stage]} ${current.done}/${current.total}`;
    const spinner = paint('36', FRAMES[this.frame++ % FRAMES.length]!);
    const heading = 'Checking dependencies';
    const line = `${spinner} ${heading}  ${bar} ${percent}  `;
    // Cut the description, not the bar, when the terminal is narrow.
    const room = (this.stream.columns ?? 80) - 1 - (heading.length + BAR_WIDTH + 10);
    const detail = room <= 0 ? '' : step.length <= room ? step : `${step.slice(0, room - 1)}…`;
    this.stream.write(`\r${line}${paint('90', detail)}\x1b[K`);
  }
}

/** How far the whole run is, 0–1, from the stage that just reported. */
export function overall(progress: Progress, stages: readonly Stage[]): number {
  const index = stages.indexOf(progress.stage);
  if (index === -1) return 0;
  const sum = stages.reduce((total, stage) => total + WEIGHTS[stage], 0);
  const before = stages.slice(0, index).reduce((total, stage) => total + WEIGHTS[stage], 0);
  const part = progress.total > 0 ? Math.min(progress.done / progress.total, 1) : 1;
  return (before + WEIGHTS[progress.stage] * part) / sum;
}
