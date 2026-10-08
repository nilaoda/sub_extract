import { exportSubtitles, validateCues, type Project } from './core';
import type { BatchItem } from './batch';
export type SubtitleFormat = 'srt' | 'vtt' | 'json';
export function subtitleContents(project: Project, format: SubtitleFormat) {
  const error = validateCues(project.cues); if (error) throw new Error(error);
  return format === 'json' ? JSON.stringify(project, null, 2) : exportSubtitles(project.cues, format);
}
export function exportStem(name: string) {
  const clean = name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'episode';
  // Leave room within the usual 255-byte limit for the extension, collision
  // number and partial-result marker, without splitting Unicode characters.
  const encoder = new TextEncoder(); let stem = '', bytes = 0;
  for (const character of clean) {
    const length = encoder.encode(character).length;
    if (bytes + length > 180) break;
    stem += character; bytes += length;
  }
  return stem.replace(/[. ]+$/, '') || 'episode';
}
export function availableName(stem: string, format: SubtitleFormat, used: Set<string>) {
  let name = `${stem}.${format}`, index = 2;
  while (used.has(name.toLowerCase())) name = `${stem} (${index++}).${format}`;
  used.add(name.toLowerCase()); return name;
}
interface OutputFile {
  createWritable(): Promise<{ write(text: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}
export interface OutputDirectory {
  name: string; getFileHandle(name: string, options?: { create?: boolean }): Promise<OutputFile>;
  values(): AsyncIterable<{ name: string }>;
  requestPermission?(options: { mode: 'readwrite' }): Promise<string>;
}
export class BatchDirectoryWriter {
  private names = new Set<string>();
  constructor(public directory: OutputDirectory) {}
  async prepare() { for await (const file of this.directory.values()) this.names.add(file.name.toLowerCase()); }
  async save(item: BatchItem, formats: SubtitleFormat[]) {
    if (!item.result) return;
    for (const format of formats) {
      const key = `${format}:${item.result.extraction.complete ? 'complete' : 'partial'}`;
      let name = item.outputNames.get(key);
      if (!name) {
        const stem = exportStem(item.file.name) + (item.result.extraction.complete ? '' : ' (未完成)');
        name = availableName(stem, format, this.names); item.outputNames.set(key, name);
      }
      const text = subtitleContents(item.result, format);
      const handle = await this.directory.getFileHandle(name, { create: true }), writer = await handle.createWritable();
      try { await writer.write(text); await writer.close(); } catch (error) { try { await writer.abort(); } catch { /* Preserve the write error. */ } throw error; }
    }
    item.outputError = undefined;
  }
}

/** Uncompressed ZIP of small subtitle files. Video and model bytes never enter it. */
export function subtitleZip(entries: { name: string; text: string }[]): Blob {
  const encoder = new TextEncoder(), local: BlobPart[] = [], central: BlobPart[] = [];
  let offset = 0, directorySize = 0;
  if (entries.length > 65535) throw new Error('一次最多打包 65535 个字幕文件。');
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; table[i] = c; }
  for (const entry of entries) {
    const name = encoder.encode(entry.name), data = encoder.encode(entry.text);
    if (name.length > 65535) throw new Error('字幕文件名过长。');
    if (offset + 30 + name.length + data.length + directorySize + 46 + name.length + 22 > 96 * 1024 * 1024) throw new Error('字幕包超过 96 MB，请分批导出或选择输出目录。');
    let crc = 0xffffffff; for (const byte of data) crc = table[(crc ^ byte) & 255] ^ crc >>> 8; crc = (crc ^ 0xffffffff) >>> 0;
    const header = new Uint8Array(30 + name.length), view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true);
    view.setUint16(12, 33, true); view.setUint32(14, crc, true); view.setUint32(18, data.length, true); view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true); header.set(name, 30); local.push(header, data);
    const record = new Uint8Array(46 + name.length), directory = new DataView(record.buffer);
    directory.setUint32(0, 0x02014b50, true); directory.setUint16(4, 20, true); directory.setUint16(6, 20, true); directory.setUint16(8, 0x800, true);
    directory.setUint16(14, 33, true); directory.setUint32(16, crc, true); directory.setUint32(20, data.length, true); directory.setUint32(24, data.length, true);
    directory.setUint16(28, name.length, true); directory.setUint32(42, offset, true); record.set(name, 46);
    central.push(record); directorySize += record.length; offset += header.length + data.length;
  }
  const end = new Uint8Array(22), view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, entries.length, true); view.setUint16(10, entries.length, true);
  view.setUint32(12, directorySize, true); view.setUint32(16, offset, true);
  return new Blob([...local, ...central, end], { type: 'application/zip' });
}
