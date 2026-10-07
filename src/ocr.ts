import OcrWorker from './ocr.worker?worker&inline';
import readRuntimeBase64 from 'virtual:ort-wasm';
import type { OcrLine } from './core';

export interface OcrResult { text: string; confidence: number; lines: OcrLine[]; elapsed: number }
export class OcrEngine {
  private worker = new OcrWorker();
  private disposed = false;
  private counter = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
  constructor() {
    this.worker.onmessage = e => {
      const task = this.pending.get(e.data.id); if (!task) return;
      this.pending.delete(e.data.id);
      if (e.data.error) task.reject(new Error(e.data.error)); else task.resolve(e.data.result);
    };
    this.worker.onerror = e => { for (const task of this.pending.values()) task.reject(new Error(e.message || 'OCR Worker 运行失败。')); this.pending.clear(); };
  }
  private call<T>(type: string, data: unknown, transfer: Transferable[] = []): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('模型任务已取消。'));
    return new Promise((resolve, reject) => { const id = ++this.counter; this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, type, data }, transfer); });
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
    return this.call<{ backend: string; dictionarySize: number; gpu: string }>('init', { ...models, wasm, backend }, [wasm, models.detector, models.recognizer]);
  }
  recognize(bitmap: ImageBitmap, minConfidence: number) { return this.call<OcrResult>('recognize', { bitmap, minConfidence }, [bitmap]); }
  dispose() { this.disposed = true; this.worker.terminate(); for (const task of this.pending.values()) task.reject(new Error('模型任务已取消。')); this.pending.clear(); }
}
