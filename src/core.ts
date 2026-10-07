export interface Region { x: number; y: number; width: number; height: number }
export interface OcrLine { text: string; confidence: number; box: Region; spacingInferred?: boolean; edgeFiltered?: boolean }
export interface Observation { time: number; text: string; confidence: number; lines: OcrLine[]; ocrTime?: number }
export interface Cue {
  id: string; start: number; end: number; text: string; lines: string[];
  confidence: number; needsReview: boolean; sampleTime: number; box?: Region;
}
export interface Project {
  schemaVersion: 1; timeUnit: 'ms'; source: { name: string; duration: number; width: number; height: number };
  extraction: { region: Region; start: number; end: number; sampleInterval: number; backend: string; model: string; complete: boolean };
  cues: Cue[];
}
export const DEFAULT_REGION: Region = { x: 0.1, y: 0.82, width: 0.8, height: 0.15 };
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export type CropCorner = 'nw' | 'ne' | 'sw' | 'se';
export function cropPointerMode(event: { button: number; ctrlKey: boolean; metaKey: boolean }, selecting: boolean, corner?: CropCorner): 'select' | 'center' | 'resize' | 'move' | undefined {
  // macOS can report Control + primary click as a secondary click.
  if (event.button !== 0 && !(event.button === 2 && event.ctrlKey)) return;
  return selecting ? 'select' : event.ctrlKey || event.metaKey ? 'center' : corner ? 'resize' : 'move';
}
export function moveRegion(region: Region, dx: number, dy: number, snapX = 0, snapY = 0) {
  let x = clamp(region.x + dx, 0, 1 - region.width), y = clamp(region.y + dy, 0, 1 - region.height);
  const snappedX = Math.abs(x + region.width / 2 - 0.5) <= snapX;
  const snappedY = Math.abs(y + region.height / 2 - 0.5) <= snapY;
  if (snappedX) x = (1 - region.width) / 2;
  if (snappedY) y = (1 - region.height) / 2;
  return { region: { ...region, x, y }, snappedX, snappedY };
}
export function resizeRegion(region: Region, corner: CropCorner, dx: number, dy: number, minWidth: number, minHeight: number): Region {
  const west = corner.endsWith('w'), north = corner.startsWith('n');
  const x = west ? clamp(region.x + dx, 0, region.x + region.width - minWidth) : region.x;
  const y = north ? clamp(region.y + dy, 0, region.y + region.height - minHeight) : region.y;
  const right = west ? region.x + region.width : clamp(region.x + region.width + dx, region.x + minWidth, 1);
  const bottom = north ? region.y + region.height : clamp(region.y + region.height + dy, region.y + minHeight, 1);
  return { x, y, width: right - x, height: bottom - y };
}
export function resizeRegionFromCenter(region: Region, dx: number, dy: number, minWidth: number, minHeight: number): Region {
  const cx = region.x + region.width / 2, cy = region.y + region.height / 2;
  const width = clamp(region.width + dx * 2, Math.min(minWidth, Math.min(cx, 1 - cx) * 2), Math.min(cx, 1 - cx) * 2);
  const height = clamp(region.height + dy * 2, Math.min(minHeight, Math.min(cy, 1 - cy) * 2), Math.min(cy, 1 - cy) * 2);
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/** DB can return both a whole line and overlapping character/word components. */
export function mergeTextBoxes(boxes: Region[]): Region[] {
  const merged = boxes.map(box => ({ ...box }));
  for (let i = 0; i < merged.length; i++) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = i + 1; j < merged.length; j++) {
        const a = merged[i], b = merged[j];
        const vertical = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        const gap = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width);
        if (vertical < Math.min(a.height, b.height) * 0.6 || gap > Math.min(a.height, b.height) * 0.5) continue;
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        merged[i] = { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
        merged.splice(j, 1); changed = true; break;
      }
    }
  }
  return merged.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function formatTime(ms: number, separator = '.'): string {
  const value = Math.max(0, Math.round(ms));
  const h = Math.floor(value / 3_600_000);
  const m = Math.floor(value / 60_000) % 60;
  const s = Math.floor(value / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${separator}${String(value % 1000).padStart(3, '0')}`;
}
export function parseTime(input: string): number | null {
  if (/^\d+(?:\.\d+)?$/.test(input.trim())) return Number(input) * 1000;
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(input.trim());
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) return null;
  return (Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 + Number((match[4] || '').padEnd(3, '0'));
}
export function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}
export function similarity(a: string, b: string): number {
  const x = [...normalizeText(a)], y = [...normalizeText(b)];
  if (!x.length || !y.length) return x.length === y.length ? 1 : 0;
  let row = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(x[i - 1] !== y[j - 1]));
    row = next;
  }
  return 1 - row[y.length] / Math.max(x.length, y.length);
}

interface TextVote { weight: number; best: Observation }
interface SubtitleRun {
  start: number; end: number; text: string; confidenceSum: number; duration: number;
  samples: number; votes: Map<string, TextVote>; visualCorrection: boolean;
}
const FLICKER_MS = 180;

/** A partial read may omit characters, but must not replace them with different words. */
function isPartialRead(partial: string, complete: string): boolean {
  if (partial.split('\n').length !== complete.split('\n').length) return false;
  const short = [...normalizeText(partial)], long = [...normalizeText(complete)];
  if (short.length < 3 || short.length >= long.length || short.length / long.length < 0.6 || long.length - short.length > Math.max(2, Math.floor(long.length * 0.25))) return false;
  let matched = 0;
  for (const char of long) if (char === short[matched]) matched++;
  return matched === short.length;
}
function relatedRead(a: string, b: string): boolean {
  return isPartialRead(a, b) || isPartialRead(b, a) || similarity(a, b) >= 0.8;
}
function sameRead(a: string, b: string): boolean {
  return normalizeText(a) === normalizeText(b) && a.split('\n').length === b.split('\n').length;
}
function leadingStrokeConfusion(stable: string, variant: string): boolean {
  // Only repair this known glyph confusion when matching readings surround it.
  return /^一\p{Script=Han}{3,}$/u.test(stable) && /^[-−—–]\p{Script=Han}{3,}$/u.test(variant) && stable.slice(1) === variant.slice(1);
}
function mergeRuns(left: SubtitleRun, right: SubtitleRun): SubtitleRun {
  const votes = new Map([...left.votes].map(([key, value]) => [key, { ...value }]));
  for (const [text, vote] of right.votes) {
    const existing = votes.get(text);
    if (existing) { existing.weight += vote.weight; if (vote.best.confidence > existing.best.confidence) existing.best = vote.best; }
    else votes.set(text, { ...vote });
  }
  const text = [...votes].sort((a, b) => b[1].weight - a[1].weight)[0][0];
  return { start: left.start, end: right.end, text, confidenceSum: left.confidenceSum + right.confidenceSum, duration: left.duration + right.duration, samples: left.samples + right.samples, votes, visualCorrection: left.visualCorrection || right.visualCorrection };
}

/** Stabilize brief OCR variants; sustained changes and explicit blank intervals stay separate. */
export function buildCues(observations: Observation[], rangeStart: number, rangeEnd: number, interval: number): Cue[] {
  const samples = [...observations].filter(o => o.time >= rangeStart && o.time < rangeEnd).sort((a, b) => a.time - b.time);
  const runs: SubtitleRun[] = [];
  for (let i = 0; i < samples.length; i++) {
    const current = samples[i], previous = samples[i - 1], next = samples[i + 1];
    const gapBefore = previous && current.time - previous.time > interval * 2.5;
    const gapAfter = next && next.time - current.time > interval * 2.5;
    const start = Math.max(rangeStart, previous && !gapBefore ? (previous.time + current.time) / 2 : current.time - interval / 2);
    const end = Math.min(rangeEnd, next ? (gapAfter ? current.time + interval / 2 : (current.time + next.time) / 2) : rangeEnd);
    const duration = Math.max(0, end - start), text = current.text.trim();
    const run: SubtitleRun = { start, end, text, confidenceSum: current.confidence * duration, duration, samples: 1, votes: new Map([[text, { weight: Math.max(0.1, current.confidence) * duration, best: current }]]), visualCorrection: current.lines.some(line => line.spacingInferred || line.edgeFiltered) };
    const last = runs.at(-1);
    if (last && !gapBefore && sameRead(last.text, text)) runs[runs.length - 1] = mergeRuns(last, run);
    else runs.push(run);
  }

  // A -> brief related variant -> A: use both stable sides as evidence, even when
  // boundary refinement has produced many more samples inside the brief variant.
  const stabilized: SubtitleRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const current = runs[i], previous = stabilized.at(-1), next = runs[i + 1];
    const connected = previous && next && previous.end === current.start && current.end === next.start;
    const strokeFlicker = connected && leadingStrokeConfusion(previous!.text, current.text) && current.duration <= 600 && previous!.duration >= 250 && next!.duration >= 250 && previous!.duration + next!.duration >= current.duration * 2;
    if (connected && current.text && previous!.text && (current.duration <= FLICKER_MS || strokeFlicker) && sameRead(previous!.text, next!.text) && relatedRead(previous!.text, current.text)) {
      stabilized[stabilized.length - 1] = mergeRuns(mergeRuns(previous!, current), next!); i++;
    } else stabilized.push(current);
  }

  const groups: SubtitleRun[] = [];
  for (let i = 0; i < stabilized.length; i++) {
    const current = stabilized[i], previous = groups.at(-1), next = stabilized[i + 1];
    const adjacent = previous && previous.end === current.start;
    if (adjacent && current.text && previous!.text && (sameRead(previous!.text, current.text) || (current.duration <= FLICKER_MS && isPartialRead(current.text, previous!.text)))) {
      groups[groups.length - 1] = mergeRuns(previous!, current);
    } else if (current.text && next?.text && current.end === next.start && current.duration <= FLICKER_MS && isPartialRead(current.text, next.text)) {
      const merged = mergeRuns(current, next); i++;
      const last = groups.at(-1);
      if (last?.text && last.end === merged.start && sameRead(last.text, merged.text)) groups[groups.length - 1] = mergeRuns(last, merged);
      else groups.push(merged);
    } else groups.push(current);
  }
  const consolidated: SubtitleRun[] = [];
  for (const run of groups) {
    const last = consolidated.at(-1);
    if (last && last.end === run.start && sameRead(last.text, run.text)) consolidated[consolidated.length - 1] = mergeRuns(last, run);
    else consolidated.push(run);
  }
  return consolidated.filter(run => run.text && run.end > run.start).map((run, index) => {
    const best = run.votes.get(run.text)!.best, confidence = run.duration ? run.confidenceSum / run.duration : best.confidence;
    return { id: `cue-${String(index + 1).padStart(4, '0')}`, start: Math.round(run.start), end: Math.round(run.end), text: run.text, lines: run.text.split('\n'), confidence, needsReview: confidence < 0.88 || run.samples === 1 || run.votes.size > 1 || run.duration <= FLICKER_MS || run.visualCorrection, sampleTime: best.ocrTime ?? best.time, box: best.lines[0]?.box };
  });
}

export function validateCues(cues: Cue[]): string | null {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const cue = sorted[i];
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start) return `第 ${i + 1} 条字幕的结束时间必须晚于开始时间。`;
    if (!cue.text.trim()) return `第 ${i + 1} 条字幕的文本为空。`;
    if (i && cue.start < sorted[i - 1].end) return `第 ${i + 1} 条字幕与上一条时间重叠，请先修正。`;
  }
  return null;
}
export function exportSubtitles(cues: Cue[], format: 'srt' | 'vtt'): string {
  const error = validateCues(cues); if (error) throw new Error(error);
  const separator = format === 'srt' ? ',' : '.';
  const blocks = [...cues].sort((a, b) => a.start - b.start).map((cue, index) => {
    // Escape VTT markup so OCR text is rendered literally; preserve intentional line breaks.
    const text = format === 'vtt' ? cue.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') : cue.text;
    return `${index + 1}\n${formatTime(cue.start, separator)} --> ${formatTime(cue.end, separator)}\n${text.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n')}`;
  });
  return (format === 'vtt' ? 'WEBVTT\n\n' : '') + blocks.join('\n\n') + '\n';
}
export function importProject(value: unknown): Project {
  if (!value || typeof value !== 'object') throw new Error('JSON 项目格式不正确。');
  const p = value as Project;
  if (p.schemaVersion !== 1 || p.timeUnit !== 'ms' || !p.source || typeof p.source.name !== 'string' || !p.extraction || !Array.isArray(p.cues) || p.cues.length > 100_000) throw new Error('请选择 Sub Extract 导出的 JSON 项目（版本 1，毫秒）。');
  for (const cue of p.cues) {
    if (!cue || typeof cue.text !== 'string' || typeof cue.id !== 'string' || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || !Number.isFinite(cue.confidence) || !Number.isFinite(cue.sampleTime)) throw new Error('JSON 字幕字段不完整。');
    cue.lines = cue.text.split('\n'); cue.needsReview = Boolean(cue.needsReview);
  }
  const error = validateCues(p.cues); if (error) throw new Error(error);
  const r = p.extraction.region;
  if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 || r.x + r.width > 1.001 || r.y + r.height > 1.001) throw new Error('JSON 字幕区域无效。');
  if (![p.source.duration, p.source.width, p.source.height, p.extraction.start, p.extraction.end, p.extraction.sampleInterval].every(Number.isFinite) || p.extraction.start < 0 || p.extraction.end <= p.extraction.start || p.extraction.sampleInterval <= 0) throw new Error('JSON 时间或视频信息无效。');
  return p;
}

export interface CtcToken { text: string; start: number; end: number }
export function decodeCTC(data: Float32Array, dims: readonly number[], dictionary: string[]): { text: string; confidence: number; tokens: CtcToken[] } {
  if (dims.length !== 3 || dims[0] !== 1) throw new Error('识别模型输出必须为 [1, 时间步, 字符类别]。');
  const [, steps, classes] = dims;
  if (classes !== dictionary.length) throw new Error(`字典与模型不匹配：模型 ${classes} 类，字典 ${dictionary.length} 类（含 blank）。`);
  let text = '', previous = -1, sum = 0, count = 0;
  const tokens: CtcToken[] = [];
  for (let t = 0; t < steps; t++) {
    let id = 0, probability = -Infinity;
    for (let k = 0; k < classes; k++) if (data[t * classes + k] > probability) { id = k; probability = data[t * classes + k]; }
    if (id !== 0 && id !== previous) { text += dictionary[id]; sum += probability; count++; tokens.push({ text: dictionary[id], start: t, end: t + 1 }); }
    else if (id !== 0) tokens[tokens.length - 1].end = t + 1;
    previous = id;
  }
  return { text: text.trim(), confidence: count ? clamp(sum / count, 0, 1) : 0, tokens };
}

export function outlinedTextProjection(pixels: Uint8ClampedArray, width: number, height: number, contentWidth: number) {
  const columns = new Uint16Array(contentWidth), rows = new Uint16Array(height);
  const radius = Math.max(1, Math.round(height / 24)), horizontal = radius * 4, vertical = radius * width * 4;
  for (let y = radius; y < height - radius; y++) for (let x = radius; x < contentWidth - radius; x++) {
    const offset = (y * width + x) * 4, r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
    if (Math.min(r, g, b) < 185 || Math.max(r, g, b) - Math.min(r, g, b) > 70) continue;
    const left = offset - horizontal, right = offset + horizontal, top = offset - vertical, bottom = offset + vertical;
    const outlined = Math.max(pixels[left], pixels[left + 1], pixels[left + 2]) < 125
      || Math.max(pixels[right], pixels[right + 1], pixels[right + 2]) < 125
      || Math.max(pixels[top], pixels[top + 1], pixels[top + 2]) < 125
      || Math.max(pixels[bottom], pixels[bottom + 1], pixels[bottom + 2]) < 125;
    if (outlined) { columns[x]++; rows[y]++; }
  }
  return { columns, rows };
}

/** Reject an edge glyph hallucinated from background only when the rest of a
 * Chinese line provides strong evidence of bright, dark-outlined text. */
export function filterUnsupportedEdgeTokens(tokens: CtcToken[], pixels: Uint8ClampedArray, width: number, height: number, steps: number, contentWidth: number, projection?: () => ReturnType<typeof outlinedTextProjection>): CtcToken[] {
  const han = tokens.flatMap((token, i) => /^\p{Script=Han}$/u.test(token.text) ? [i] : []);
  if (han.length < 4 || !tokens.every(token => /^[\p{Script=Han}\p{P}\s]+$/u.test(token.text))) return tokens;
  const { columns } = projection ? projection() : outlinedTextProjection(pixels, width, height, contentWidth);
  const centers = tokens.map(token => (token.start + token.end) / 2 / steps * width);
  const support = tokens.map((_, i) => {
    const left = i ? (centers[i - 1] + centers[i]) / 2 : 0;
    const right = i + 1 < tokens.length ? (centers[i] + centers[i + 1]) / 2 : contentWidth;
    let count = 0;
    for (let x = Math.max(0, Math.ceil(left)); x < Math.min(right, contentWidth); x++) count += columns[x];
    return count;
  });
  const sorted = han.map(i => support[i]).sort((a, b) => a - b);
  const typicalSupport = sorted[Math.floor(sorted.length / 2)];
  if (typicalSupport < height * 2 || han.filter(i => support[i] >= typicalSupport * 0.15).length < han.length * 0.75) return tokens;
  const first = tokens.findIndex(token => token.text.trim());
  let last = tokens.length - 1;
  while (last >= 0 && !tokens[last].text.trim()) last--;
  const rejected = [first, last].filter(i => han.includes(i) && support[i] <= Math.max(2, typicalSupport * 0.01));
  return rejected.length ? tokens.filter((_, i) => !rejected.includes(i)) : tokens;
}

/** Restore only visibly large gaps between Chinese glyphs, using CTC alignment
 * and bright outlined strokes. A CTC blank alone does not mean a literal space. */
export function restoreVisualSpaces(text: string, tokens: CtcToken[], pixels: Uint8ClampedArray, width: number, height: number, steps: number, contentWidth: number, projection?: () => ReturnType<typeof outlinedTextProjection>): string {
  const isHan = (token: CtcToken) => /^\p{Script=Han}$/u.test(token.text);
  const glyphCount = tokens.filter(isHan).length;
  if (glyphCount < 2 || !/^[\p{Script=Han}\p{Zs}]+$/u.test(text) || tokens.some(token => !isHan(token) && !/^\p{Zs}+$/u.test(token.text))) return text;
  const centers = tokens.map(token => (token.start + token.end) / 2);
  // Already recognized spaces stay intact and do not inflate the baseline.
  const advances = centers.slice(1).flatMap((center, i) => isHan(tokens[i]) && isHan(tokens[i + 1]) ? [center - centers[i]] : []).sort((a, b) => a - b);
  if (!advances.length) return text;
  // A lower median resists a few phrase gaps while retaining ordinary glyph spacing.
  const typicalAdvance = advances[Math.floor((advances.length - 1) / 2)];
  const { columns, rows } = projection ? projection() : outlinedTextProjection(pixels, width, height, contentWidth);
  const inkRows = [...rows].flatMap((count, y) => count >= glyphCount ? [y] : []);
  if (inkRows.length < height * 0.2) return text;
  const inkHeight = inkRows.at(-1)! - inkRows[0] + 1, minimumGap = Math.max(6, inkHeight * 0.45);
  const gaps: { start: number; end: number }[] = [];
  let lastInk = -1;
  for (let x = 0; x < contentWidth; x++) {
    if (columns[x] < 2) continue;
    if (lastInk >= 0 && x - lastInk - 1 >= minimumGap) gaps.push({ start: lastInk + 1, end: x });
    lastInk = x;
  }
  let restored = '';
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0 && isHan(tokens[i - 1]) && isHan(tokens[i])) {
      const previous = tokens[i - 1], current = tokens[i];
      const left = (previous.start + previous.end) / 2 / steps * width;
      const right = (current.start + current.end) / 2 / steps * width;
      // CTC centers are quantized: half a step prevents a visible space from
      // failing just below the ratio threshold (e.g. 8 steps versus 8.1).
      if (centers[i] - centers[i - 1] + 0.5 >= typicalAdvance * 1.35 && gaps.some(gap => (gap.start + gap.end) / 2 > left && (gap.start + gap.end) / 2 < right)) restored += ' ';
    }
    restored += tokens[i].text;
  }
  return restored.trim();
}
