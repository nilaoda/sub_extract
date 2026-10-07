/** Group equal input shapes without padding, retaining each job's identity. */
export function groupOcrJobs<T extends { width: number; height: number }>(jobs: readonly T[], maxBatch = 2): T[][] {
  const groups = new Map<string, T[]>();
  for (const job of jobs) {
    const key = `${job.width}:${job.height}`;
    const group = groups.get(key) || [];
    group.push(job); groups.set(key, group);
  }
  const batches: T[][] = [];
  for (const group of groups.values()) for (let i = 0; i < group.length; i += maxBatch) batches.push(group.slice(i, i + maxBatch));
  return batches;
}

/** A failed pair is accepted as a compatibility fallback only if both singles succeed. */
export class CompatibleBatchRunner {
  fallback = false;
  constructor(public enabled: boolean) {}
  async run<T, R>(jobs: readonly T[], infer: (jobs: readonly T[]) => Promise<readonly R[]>): Promise<readonly R[]> {
    if (jobs.length === 1) return infer(jobs);
    if (this.enabled) {
      try { return await infer(jobs); }
      catch (batchError) {
        try {
          const values: R[] = [];
          for (const job of jobs) values.push(...await infer([job]));
          this.enabled = false; this.fallback = true;
          return values;
        } catch (singleError) {
          throw new Error(`批量与单张推理均失败：${String(batchError)}；${String(singleError)}`);
        }
      }
    }
    const values: R[] = [];
    for (const job of jobs) values.push(...await infer([job]));
    return values;
  }
}

export const OCR_WINDOW_FRAMES = 8;
export const OCR_WINDOW_BYTES = 16 * 1024 * 1024;

/** Own only cropped bitmaps, never decoded VideoFrames. Transfer ownership at flush. */
export class OcrCropQueue<T extends { width: number; height: number; close(): void }> {
  private pending: { bitmap: T; time: number }[] = [];
  private bytes = 0;
  constructor(private limit: number, private signal: AbortSignal,
    private consume: (items: { bitmap: T; time: number }[]) => Promise<void>) {}
  async add(bitmap: T, time: number) {
    if (this.signal.aborted) { bitmap.close(); this.signal.throwIfAborted(); }
    const bytes = bitmap.width * bitmap.height * 4;
    try {
      if (this.pending.length && this.bytes + bytes > OCR_WINDOW_BYTES) await this.flush();
      this.signal.throwIfAborted();
    } catch (error) { bitmap.close(); throw error; }
    this.pending.push({ bitmap, time }); this.bytes += bytes;
    if (this.pending.length >= this.limit || this.bytes >= OCR_WINDOW_BYTES) await this.flush();
  }
  async flush() {
    if (this.signal.aborted) { this.dispose(); this.signal.throwIfAborted(); }
    if (!this.pending.length) return;
    const items = this.pending; this.pending = []; this.bytes = 0;
    // consume owns the crops, including cleanup if transfer or inference fails.
    await this.consume(items);
  }
  dispose() { for (const item of this.pending) item.bitmap.close(); this.pending = []; this.bytes = 0; }
}
