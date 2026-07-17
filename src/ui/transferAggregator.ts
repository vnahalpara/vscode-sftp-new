import { formatBytes, formatSpeed, formatDuration, SpeedWindow } from './transferFormat';

interface StatusLike {
  showMsg(text: string, tooltip?: any, hideAfterTimeout?: number): void;
}

interface TaskLike {
  size: number;
}

export default class TransferAggregator {
  private bar: StatusLike;
  private now: () => number;
  private throttleMs: number;

  private activeOps = 0;
  private totalFiles = 0;
  private doneFiles = 0;
  private failedFiles = 0;
  private cancelledAny = false;
  private totalBytes = 0;
  private baseBytes = 0;
  private inFlight = new Map<object, number>();
  private speedWindow = new SpeedWindow(1000);

  private direction = '';
  private lastFilename = '';
  private lastFilepath = '';

  private renderTimer: any = null;

  constructor(bar: StatusLike, opts: { now?: () => number; throttleMs?: number } = {}) {
    this.bar = bar;
    this.now = opts.now || (() => Date.now());
    this.throttleMs = opts.throttleMs === undefined ? 300 : opts.throttleMs;
  }

  beginOperation(): void {
    this.activeOps += 1;
  }

  registerTask(task: TaskLike): void {
    this.totalFiles += 1;
    this.totalBytes += task.size || 0;
  }

  onTaskStart(task: object, info: { direction: string; filename: string; filepath: string }): void {
    this.inFlight.set(task, 0);
    this.direction = info.direction;
    this.lastFilename = info.filename;
    this.lastFilepath = info.filepath;
    this.scheduleRender();
  }

  onTaskProgress(task: object, transferred: number): void {
    this.inFlight.set(task, transferred);
    this.speedWindow.add(this.now(), this.transferredBytes());
    this.scheduleRender();
  }

  onTaskDone(task: object, result: { error?: boolean; cancelled?: boolean }): void {
    this.doneFiles += 1;
    if (result.cancelled) {
      this.cancelledAny = true;
    } else if (result.error) {
      this.failedFiles += 1;
    }
    this.baseBytes += this.inFlight.get(task) || 0;
    this.inFlight.delete(task);
    this.scheduleRender();
  }

  endOperation(): void {
    this.activeOps -= 1;
    if (this.activeOps > 0) {
      return;
    }
    this.activeOps = 0;
    this.finalize();
  }

  private transferredBytes(): number {
    let sum = this.baseBytes;
    this.inFlight.forEach(v => (sum += v));
    return sum;
  }

  private scheduleRender(): void {
    if (this.throttleMs <= 0) {
      this.render();
      return;
    }
    if (this.renderTimer) {
      return;
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, this.throttleMs);
  }

  private composeText(): string {
    const xfer = this.transferredBytes();
    const known = this.totalBytes > 0;
    const speed = this.speedWindow.speed();

    let sizePart = formatBytes(xfer);
    if (known) {
      sizePart += ` / ${formatBytes(this.totalBytes)}`;
    }
    let tail = '';
    if (speed > 0) {
      tail += ` · ${formatSpeed(speed)}`;
      if (known) {
        const remaining = Math.max(0, this.totalBytes - xfer);
        tail += ` · ${formatDuration(remaining / speed)} left`;
      }
    }

    if (this.totalFiles > 1) {
      return `${this.direction}  (${this.doneFiles}/${this.totalFiles} files)  ${sizePart}${tail}`;
    }
    return `${this.direction} ${this.lastFilename}  ${sizePart}${tail}`;
  }

  private composeTooltip(): string {
    if (this.totalFiles > 1) {
      return `${this.doneFiles}/${this.totalFiles} files`;
    }
    return this.lastFilepath;
  }

  private render(): void {
    if (this.activeOps <= 0 && this.inFlight.size === 0) {
      return;
    }
    this.bar.showMsg(this.composeText(), this.composeTooltip());
  }

  private finalize(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }

    if (this.totalFiles === 0) {
      this.reset();
      return;
    }

    let text: string;
    if (this.totalFiles > 1) {
      if (this.cancelledAny) {
        text = `cancelled (${this.doneFiles}/${this.totalFiles})`;
      } else if (this.failedFiles > 0) {
        text = `done ${this.doneFiles - this.failedFiles} files, ${this.failedFiles} failed`;
      } else {
        text = `done ${this.totalFiles} files`;
      }
    } else {
      if (this.cancelledAny) {
        text = `cancelled ${this.lastFilename}`;
      } else if (this.failedFiles > 0) {
        text = `failed ${this.lastFilename}`;
      } else {
        text = `done ${this.lastFilename}`;
      }
    }

    this.bar.showMsg(text, this.composeTooltip(), 4000);
    this.reset();
  }

  private reset(): void {
    this.activeOps = 0;
    this.totalFiles = 0;
    this.doneFiles = 0;
    this.failedFiles = 0;
    this.cancelledAny = false;
    this.totalBytes = 0;
    this.baseBytes = 0;
    this.inFlight.clear();
    this.speedWindow.reset();
    this.direction = '';
    this.lastFilename = '';
    this.lastFilepath = '';
  }
}
