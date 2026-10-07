/** Fixed-size aggregate diagnostics: no frames, probabilities, or file names. */
export class PerformanceTotals {
  private stages: Record<string, { calls: number; totalMs: number; maxMs: number }> = {};
  private counts: Record<string, number> = {};
  add(name: string, durationMs: number) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const stage = this.stages[name] ||= { calls: 0, totalMs: 0, maxMs: 0 };
    stage.calls++; stage.totalMs += durationMs; stage.maxMs = Math.max(stage.maxMs, durationMs);
  }
  count(name: string, amount = 1) { this.counts[name] = (this.counts[name] || 0) + amount; }
  snapshot() {
    return {
      stages: Object.fromEntries(Object.entries(this.stages).map(([name, stage]) => [name, { ...stage, meanMs: stage.totalMs / stage.calls }])),
      counts: { ...this.counts },
    };
  }
}

export interface OcrTimings {
  detectorPrepareMs: number; detectorRunMs: number; detectorOutputMs: number; detectorPostMs: number;
  recognizerPrepareMs: number; recognizerRunMs: number; recognizerOutputMs: number;
  ctcMs: number; visualPostMs: number; outputBytes: number; boxes: number;
}
