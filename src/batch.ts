import type { Project, Region } from './core';
import type { ColorFilterOptions } from './color-filter';

export interface BatchSettings {
  region: Region; interval: number; confidence: number; batch: boolean; deduplicate: boolean; refine: boolean;
  ignoreClippedText: boolean; colorFilter?: ColorFilterOptions; startOffset: number; endTrim: number;
}
export interface BatchSource { file: File; path: string }
export type BatchStatus = 'waiting' | 'running' | 'completed' | 'failed' | 'partial';
export interface BatchItem extends BatchSource {
  id: string; key: string; status: BatchStatus; progress: number; detail: string; selected: boolean;
  settings?: BatchSettings; result?: Project; error?: string; outputError?: string; outputNames: Map<string, string>;
}
export const naturalOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export const supportedVideo = (name: string) => /\.(mp4|mov|m4v)$/i.test(name);
export function copySettings(settings: BatchSettings): BatchSettings {
  return { ...settings, region: { ...settings.region }, ...(settings.colorFilter ? { colorFilter: { ...settings.colorFilter } } : {}) };
}
export function batchRange(duration: number, settings: Pick<BatchSettings, 'startOffset' | 'endTrim'>) {
  const { startOffset: start, endTrim } = settings, end = Math.round(duration) - endTrim;
  if (![duration, start, endTrim].every(Number.isFinite) || start < 0 || endTrim < 0 || end <= start) throw new Error('跳过片头、片尾后的识别范围为空，请调整时间设置。');
  return { start, end };
}

/** Sample two small chunks; never hash or load a whole episode into memory. */
export async function sourceKey(file: File) {
  const chunks = [new Uint8Array(await file.slice(0, 32768).arrayBuffer()), new Uint8Array(await file.slice(Math.max(32768, file.size - 32768)).arrayBuffer())];
  const bytes = new Uint8Array(chunks[0].length + chunks[1].length); bytes.set(chunks[0]); bytes.set(chunks[1], chunks[0].length);
  let hash: string;
  if (globalThis.crypto?.subtle) hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  else {
    let a = 2166136261, b = 5381;
    for (const byte of bytes) { a = Math.imul(a ^ byte, 16777619); b = Math.imul(b, 33) ^ byte; }
    hash = `${a >>> 0}:${b >>> 0}`;
  }
  return JSON.stringify([file.name, file.size, file.lastModified, hash]);
}

interface DropEntry {
  name: string; isFile: boolean; isDirectory: boolean;
  file(callback: (file: File) => void, error: (error: DOMException) => void): void;
  createReader(): { readEntries(callback: (entries: DropEntry[]) => void, error: (error: DOMException) => void): void };
}
/** Capture entries inside the drop event, before DataTransfer becomes protected. */
export function droppedSources(data: DataTransfer): Promise<{ sources: BatchSource[]; errors: number }> {
  const entries = Array.from(data.items || []).filter(item => item.kind === 'file').map(item => ({
    entry: (item as unknown as { webkitGetAsEntry?(): DropEntry | null }).webkitGetAsEntry?.(),
    file: item.getAsFile?.(),
  }));
  const files = Array.from(data.files);
  return (async () => {
    const sources: BatchSource[] = []; let errors = 0;
    const walk = async (entry: DropEntry, parent: string) => {
      const path = parent + entry.name;
      if (entry.name.startsWith('.')) return;
      try {
        if (entry.isFile && supportedVideo(entry.name)) {
          const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject)); sources.push({ file, path });
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          while (true) {
            const children = await new Promise<DropEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
            if (!children.length) break;
            for (const child of children) await walk(child, path + '/');
          }
        }
      } catch { errors++; }
    };
    if (entries.some(item => item.entry)) {
      for (const item of entries) {
        if (item.entry) await walk(item.entry, '');
        else if (item.file) sources.push({ file: item.file, path: item.file.webkitRelativePath || item.file.name });
        else errors++;
      }
    } else for (const file of files) sources.push({ file, path: file.webkitRelativePath || file.name });
    return { sources, errors };
  })();
}
export class BatchJobError extends Error {
  constructor(message: string, public result?: Project) { super(message); }
}

/** One awaited job at a time, including saving. Pause takes effect between jobs. */
export class BatchRunner {
  running = false; pauseRequested = false;
  private controller?: AbortController;
  pause() { this.pauseRequested = true; }
  stop() { this.controller?.abort(new DOMException('批量任务已停止。', 'AbortError')); }
  async run(items: BatchItem[], shared: BatchSettings,
    execute: (item: BatchItem, settings: BatchSettings, signal: AbortSignal) => Promise<Project>,
    save: (item: BatchItem) => Promise<void>, update: () => void) {
    if (this.running) throw new Error('批量任务正在进行。');
    this.running = true; this.pauseRequested = false; this.controller = new AbortController();
    const signal = this.controller.signal, common = copySettings(shared);
    try {
      update();
      for (const item of items) {
        if (signal.aborted || this.pauseRequested) break;
        if (item.status !== 'waiting') continue;
        item.status = 'running'; item.progress = 0; item.error = undefined; item.outputError = undefined; item.result = undefined; update();
        try {
          item.result = await execute(item, copySettings(item.settings || common), signal);
          item.status = item.result.extraction.complete ? 'completed' : 'partial'; item.progress = item.status === 'completed' ? 1 : item.progress;
        } catch (error) {
          if (error instanceof BatchJobError) item.result = error.result;
          item.status = signal.aborted ? 'partial' : 'failed';
          item.error = error instanceof Error ? error.message : String(error);
        }
        if (item.result && (item.result.extraction.complete || item.result.cues.length)) {
          try { await save(item); } catch (error) { item.outputError = error instanceof Error ? error.message : String(error); }
        }
        update();
      }
    } finally { this.running = false; this.controller = undefined; update(); }
  }
}
