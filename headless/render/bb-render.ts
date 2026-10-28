/**
 * Renders `.bbmodel` files through the render engine in `./engine`, a port of the core of bb-render
 * (a headless three.js WebGPU renderer).
 *
 * The engine runs on Node, not Bun: Bun segfaults inside Dawn's `dawn.node` addon. So this module
 * keeps `node cli.mjs --serve` worker processes, one render at a time each, up to the concurrency
 * limit. A worker keeps its GPU device, compiled pipelines and environment map between renders: a
 * fresh process spends most of a frame building those, so reuse makes a frame several times cheaper.
 * Workers exit after a quiet minute; a worker that times out is killed and replaced.
 * `cli.mjs` and its packages are prepared on first use by {@link prepareRenderRuntime}.
 *
 * An explicit `cli` (the `--bb-render` flag or `BB_RENDER_CLI`) bypasses that and runs any
 * compatible external bb-render build instead, one process per render, since such a build may not
 * serve.
 *
 * @module
 */

import { prepareRenderRuntime } from "./runtime";

/** Camera views bb-render understands (its `CAMERA_VIEWS`). */
export const RENDER_VIEWS = ["front", "back", "left", "right", "three-quarter", "iso", "top"] as const;

/** One camera view name. */
export type RenderView = (typeof RENDER_VIEWS)[number];

/** Built-in bb-render presets. */
export const RENDER_PRESETS = ["showcase", "turntable", "icon", "sprite-sheet-frame"] as const;

/** One preset name. */
export type RenderPreset = (typeof RENDER_PRESETS)[number];

/** How to reach the renderer. */
export interface IRendererConfig {
  /** Explicit path to a bb-render-compatible `cli.js`/`cli.mjs`; when set, nothing is installed. */
  cli?: string | undefined;
  /** Node executable (the engine needs Node 23.6+). */
  node: string;
  /** Renders allowed to run at once. */
  concurrency: number;
  /** Per-render timeout in milliseconds. */
  timeoutMs: number;
  /** Cache folder for the installed runtime; defaults to the per-user cache. */
  home?: string | undefined;
  /** Replaces {@link prepareRenderRuntime}; resolves to the CLI path. Used by tests. */
  prepare?: (() => Promise<string>) | undefined;
  /** Receives progress lines while the runtime installs. */
  log?: ((message: string) => void) | undefined;
}

/** One still-frame render request. */
export interface IRenderRequest {
  input: string;
  output: string;
  view?: RenderView;
  preset?: RenderPreset;
  width?: number;
  height?: number;
  transparent?: boolean;
  /** Animation clip name or index; renders the pose at `time`. */
  clip?: string;
  /** Clip time in seconds. */
  time?: number;
  orthographic?: boolean;
  lighting?: "studio" | "outdoor" | "flat";
}

/** Result of one render. */
export interface IRenderOutcome {
  output: string;
  milliseconds: number;
  log: string;
}

/** Limits concurrent async tasks. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  /** Runs `task` once a slot is free. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /** Takes a slot, waiting for a released one (handed over directly) when all are busy. */
  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolveSlot) => this.waiting.push(resolveSlot));
  }

  /** Hands the slot to the next waiter, or frees it. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

/** Builds bb-render CLI arguments for a request. */
export function buildRenderArgs(request: IRenderRequest): string[] {
  const optional: [string, string | number | undefined][] = [
    ["--preset", request.preset],
    ["--view", request.view],
    ["--width", request.width],
    ["--height", request.height],
    ["--start", request.clip === undefined ? undefined : request.time ?? 0],
    ["--lighting", request.lighting],
  ];
  // `--clip=<value>` keeps clip names that start with "-" from being read as flags.
  const clip = request.clip === undefined ? [] : [`--clip=${request.clip}`];
  return [
    request.input,
    "-o",
    request.output,
    "--quiet",
    ...optional.flatMap(([flag, value]) => (value === undefined ? [] : [flag, String(value)])),
    ...clip,
    ...(request.transparent ? ["--transparent"] : []),
    ...(request.orthographic ? ["--ortho"] : []),
  ];
}

/** How long an idle worker waits for its next render before exiting. */
const WORKER_IDLE_MS = 60_000;

interface IPending {
  resolve(outcome: IRenderOutcome): void;
  reject(error: Error): void;
  started: number;
  output: string;
  timer: ReturnType<typeof setTimeout>;
}

/** One `cli.mjs --serve` process, rendering the requests it is given one at a time. */
class RenderWorker {
  private readonly child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  private pending: IPending | undefined;
  private nextId = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private stderr = "";
  dead = false;

  constructor(node: string, cli: string, private readonly timeoutMs: number) {
    this.child = Bun.spawn([node, cli, "--serve"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    void this.readLines(this.child.stdout, (line) => this.answer(line));
    void this.readLines(this.child.stderr, (line) => {
      this.stderr = `${this.stderr}${line}\n`.slice(-4000);
    });
    void this.child.exited.then((code) => this.fail(new Error(`The render worker exited with code ${code}.\n${this.stderr.trim()}`)));
    this.armIdle();
  }

  /** Renders one request; the caller guarantees the worker is not busy. */
  render(request: IRenderRequest): Promise<IRenderOutcome> {
    clearTimeout(this.idle);
    this.nextId += 1;
    const line = `${JSON.stringify({ id: this.nextId, args: buildRenderArgs(request) })}\n`;
    return new Promise<IRenderOutcome>((resolve, reject) => {
      const started = performance.now();
      const timer = setTimeout(() => {
        this.fail(new Error(`The renderer was stopped (SIGKILL) after ${Math.round(performance.now() - started)} ms.\n${this.stderr.trim()}`));
      }, this.timeoutMs);
      this.pending = { resolve, reject, started, output: request.output, timer };
      this.child.stdin.write(line);
      void this.child.stdin.flush();
    });
  }

  private answer(line: string): void {
    const pending = this.pending;
    if (pending === undefined || line.trim() === "") return;
    let reply: { ok?: boolean; error?: string; log?: string };
    try {
      reply = JSON.parse(line) as typeof reply;
    } catch {
      return;
    }
    this.pending = undefined;
    clearTimeout(pending.timer);
    this.armIdle();
    if (reply.ok === true) pending.resolve({ output: pending.output, milliseconds: Math.round(performance.now() - pending.started), log: reply.log ?? "" });
    else pending.reject(new Error(`The renderer failed: ${reply.error ?? "unknown error"}\n${reply.log ?? ""}`.trim()));
  }

  /** Kills the worker and rejects its render, if any. */
  fail(error: Error): void {
    if (!this.dead) {
      this.dead = true;
      clearTimeout(this.idle);
      this.child.kill("SIGKILL");
    }
    const pending = this.pending;
    this.pending = undefined;
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private armIdle(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.fail(new Error("idle")), WORKER_IDLE_MS);
    this.idle.unref?.();
  }

  private async readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = "";
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        onLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    }
  }
}

/** Runs renders on pooled `--serve` workers, or one process per render for an explicit external CLI. */
export class BbRenderer {
  private readonly semaphore: Semaphore;
  private cliPromise: Promise<string> | undefined;
  private readonly idleWorkers: RenderWorker[] = [];
  private readonly workers = new Set<RenderWorker>();

  constructor(readonly config: IRendererConfig) {
    this.semaphore = new Semaphore(Math.max(1, config.concurrency));
  }

  /** Kills every worker, failing the renders in flight; the server calls it when its client leaves. */
  close(): void {
    this.idleWorkers.length = 0;
    this.workers.forEach((worker) => worker.fail(new Error("The renderer was closed.")));
    this.workers.clear();
  }

  /** Resolves the CLI path once: the explicit override, else the prepared runtime. A failed preparation is retried on the next render. */
  private resolveCli(): Promise<string> {
    if (this.config.cli) return Promise.resolve(this.config.cli);
    const pending = this.cliPromise ?? (this.config.prepare ?? (() => prepareRenderRuntime({ home: this.config.home, log: this.config.log })))();
    this.cliPromise = pending;
    pending.catch(() => {
      if (this.cliPromise === pending) this.cliPromise = undefined;
    });
    return pending;
  }

  /**
   * Renders one image.
   *
   * @throws Error when the runtime cannot be prepared, the render times out, or the process exits non-zero (with its output).
   */
  async render(request: IRenderRequest): Promise<IRenderOutcome> {
    const cli = await this.resolveCli().catch((error: unknown) => {
      throw new Error(`The render engine is not available: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (this.config.cli === undefined) return this.semaphore.run(() => this.renderOnWorker(cli, request));
    return this.semaphore.run(async () => {
      const started = performance.now();
      const child = Bun.spawn([this.config.node, cli, ...buildRenderArgs(request)], { stdout: "pipe", stderr: "pipe", timeout: this.config.timeoutMs, killSignal: "SIGKILL" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const log = `${stdout}${stderr}`.trim();
      if (child.signalCode) throw new Error(`The renderer was stopped (${child.signalCode}) after ${Math.round(performance.now() - started)} ms.
${log}`);
      if (exitCode !== 0) throw new Error(`The renderer exited with code ${exitCode}.
${log}`);
      return { output: request.output, milliseconds: Math.round(performance.now() - started), log };
    });
  }

  /** Renders on an idle worker, starting one when none is free; the semaphore bounds how many exist. */
  private async renderOnWorker(cli: string, request: IRenderRequest): Promise<IRenderOutcome> {
    let worker = this.idleWorkers.pop();
    while (worker?.dead) worker = this.idleWorkers.pop();
    if (worker === undefined) {
      worker = new RenderWorker(this.config.node, cli, this.config.timeoutMs);
      this.workers.add(worker);
    }
    try {
      return await worker.render(request);
    } finally {
      if (worker.dead) this.workers.delete(worker);
      else this.idleWorkers.push(worker);
    }
  }
}
