export const MODEL_NAME = 'PP-OCRv4 · 中英文';
const modelRoot = 'https://huggingface.co/OleehyO/paddleocrv4.onnx/resolve/da2c446aa67d75f1d5dac725772e8b68d1b53bf0/';
export const MODEL_FILES = [
  { key: 'detector', name: '文字检测', url: modelRoot + 'ch_PP-OCRv4_det.onnx', sha: 'c255248806ccdf52d6af1e45e362e6b27dcb770c6e2b92707459ee9a20f54587' },
  { key: 'recognizer', name: '文字识别', url: modelRoot + 'ch_PP-OCRv4_rec.onnx', sha: '8cd07d8689f3a0ba58741c97eea1bc4964bc60f005ef1802ba54c8cd4abd28c3' },
  { key: 'dictionary', name: '字符字典', url: 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/8cce9b6fd7ccb50226d0c38f94054d81c29b8184/ppocr/utils/ppocr_keys_v1.txt', sha: '28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7' },
] as const;
export interface ModelData { detector: ArrayBuffer; recognizer: ArrayBuffer; dictionary: string }

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('sub-extract-models', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function getCached(key: string): Promise<ArrayBuffer | undefined> {
  try {
    const db = await database();
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('files', 'readonly'), request = transaction.objectStore('files').get(key);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      transaction.oncomplete = () => db.close(); transaction.onabort = () => db.close();
    });
  } catch { return undefined; }
}
async function putCached(key: string, bytes: ArrayBuffer) {
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('files', 'readwrite'); transaction.objectStore('files').put(bytes, key);
      transaction.oncomplete = () => { db.close(); resolve(); }; transaction.onerror = () => { db.close(); reject(transaction.error); };
    });
  } catch { /* Private mode / quota failure must not prevent using downloaded models. */ }
}
export async function hasCachedModels(): Promise<boolean> {
  try {
    const db = await database();
    try {
      const transaction = db.transaction('files', 'readonly'), files = transaction.objectStore('files');
      const counts = await Promise.all(MODEL_FILES.map(spec => new Promise<number>((resolve, reject) => {
        const request = files.count(spec.sha);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      })));
      return counts.every(count => count > 0);
    } finally { db.close(); }
  } catch { return false; }
}
export async function clearModelCache() {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('files', 'readwrite'); transaction.objectStore('files').clear();
    transaction.oncomplete = () => { db.close(); resolve(); }; transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}
async function sha256(bytes: ArrayBuffer) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function downloadModels(signal: AbortSignal, progress: (message: string) => void): Promise<ModelData> {
  const loaded: Record<string, ArrayBuffer> = {};
  for (const spec of MODEL_FILES) {
    signal.throwIfAborted();
    let bytes = await getCached(spec.sha);
    if (bytes && await sha256(bytes) === spec.sha) progress(`已读取缓存 · ${spec.name}`);
    else {
      progress(`下载 ${spec.name}…`);
      const response = await fetch(spec.url, { signal });
      if (!response.ok) throw new Error(`${spec.name}下载失败（HTTP ${response.status}）。可下载模型文件后手动选择。`);
      const reader = response.body?.getReader();
      if (!reader) bytes = await response.arrayBuffer();
      else {
        const parts: Uint8Array[] = []; let size = 0, previousUpdate = 0;
        const total = Number(response.headers.get('content-length'));
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; parts.push(value);
          if (size > 100_000_000) { await reader.cancel(); throw new Error('模型文件超过允许大小。'); }
          if (performance.now() - previousUpdate > 150) { progress(`下载 ${spec.name} · ${(size / 1048576).toFixed(1)}${total ? ' / ' + (total / 1048576).toFixed(1) : ''} MB`); previousUpdate = performance.now(); }
        }
        const joined = new Uint8Array(size); let offset = 0;
        for (const part of parts) { joined.set(part, offset); offset += part.length; } bytes = joined.buffer;
      }
      if (await sha256(bytes) !== spec.sha) throw new Error(`${spec.name}的文件校验失败，请重新下载。`);
      await putCached(spec.sha, bytes);
    }
    loaded[spec.key] = bytes;
  }
  return { detector: loaded.detector, recognizer: loaded.recognizer, dictionary: new TextDecoder().decode(loaded.dictionary) };
}
export async function localModels(detector?: File, recognizer?: File, dictionary?: File): Promise<ModelData> {
  if (!detector || !recognizer || !dictionary) throw new Error('请分别选择检测模型、识别模型和字符字典。');
  if (detector.size > 200_000_000 || recognizer.size > 200_000_000 || dictionary.size > 2_000_000) throw new Error('本地模型文件过大。请使用轻量 PP-OCRv4 模型。');
  return { detector: await detector.arrayBuffer(), recognizer: await recognizer.arrayBuffer(), dictionary: await dictionary.text() };
}
