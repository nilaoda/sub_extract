import OcrWorker from './ocr.worker?worker&inline';
import readRuntimeBase64 from 'virtual:ort-wasm';
import type { OcrLine } from './core';
import type { OcrTimings } from './performance';

export interface OcrTextResult { text: string; confidence: number; lines: OcrLine[] }
export interface OcrBatchCounts { detectorCalls: number; detectorBatch2: number; recognizerCalls: number; recognizerBatch2: number }
export interface OcrResult extends OcrTextResult { elapsed: number; timings?: OcrTimings; counts?: OcrBatchCounts }
export interface OcrWindowResult { values: OcrTextResult[]; elapsed: number; timings?: OcrTimings; counts: OcrBatchCounts; fallback: boolean }
export class OcrEngine {
  private worker = new OcrWorker();
  private disposed = false;
  private counter = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
  constructor(private profile = false) {
    this.worker.onmessage = e => {
      const task = this.pending.get(e.data.id); if (!task) return;
      this.pending.delete(e.data.id);
      if (e.data.error) task.reject(new Error(e.data.error)); else task.resolve(e.data.result);
    };
    this.worker.onerror = e => this.fail(new Error(e.message || 'OCR Worker 运行失败。'));
    this.worker.onmessageerror = () => this.fail(new Error('OCR Worker 返回的数据无法读取，请重新加载模型。'));
  }
  get isDisposed() { return this.disposed; }
  private fail(error: Error) {
    this.disposed = true; this.worker.terminate();
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
  }
  private call<T>(type: string, data: unknown, transfer: Transferable[] = []): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('模型任务已取消。'));
    return new Promise((resolve, reject) => {
      const id = ++this.counter; this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, type, data }, transfer); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async init(models: { detector: ArrayBuffer; recognizer: ArrayBuffer; dictionary: string }, backend: string) {
    const runtimeBase64 = readRuntimeBase64();
    const padding = runtimeBase64.endsWith('==') ? 2 : runtimeBase64.endsWith('=') ? 1 : 0;
    const compressed = new Uint8Array(runtimeBase64.length / 4 * 3 - padding);
    for (let start = 0, offset = 0; start < runtimeBase64.length; start += 65536) {
      const chunk = atob(runtimeBase64.slice(start, start + 65536));
      for (let i = 0; i < chunk.length; i++) compressed[offset++] = chunk.charCodeAt(i);
    }
    const wasm = await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    return this.call<{ backend: string; dictionarySize: number; gpu: string }>('init', { ...models, wasm, backend, profile: this.profile }, [wasm, models.detector, models.recognizer]);
  }
  async recognize(bitmap: ImageBitmap, minConfidence: number) {
    try { return await this.call<OcrResult>('recognize', { bitmap, minConfidence }, [bitmap]); }
    finally { bitmap.close(); }
  }
  async recognizeWindow(bitmaps: ImageBitmap[], minConfidence: number) {
    try { return await this.call<OcrWindowResult>('window', { bitmaps, minConfidence }, bitmaps); }
    finally { bitmaps.forEach(bitmap => bitmap.close()); }
  }
  dispose() { this.fail(new Error('模型任务已取消。')); }
}
