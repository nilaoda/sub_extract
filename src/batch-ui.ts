import { BatchRunner, copySettings, droppedSources, naturalOrder, sourceKey, supportedVideo, type BatchItem, type BatchSettings, type BatchSource } from './batch';
import { availableName, BatchDirectoryWriter, exportStem, subtitleContents, subtitleZip, type OutputDirectory, type SubtitleFormat } from './batch-export';
import type { Project } from './core';

interface BatchAdapter {
  capture(): BatchSettings;
  apply(settings: BatchSettings): void;
  mode(enabled: boolean): Promise<void>;
  open(item: BatchItem, settings: BatchSettings, signal?: AbortSignal): Promise<void>;
  execute(signal: AbortSignal, progress: (value: number, detail: string) => void): Promise<Project>;
  release(): void;
  ready(): boolean;
  busy(): boolean;
  refresh(): void;
  toast(text: string, error?: boolean): void;
}
const labels = { waiting: '待处理', running: '识别中', completed: '已完成', partial: '未完成', failed: '失败' };
export function setupBatch(adapter: BatchAdapter) {
  const workspace = document.querySelector<HTMLElement>('.workspace')!;
  const nav = document.createElement('nav'); nav.className = 'mode-nav'; nav.setAttribute('aria-label', '处理模式');
  nav.innerHTML = '<button id="single-mode" class="selected" aria-pressed="true">单个视频</button><button id="batch-mode" aria-pressed="false">批量剧集</button><span id="batch-context" class="hint"></span><button id="batch-back" class="quiet" hidden>返回队列</button>';
  workspace.before(nav);
  const panel = document.createElement('section'); panel.id = 'batch-panel'; panel.className = 'batch-panel'; panel.hidden = true;
  panel.innerHTML = `<div class="section-heading"><div><span class="eyebrow">QUEUE / 剧集队列</span><h1>批量提取</h1></div><span id="batch-count" class="mono">0 集</span></div>
<div id="batch-drop" class="batch-drop"><strong>拖入文件夹或视频文件</strong><p class="hint">包含子文件夹 · MP4 / MOV / M4V · 可继续追加</p><div class="batch-actions"><label class="button secondary file-action">添加视频<input id="batch-files" type="file" accept=".mp4,.mov,.m4v" multiple></label><label class="button secondary file-action">添加文件夹<input id="batch-folder" type="file" webkitdirectory multiple></label></div></div>
<div class="batch-actions queue-tools"><label class="check"><input id="batch-select-all" type="checkbox" checked>全选</label><button id="batch-sort" class="quiet">按名称排序</button><button id="batch-remove" class="quiet">移除所选</button><button id="batch-clear-done" class="quiet">清除已完成</button><button id="batch-retry" class="quiet">重试失败 / 未完成</button></div>
<div id="batch-list" class="batch-list" aria-label="剧集处理队列"></div>
<section class="batch-output"><h2>结果保存</h2><div class="batch-actions"><label class="check"><input data-batch-format="srt" type="checkbox" checked>SRT</label><label class="check"><input data-batch-format="vtt" type="checkbox">WebVTT</label><label class="check"><input data-batch-format="json" type="checkbox" checked>JSON</label><button id="batch-directory" class="secondary">选择输出目录</button><button id="batch-download" class="secondary">下载字幕 ZIP</button><button id="batch-save" class="quiet">保存已有结果</button></div><p id="batch-output-status" class="hint">未选择输出目录；完成后可下载字幕 ZIP。</p></section>
<div class="batch-run"><div><p id="batch-status" role="status">添加视频，校准共用字幕区域后开始。</p><p class="hint">逐集处理 · 复用一个模型 · 关闭页面后需重新选片</p></div><div class="batch-actions"><button id="batch-start" class="primary">开始所选剧集</button><button id="batch-pause" class="secondary" hidden>本集完成后暂停</button><button id="batch-stop" class="secondary" hidden>停止全部</button></div></div><progress id="batch-progress" value="0" max="1" aria-label="批量提取进度"></progress>`;
  workspace.prepend(panel);
  const scope = document.createElement('section'); scope.className = 'batch-scope'; scope.hidden = true;
  scope.innerHTML = `<div class="batch-actions"><strong id="batch-preview-name">共用设置</strong><select id="batch-scope" aria-label="设置作用范围"><option value="shared">共用设置</option><option value="episode">仅本集</option></select><button id="batch-use-shared" class="quiet">本集使用共用设置</button><button id="batch-apply-all" class="quiet">应用到全部</button></div><div class="batch-offsets"><label>跳过片头（秒）<input id="batch-intro" type="number" value="0" min="0" step="0.1"></label><label>跳过片尾（秒）<input id="batch-outro" type="number" value="0" min="0" step="0.1"></label></div><p class="hint">共用区域按画面比例应用。选择一集预览校准；单集设置覆盖共用设置。</p>`;
  document.querySelector('.editor .section-heading')!.after(scope);
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const runner = new BatchRunner(), items: BatchItem[] = [];
  let enabled = false, loading = false, exporting = false, switching = false, review = false;
  let shared = copySettings(adapter.capture()), current: BatchItem | undefined, writer: BatchDirectoryWriter | undefined;
  let lastPaint = 0, entered = false, scopeValue = 'shared';
  function setScope(value: string) { scopeValue = value; $<HTMLSelectElement>('batch-scope').value = value; }
  const locked = () => runner.running || loading || exporting || switching;
  const formats = () => Array.from(panel.querySelectorAll<HTMLInputElement>('[data-batch-format]:checked')).map(input => input.dataset.batchFormat as SubtitleFormat);
  const draft = () => {
    const settings = adapter.capture();
    settings.startOffset = Number($<HTMLInputElement>('batch-intro').value) * 1000;
    settings.endTrim = Number($<HTMLInputElement>('batch-outro').value) * 1000;
    if (![settings.startOffset, settings.endTrim].every(n => Number.isFinite(n) && n >= 0)) throw new Error('片头、片尾时间必须为不小于零的秒数。');
    return settings;
  };
  function commitDraft() {
    if (review) return;
    const settings = draft();
    if (scopeValue === 'episode' && current) current.settings = copySettings(settings);
    else shared = copySettings(settings);
  }
  function apply(settings: BatchSettings) {
    adapter.apply(copySettings(settings));
    $<HTMLInputElement>('batch-intro').value = String(settings.startOffset / 1000);
    $<HTMLInputElement>('batch-outro').value = String(settings.endTrim / 1000);
  }
  function layout() {
    workspace.classList.toggle('batch-mode', enabled && !review);
    workspace.classList.toggle('batch-review', enabled && review);
    panel.hidden = !enabled || review; scope.hidden = !enabled || review;
    $('batch-back').hidden = !enabled || !review;
    $('batch-context').textContent = enabled ? review ? `复核 · ${current?.file.name || ''}` : '共用模型 · 逐集处理' : '';
    for (const [id, active] of [['single-mode', !enabled], ['batch-mode', enabled]] as const) {
      $(id).classList.toggle('selected', active); $(id).setAttribute('aria-pressed', String(active));
    }
    adapter.refresh(); render();
  }
  function refresh() {
    const disabled = locked() || adapter.busy();
    for (const control of nav.querySelectorAll<HTMLButtonElement>('button')) control.disabled = disabled;
    for (const control of panel.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) control.disabled = disabled;
    for (const control of scope.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) control.disabled = disabled;
    $('batch-start').hidden = runner.running; $('batch-pause').hidden = !runner.running; $('batch-stop').hidden = !runner.running;
    $<HTMLButtonElement>('batch-pause').disabled = !runner.running || runner.pauseRequested;
    $<HTMLButtonElement>('batch-stop').disabled = !runner.running;
    $<HTMLButtonElement>('batch-start').disabled = disabled || !adapter.ready() || !items.some(i => i.selected && i.status === 'waiting') || !formats().length;
    $<HTMLButtonElement>('batch-download').disabled = disabled || !items.some(i => i.result) || !formats().length;
    $<HTMLButtonElement>('batch-save').disabled = disabled || !writer || !items.some(i => i.result) || !formats().length;
    $<HTMLSelectElement>('batch-scope').disabled ||= !current;
    $<HTMLButtonElement>('batch-use-shared').disabled ||= !current;
    const all = $<HTMLInputElement>('batch-select-all'); all.checked = items.length > 0 && items.every(i => i.selected); all.indeterminate = items.some(i => i.selected) && !all.checked;
  }
  function itemDetail(item: BatchItem) {
    return `${labels[item.status]}${item.settings ? ' · 单集设置' : ''}${item.result ? ` · ${item.result.cues.length} 条字幕` : ''}${item.detail && item.status === 'running' ? ' · ' + item.detail : ''}${item.error ? ' · ' + item.error : ''}${item.outputError ? ' · 保存失败：' + item.outputError : ''}`;
  }
  function updateTotals() {
    const complete = items.filter(i => i.status === 'completed').length, failed = items.filter(i => i.status === 'failed').length;
    $('batch-status').textContent = items.length ? `${complete} / ${items.length} 集完成${failed ? ` · ${failed} 集失败` : ''}${runner.running ? runner.pauseRequested ? ' · 本集结束后暂停' : ' · 处理中' : items.some(i => i.status === 'waiting') ? ' · 可继续处理待选剧集' : ' · 队列处理结束'}` : '添加视频，校准共用字幕区域后开始。';
    $<HTMLProgressElement>('batch-progress').value = items.length ? items.reduce((sum, i) => sum + (i.status === 'completed' ? 1 : i.progress), 0) / items.length : 0;
  }
  function updateProgress(item: BatchItem) {
    const row = $('batch-list').querySelector<HTMLElement>(`[data-id="${item.id}"]`);
    if (row) { row.querySelector('.batch-row-detail')!.textContent = itemDetail(item); row.querySelector<HTMLProgressElement>('progress')!.value = item.progress; }
    updateTotals();
  }
  function render() {
    $('batch-count').textContent = `${items.length} 集`;
    const list = $('batch-list'); list.replaceChildren();
    if (!items.length) { const empty = document.createElement('p'); empty.className = 'batch-empty'; empty.textContent = '剧集按名称自然排序。先选一集校准字幕区域，再开始整批。'; list.append(empty); }
    items.forEach((item, index) => {
      const row = document.createElement('article'); row.className = 'batch-row'; row.dataset.id = item.id; row.classList.toggle('active', item === current);
      row.innerHTML = `<input class="batch-select" type="checkbox" aria-label="选择剧集"><span class="batch-index mono"></span><div class="batch-row-main"><strong class="batch-name"></strong><span class="batch-path hint"></span><div class="batch-row-detail hint"></div><progress max="1" aria-label="本集进度"></progress></div><div class="batch-row-actions"><button data-action="preview" class="quiet">预览</button><button data-action="review" class="quiet">复核</button><button data-action="retry" class="quiet">重试</button><button data-action="up" class="quiet" aria-label="上移剧集">↑</button><button data-action="down" class="quiet" aria-label="下移剧集">↓</button><button data-action="remove" class="quiet" aria-label="移除剧集">×</button></div>`;
      row.querySelector<HTMLInputElement>('input')!.checked = item.selected;
      row.querySelector('.batch-index')!.textContent = String(index + 1).padStart(2, '0');
      row.querySelector('.batch-name')!.textContent = item.file.name;
      row.querySelector('.batch-path')!.textContent = item.path === item.file.name ? '' : item.path;
      row.querySelector('.batch-row-detail')!.textContent = itemDetail(item);
      row.querySelector<HTMLProgressElement>('progress')!.value = item.progress;
      row.querySelector<HTMLButtonElement>('[data-action="review"]')!.hidden = !item.result;
      row.querySelector<HTMLButtonElement>('[data-action="retry"]')!.hidden = !['failed', 'partial'].includes(item.status);
      row.querySelector<HTMLButtonElement>('[data-action="up"]')!.hidden = index === 0;
      row.querySelector<HTMLButtonElement>('[data-action="down"]')!.hidden = index === items.length - 1;
      list.append(row);
    });
    updateTotals();
    refresh();
  }
  function fail(error: unknown) { adapter.toast(error instanceof Error ? error.message : String(error), true); }
  async function add(sources: BatchSource[]) {
    if (locked() || adapter.busy()) return;
    loading = true; adapter.refresh(); refresh();
    try {
      const initialLength = items.length, keys = new Set(items.map(i => i.key)); let added = 0, duplicates = 0, ignored = 0;
      for (const entry of sources) {
        if (!supportedVideo(entry.file.name)) { ignored++; continue; }
        if (items.length >= 1000) throw new Error('一次最多加入 1000 集，请分批处理。');
        const key = await sourceKey(entry.file);
        if (keys.has(key)) { duplicates++; continue; }
        keys.add(key); items.push({ ...entry, key, id: crypto.randomUUID(), status: 'waiting', progress: 0, detail: '', selected: true, outputNames: new Map() }); added++;
      }
      const additions = items.splice(initialLength).sort((a, b) => naturalOrder.compare(a.path, b.path)); items.push(...additions);
      adapter.toast(`加入 ${added} 集${duplicates ? ` · 跳过 ${duplicates} 个重复文件` : ''}${ignored ? ` · 忽略 ${ignored} 个非视频文件` : ''}`);
    } catch (error) { fail(error); }
    finally { loading = false; render(); adapter.refresh(); }
  }
  async function drop(data: DataTransfer) {
    if (locked() || adapter.busy()) return;
    // Collect entries synchronously before the native drop event returns.
    const pending = droppedSources(data); loading = true; adapter.refresh(); refresh();
    try { const result = await pending; loading = false; await add(result.sources); if (result.errors) adapter.toast(`${result.errors} 个目录项无法读取。`, true); }
    catch (error) { fail(error); }
    finally { loading = false; refresh(); adapter.refresh(); }
  }
  for (const id of ['batch-files', 'batch-folder']) $<HTMLInputElement>(id).onchange = event => {
    const input = event.target as HTMLInputElement;
    void add(Array.from(input.files || []).map(file => ({ file, path: file.webkitRelativePath || file.name }))); input.value = '';
  };
  panel.ondragover = event => { if (!event.dataTransfer?.types.includes('Files')) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = locked() || adapter.busy() ? 'none' : 'copy'; panel.classList.add('drag-over'); };
  panel.ondragleave = event => { if (!panel.contains(event.relatedTarget as Node)) panel.classList.remove('drag-over'); };
  panel.ondrop = event => { event.preventDefault(); event.stopPropagation(); panel.classList.remove('drag-over'); if (event.dataTransfer) void drop(event.dataTransfer); };
  async function preview(item: BatchItem, inspect = false) {
    if (locked() || adapter.busy()) return;
    try {
      if (!review) commitDraft();
      loading = true; adapter.refresh(); refresh();
      const settings = copySettings(item.settings || shared);
      if (inspect && item.result) settings.region = { ...item.result.extraction.region };
      await adapter.open(item, settings);
      current = item; review = inspect;
      setScope(item.settings ? 'episode' : 'shared');
      $('batch-preview-name').textContent = item.file.name;
      apply(settings); layout();
    } catch (error) {
      // Opening a source resets the colour controls. Restore the outgoing draft
      // if decoding fails, so the next job keeps its configured filter.
      apply(scopeValue === 'episode' && current?.settings ? current.settings : shared);
      fail(error);
    }
    finally { loading = false; render(); adapter.refresh(); }
  }
  $('batch-list').onchange = event => { const input = event.target as HTMLInputElement; const item = items.find(i => i.id === input.closest<HTMLElement>('.batch-row')?.dataset.id); if (item && !locked()) { item.selected = input.checked; refresh(); } };
  $('batch-list').onclick = event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]'); if (!target || locked() || adapter.busy()) return;
    const item = items.find(i => i.id === target.closest<HTMLElement>('.batch-row')?.dataset.id); if (!item) return;
    const action = target.dataset.action;
    if (action === 'preview' || action === 'review') { void preview(item, action === 'review'); return; }
    if (action === 'remove') remove([item]);
    if (action === 'retry') { item.status = 'waiting'; item.selected = true; }
    if (action === 'up' || action === 'down') { const index = items.indexOf(item), next = index + (action === 'up' ? -1 : 1); if (next >= 0 && next < items.length) [items[index], items[next]] = [items[next], items[index]]; }
    render();
  };
  function remove(targets: BatchItem[]) {
    if (targets.some(i => i.result) && !confirm('移除会丢弃这些剧集的页面内结果，请先保存或下载字幕。继续？')) return;
    if (targets.includes(current!)) { try { commitDraft(); } catch (error) { fail(error); return; } current = undefined; adapter.release(); $('batch-preview-name').textContent = '共用设置'; setScope('shared'); apply(shared); }
    for (let index = items.length - 1; index >= 0; index--) if (targets.includes(items[index])) items.splice(index, 1);
    render(); adapter.refresh();
  }
  $('batch-select-all').onchange = () => { items.forEach(i => i.selected = $<HTMLInputElement>('batch-select-all').checked); render(); };
  $('batch-sort').onclick = () => { items.sort((a, b) => naturalOrder.compare(a.path, b.path)); render(); };
  $('batch-remove').onclick = () => remove(items.filter(i => i.selected));
  $('batch-clear-done').onclick = () => remove(items.filter(i => i.status === 'completed'));
  $('batch-retry').onclick = () => { items.filter(i => ['failed', 'partial'].includes(i.status)).forEach(i => { i.status = 'waiting'; i.selected = true; }); render(); };
  $<HTMLSelectElement>('batch-scope').onchange = () => {
    try {
      const incoming = $<HTMLSelectElement>('batch-scope').value;
      commitDraft();
      if (incoming === 'episode' && current) current.settings ||= copySettings(shared);
      setScope(incoming); apply(incoming === 'episode' && current ? current.settings! : shared); render();
    } catch (error) { setScope(scopeValue); fail(error); }
  };
  $('batch-use-shared').onclick = () => {
    if (!current) return;
    try { if (scopeValue === 'shared') commitDraft(); current.settings = undefined; setScope('shared'); apply(shared); render(); }
    catch (error) { fail(error); }
  };
  $('batch-apply-all').onclick = () => {
    try { if (items.some(i => i.settings) && !confirm('用当前设置覆盖全部单集设置？已有字幕结果不会重新识别。')) return; shared = draft(); items.forEach(i => i.settings = undefined); setScope('shared'); render(); adapter.toast('当前设置已应用到全部待处理剧集。'); } catch (error) { fail(error); }
  };
  async function changeMode(value: boolean) {
    if (enabled === value || locked() || adapter.busy()) return;
    try { if (enabled) commitDraft(); else if (!entered) shared = copySettings(adapter.capture()); switching = true; adapter.refresh(); refresh(); await adapter.mode(value); enabled = value; if (value) entered = true; review = false; current = undefined; $('batch-preview-name').textContent = '共用设置'; setScope('shared'); if (value) apply(shared); layout(); }
    catch (error) { fail(error); }
    finally { switching = false; refresh(); adapter.refresh(); }
  }
  $('single-mode').onclick = () => void changeMode(false); $('batch-mode').onclick = () => void changeMode(true);
  $('batch-back').onclick = () => { review = false; setScope(current?.settings ? 'episode' : 'shared'); apply(current?.settings || shared); layout(); };
  const picker = (window as Window & { showDirectoryPicker?: (options: { mode: string }) => Promise<OutputDirectory> }).showDirectoryPicker;
  if (!picker) { $('batch-directory').hidden = true; $('batch-output-status').textContent = '此浏览器不支持直接保存目录；完成后下载字幕 ZIP。'; }
  $('batch-directory').onclick = async () => {
    if (!picker) return;
    try {
      exporting = true; adapter.refresh(); refresh();
      const directory = await picker.call(window, { mode: 'readwrite' });
      const next = new BatchDirectoryWriter(directory); await next.prepare(); writer = next; items.forEach(i => i.outputNames.clear());
      $('batch-output-status').textContent = `输出至 ${directory.name} · 每集结束自动保存；已有同名文件会添加序号。`;
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) fail(error); }
    finally { exporting = false; refresh(); adapter.refresh(); }
  };
  panel.querySelectorAll<HTMLInputElement>('[data-batch-format]').forEach(input => input.onchange = refresh);
  $('batch-start').onclick = async () => {
    try {
      commitDraft(); const selected = items.filter(i => i.selected && i.status === 'waiting'), outputFormats = formats();
      if (!selected.length || !outputFormats.length || !adapter.ready() || adapter.busy()) return;
      loading = true; adapter.refresh(); refresh();
      if (writer?.directory.requestPermission && await writer.directory.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('没有输出目录写入权限，请重新选择目录或下载 ZIP。');
      loading = false;
      await runner.run(selected, shared, async (item, settings, signal) => {
        current = item; $('batch-preview-name').textContent = item.file.name; setScope(item.settings ? 'episode' : 'shared');
        if (!adapter.ready()) { runner.pause(); throw new Error('模型已停止，请重新加载后重试。'); }
        await adapter.open(item, settings, signal); apply(settings); render();
        try { return await adapter.execute(signal, (value, detail) => { item.progress = value; item.detail = detail; if (performance.now() - lastPaint > 500) { lastPaint = performance.now(); updateProgress(item); } }); }
        finally { if (!adapter.ready()) runner.pause(); }
      }, async item => { if (writer) await writer.save(item, outputFormats); }, () => { render(); adapter.refresh(); });
    } catch (error) { fail(error); }
    finally { loading = false; if (current) { setScope(current.settings ? 'episode' : 'shared'); apply(current.settings || shared); } render(); adapter.refresh(); }
  };
  $('batch-pause').onclick = () => { runner.pause(); render(); }; $('batch-stop').onclick = () => { runner.stop(); $('batch-status').textContent = '正在停止，保留已识别结果…'; };
  $('batch-save').onclick = async () => {
    if (!writer) return; exporting = true; adapter.refresh(); refresh();
    try { for (const item of items.filter(i => i.result)) { try { await writer.save(item, formats()); } catch (error) { item.outputError = error instanceof Error ? error.message : String(error); } } adapter.toast('保存结束，请检查队列中的保存状态。'); }
    finally { exporting = false; render(); adapter.refresh(); }
  };
  $('batch-download').onclick = () => {
    try {
      const used = new Set<string>(), entries: { name: string; text: string }[] = []; let bytes = 22; const encoder = new TextEncoder();
      for (const item of items) if (item.result) for (const format of formats()) {
        const name = availableName(exportStem(item.file.name) + (item.result.extraction.complete ? '' : ' (未完成)'), format, used), text = subtitleContents(item.result, format);
        bytes += encoder.encode(text).length + encoder.encode(name).length * 2 + 76;
        if (bytes > 96 * 1024 * 1024) throw new Error('字幕包超过 96 MB，请分批导出或选择输出目录。');
        entries.push({ name, text });
      }
      if (!entries.length) return;
      const url = URL.createObjectURL(subtitleZip(entries)), link = document.createElement('a'); link.href = url; link.download = 'subtitles.zip'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
      adapter.toast(`已打包 ${entries.length} 个字幕文件。`);
    } catch (error) { fail(error); }
  };
  render();
  return { refresh, drop, get enabled() { return enabled; }, get locked() { return locked(); }, get running() { return runner.running; }, get hasResults() { return items.some(i => i.result); } };
}
