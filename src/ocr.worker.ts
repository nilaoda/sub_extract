import * as ort from 'onnxruntime-web/webgpu';
import { decodeCTC, restoreVisualSpaces, filterUnsupportedEdgeTokens, clamp, mergeTextBoxes, type OcrLine, type Region } from './core';

let detector: ort.InferenceSession | undefined;
let recognizer: ort.InferenceSession | undefined;
let dictionary: string[] = [];
let device: GPUDevice | undefined;
let normalizer: GPUComputePipeline | undefined;
let backend = 'wasm';
const canvas = new OffscreenCanvas(1, 1);
const context = canvas.getContext('2d', { willReadFrequently: true })!;

async function init(data: { wasm: ArrayBuffer; detector: ArrayBuffer; recognizer: ArrayBuffer; dictionary: string; backend: string }) {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmBinary = new Uint8Array(data.wasm);
  ort.env.logLevel = 'error';
  dictionary = ['', ...data.dictionary.replace(/^\uFEFF/, '').replace(/\r/g, '').trimEnd().split('\n'), ' '];
  if (dictionary.length < 10 || dictionary.length > 100_000) throw new Error('字符字典无效。需要 UTF-8 文本，每行一个字符，不含 blank，末尾空格由程序添加。');
  backend = data.backend;
  if (backend === 'webgpu') {
    if (!self.navigator.gpu) throw new Error('当前浏览器没有 WebGPU，请选择 WASM 或切换桌面 Chrome / Edge。');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('无法获取 GPU，请选择 WASM。');
    device = await adapter.requestDevice({ requiredFeatures: adapter.features.has('shader-f16') ? ['shader-f16'] : [], requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize } });
    ort.env.webgpu.device = device;
    normalizer = device.createComputePipeline({
      layout: 'auto', compute: { entryPoint: 'main', module: device.createShaderModule({ code: `
        @group(0) @binding(0) var image: texture_2d<f32>;
        @group(0) @binding(1) var<storage, read_write> output: array<f32>;
        @group(0) @binding(2) var<uniform> params: vec4<u32>;
        @compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
          let size = textureDimensions(image);
          if (id.x >= size.x || id.y >= size.y) { return; }
          let rgb = textureLoad(image, vec2<i32>(id.xy), 0).bgr;
          var value = (rgb - vec3<f32>(0.5)) / vec3<f32>(0.5);
          if (params.x == 0u) { value = (rgb - vec3<f32>(0.485, 0.456, 0.406)) / vec3<f32>(0.229, 0.224, 0.225); }
          if (params.x == 1u && id.x >= params.y) { value = vec3<f32>(0.0); }
          let offset = id.y * size.x + id.x;
          let plane = size.x * size.y;
          output[offset] = value.x; output[plane + offset] = value.y; output[2u * plane + offset] = value.z;
        }
      ` }) },
    });
  }
  const options: ort.InferenceSession.SessionOptions = { executionProviders: device ? [{ name: 'webgpu', device }] : ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
  try {
    detector = await ort.InferenceSession.create(data.detector, options);
    recognizer = await ort.InferenceSession.create(data.recognizer, options);
    // Validate the dictionary before a long extraction, including models with dynamic metadata.
    const fake = new Float32Array(3 * 48 * 320);
    const input = new ort.Tensor('float32', fake, [1, 3, 48, 320]);
    const out = await recognizer.run({ [recognizer.inputNames[0]]: input });
    try { const value = out[recognizer.outputNames[0]]; decodeCTC(value.data as Float32Array, value.dims, dictionary); }
    finally { input.dispose(); Object.values(out).forEach(t => t.dispose()); }
  } catch (error) {
    await detector?.release(); await recognizer?.release(); detector = undefined; recognizer = undefined;
    throw new Error(`模型初始化失败：${error instanceof Error ? error.message : String(error)}。本地模型需要兼容 PP-OCRv4（识别输入高度 48、CTC 输出）及配套字典。`);
  }
  return { backend, dictionarySize: dictionary.length, gpu: device?.adapterInfo?.description || device?.adapterInfo?.vendor || '' };
}

async function inputTensor(width: number, height: number, recognition: boolean, contentWidth = width): Promise<ort.Tensor> {
  const plane = width * height;
  if (device && normalizer) {
    const image = await createImageBitmap(canvas);
    const texture = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    device.queue.copyExternalImageToTexture({ source: image }, { texture }, [width, height]); image.close();
    const buffer = device.createBuffer({ size: plane * 3 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(params, 0, new Uint32Array([Number(recognition), contentWidth, 0, 0]));
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(normalizer);
    pass.setBindGroup(0, device.createBindGroup({ layout: normalizer.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: { buffer } }, { binding: 2, resource: { buffer: params } }] }));
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16)); pass.end(); device.queue.submit([encoder.finish()]);
    return ort.Tensor.fromGpuBuffer(buffer, { dataType: 'float32', dims: [1, 3, height, width], dispose: () => { buffer.destroy(); texture.destroy(); params.destroy(); } });
  }
  const pixels = context.getImageData(0, 0, width, height).data, output = new Float32Array(plane * 3);
  const mean = recognition ? [0.5, 0.5, 0.5] : [0.485, 0.456, 0.406];
  const std = recognition ? [0.5, 0.5, 0.5] : [0.229, 0.224, 0.225];
  for (let y = 0; y < height; y++) for (let x = 0; x < contentWidth; x++) {
    const i = y * width + x;
    for (let c = 0; c < 3; c++) output[c * plane + i] = (pixels[i * 4 + 2 - c] / 255 - mean[c]) / std[c];
  }
  return new ort.Tensor('float32', output, [1, 3, height, width]);
}

function findBoxes(probabilities: Float32Array, width: number, height: number): Region[] {
  const visited = new Uint8Array(width * height), queue = new Int32Array(width * height), boxes: Region[] = [];
  for (let index = 0; index < visited.length; index++) {
    if (visited[index] || probabilities[index] < 0.3) continue;
    let head = 0, tail = 1, score = 0, count = 0;
    queue[0] = index; visited[index] = 1;
    let x0 = width, y0 = height, x1 = 0, y1 = 0;
    while (head < tail) {
      const current = queue[head++], x = current % width, y = Math.floor(current / width);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      score += probabilities[current]; count++;
      for (const neighbor of [x ? current - 1 : -1, x + 1 < width ? current + 1 : -1, y ? current - width : -1, y + 1 < height ? current + width : -1]) {
        if (neighbor >= 0 && !visited[neighbor] && probabilities[neighbor] >= 0.3) { visited[neighbor] = 1; queue[tail++] = neighbor; }
      }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (count < 6 || w < 3 || h < 2 || score / count < 0.55) continue;
    // DB's contour expansion, approximated for horizontal subtitle rectangles.
    const margin = Math.max(2, w * h * 1.6 / (2 * (w + h)));
    const left = clamp(x0 - margin, 0, width), top = clamp(y0 - margin, 0, height);
    boxes.push({ x: left / width, y: top / height, width: (clamp(x1 + margin + 1, 0, width) - left) / width, height: (clamp(y1 + margin + 1, 0, height) - top) / height });
  }
  return boxes.sort((a, b) => a.y - b.y || a.x - b.x).slice(0, 20);
}

async function recognize(bitmap: ImageBitmap, minConfidence: number) {
  if (!detector || !recognizer) throw new Error('请先加载模型。');
  // Keep more detail in 1080p outlined subtitles; aggressively downscaling the
  // strip can hide characters drawn over light clothing or hands.
  const started = performance.now(), scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(32, Math.round(bitmap.width * scale / 32) * 32), h = Math.max(32, Math.round(bitmap.height * scale / 32) * 32);
  canvas.width = w; canvas.height = h; context.drawImage(bitmap, 0, 0, w, h);
  const input = await inputTensor(w, h, false);
  let boxes: Region[];
  let out: ort.InferenceSession.OnnxValueMapType = {};
  try {
    out = await detector.run({ [detector.inputNames[0]]: input });
    const value = out[detector.outputNames[0]], dims = value.dims;
    if (dims.length !== 4 || dims[0] !== 1 || dims[1] !== 1) throw new Error('检测模型输出必须为 [1, 1, 高度, 宽度] 的 DB 概率图。');
    // The probability map has the crop's aspect ratio. Use pixel coordinates for
    // box geometry so horizontal spacing is comparable with text height.
    const mapWidth = dims[dims.length - 1], mapHeight = dims[dims.length - 2];
    boxes = mergeTextBoxes(findBoxes(value.data as Float32Array, mapWidth, mapHeight).map(b => ({ x: b.x * bitmap.width, y: b.y * bitmap.height, width: b.width * bitmap.width, height: b.height * bitmap.height })))
      .map(b => ({ x: b.x / bitmap.width, y: b.y / bitmap.height, width: b.width / bitmap.width, height: b.height / bitmap.height }));
  } finally { input.dispose(); Object.values(out).forEach(t => t.dispose()); }
  const lines: OcrLine[] = [];
  for (const detected of boxes) {
    // DB occasionally omits weak edge characters. Include horizontal context in
    // recognition, bounded by the selected region and other boxes on this row.
    let left = clamp(detected.x - detected.height * bitmap.height / bitmap.width * 0.35, 0, 1);
    let right = clamp(detected.x + detected.width + detected.height * bitmap.height / bitmap.width * 0.35, 0, 1);
    for (const neighbor of boxes) {
      if (neighbor === detected || Math.abs(neighbor.y + neighbor.height / 2 - detected.y - detected.height / 2) > Math.min(neighbor.height, detected.height) / 2) continue;
      if (neighbor.x + neighbor.width <= detected.x) left = Math.max(left, (neighbor.x + neighbor.width + detected.x) / 2);
      if (neighbor.x >= detected.x + detected.width) right = Math.min(right, (detected.x + detected.width + neighbor.x) / 2);
    }
    const box: Region = { ...detected, x: left, width: right - left };
    const contentWidth = Math.max(8, Math.min(2048, Math.ceil(48 * box.width * bitmap.width / (box.height * bitmap.height))));
    const width = Math.max(320, Math.ceil(contentWidth / 32) * 32);
    canvas.width = width; canvas.height = 48;
    context.fillStyle = '#808080'; context.fillRect(0, 0, width, 48);
    context.drawImage(bitmap, box.x * bitmap.width, box.y * bitmap.height, box.width * bitmap.width, box.height * bitmap.height, 0, 0, contentWidth, 48);
    const tensor = await inputTensor(width, 48, true, contentWidth);
    let results: ort.InferenceSession.OnnxValueMapType = {};
    try {
      results = await recognizer.run({ [recognizer.inputNames[0]]: tensor });
      const value = results[recognizer.outputNames[0]], decoded = decodeCTC(value.data as Float32Array, value.dims, dictionary);
      const pixels = context.getImageData(0, 0, width, 48).data;
      const tokens = filterUnsupportedEdgeTokens(decoded.tokens, pixels, width, 48, value.dims[1], contentWidth);
      const filteredText = tokens.map(token => token.text).join('').trim();
      const text = restoreVisualSpaces(filteredText, tokens, pixels, width, 48, value.dims[1], contentWidth);
      if (text && decoded.confidence >= minConfidence) lines.push({ text, confidence: decoded.confidence, box, spacingInferred: text !== filteredText, edgeFiltered: tokens.length !== decoded.tokens.length });
    } finally { tensor.dispose(); Object.values(results).forEach(t => t.dispose()); }
  }
  const rows: OcrLine[][] = [];
  for (const line of lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)) {
    const row = rows.find(r => Math.abs((r[0].box.y + r[0].box.height / 2) - (line.box.y + line.box.height / 2)) < Math.min(r[0].box.height, line.box.height) * 0.5);
    if (row) row.push(line); else rows.push([line]);
  }
  const text = rows.map(row => row.sort((a, b) => a.box.x - b.box.x).map(l => l.text).join(' ')).join('\n');
  return { text, confidence: lines.length ? lines.reduce((s, l) => s + l.confidence * l.text.length, 0) / lines.reduce((s, l) => s + l.text.length, 0) : 0, lines, elapsed: performance.now() - started };
}

self.onmessage = async (event: MessageEvent) => {
  const { id, type, data } = event.data;
  try {
    const result = type === 'init' ? await init(data) : await recognize(data.bitmap, data.minConfidence);
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
  finally { if (type === 'recognize') data.bitmap.close(); }
};
