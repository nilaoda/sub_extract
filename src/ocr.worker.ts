import * as ort from 'onnxruntime-web/webgpu';
import { detectTextBoxes } from './text-detection';
import { decodeCTC, restoreVisualSpaces, filterUnsupportedEdgeTokens, outlinedTextProjection, clamp, type OcrLine, type Region } from './core';
import type { OcrTimings } from './performance';
import { CompatibleBatchRunner, groupOcrJobs, OCR_WINDOW_FRAMES, OCR_WINDOW_BYTES } from './ocr-batch';
import type { OcrBatchCounts, OcrWindowOptions, OcrWindowResult } from './ocr';
import { FrameReuse, FrameSignatureReader } from './frame-change';

let detector: ort.InferenceSession | undefined;
let recognizer: ort.InferenceSession | undefined;
let dictionary: string[] = [];
let device: GPUDevice | undefined;
let normalizer: GPUComputePipeline | undefined;
let backend = 'wasm';
let profiling = false;
let detectorBatch = new CompatibleBatchRunner(false);
let recognizerBatch = new CompatibleBatchRunner(false);
const canvas = new OffscreenCanvas(1, 1);
const context = canvas.getContext('2d', { willReadFrequently: true })!;

async function init(data: { wasm: ArrayBuffer; detector: ArrayBuffer; recognizer: ArrayBuffer; dictionary: string; backend: string; profile?: boolean }) {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmBinary = new Uint8Array(data.wasm);
  ort.env.logLevel = 'error';
  dictionary = ['', ...data.dictionary.replace(/^\uFEFF/, '').replace(/\r/g, '').trimEnd().split('\n'), ' '];
  if (dictionary.length < 10 || dictionary.length > 100_000) throw new Error('字符字典无效。需要 UTF-8 文本，每行一个字符，不含 blank，末尾空格由程序添加。');
  backend = data.backend;
  profiling = Boolean(data.profile);
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
  const options: ort.InferenceSession.SessionOptions = { executionProviders: device ? [{ name: 'webgpu', device }] : ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3,
    // Diagnostics separate dispatch from waiting/downloading. The download wait
    // also includes outstanding GPU work; it is not pure transfer time.
    ...(profiling && device ? { preferredOutputLocation: 'gpu-buffer' as const } : {}),
  };
  try {
    detector = await ort.InferenceSession.create(data.detector, options);
    recognizer = await ort.InferenceSession.create(data.recognizer, options);
    // The bundled PP-OCR exports advertise batch=1 yet run batch=2 correctly.
    // Validate with inference; metadata alone cannot establish compatibility.
    detectorBatch = new CompatibleBatchRunner(backend === 'webgpu');
    recognizerBatch = new CompatibleBatchRunner(backend === 'webgpu');
    // Validate the dictionary before a long extraction, including models with dynamic metadata.
    const fake = new Float32Array(3 * 48 * 320);
    const input = new ort.Tensor('float32', fake, [1, 3, 48, 320]);
    let out: ort.InferenceSession.OnnxValueMapType = {};
    try {
      out = await recognizer.run({ [recognizer.inputNames[0]]: input });
      const value = out[recognizer.outputNames[0]];
      decodeCTC(await value.getData() as Float32Array, value.dims, dictionary);
    }
    finally { input.dispose(); Object.values(out).forEach(t => t.dispose()); }
  } catch (error) {
    await detector?.release(); await recognizer?.release(); detector = undefined; recognizer = undefined;
    throw new Error(`模型初始化失败：${error instanceof Error ? error.message : String(error)}。本地模型需要兼容 PP-OCR（DB 检测、识别输入高度 48、CTC 输出）及识别模型配套字典。`);
  }
  return { backend, dictionarySize: dictionary.length, gpu: device?.adapterInfo?.description || device?.adapterInfo?.vendor || '' };
}

async function inputTensor(width: number, height: number, recognition: boolean, contentWidth = width): Promise<ort.Tensor> {
  const plane = width * height;
  if (device && normalizer) {
    const image = await createImageBitmap(canvas);
    let texture: GPUTexture | undefined, buffer: GPUBuffer | undefined, params: GPUBuffer | undefined;
    const destroy = () => { buffer?.destroy(); texture?.destroy(); params?.destroy(); };
    try {
      texture = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      device.queue.copyExternalImageToTexture({ source: image }, { texture }, [width, height]);
      buffer = device.createBuffer({ size: plane * 3 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(params, 0, new Uint32Array([Number(recognition), contentWidth, 0, 0]));
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(normalizer);
      pass.setBindGroup(0, device.createBindGroup({ layout: normalizer.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: { buffer } }, { binding: 2, resource: { buffer: params } }] }));
      pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16)); pass.end(); device.queue.submit([encoder.finish()]);
      return ort.Tensor.fromGpuBuffer(buffer, { dataType: 'float32', dims: [1, 3, height, width], dispose: destroy });
    } catch (error) { destroy(); throw error; }
    finally { image.close(); }
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

function edgePixels(bitmap: ImageBitmap, width: number, height: number, enabled: boolean) {
  if (!enabled) return;
  canvas.width = width; canvas.height = height;
  context.drawImage(bitmap, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
}

async function recognize(bitmap: ImageBitmap, minConfidence: number, ignoreClippedText = false) {
  if (!detector || !recognizer) throw new Error('请先加载模型。');
  // Keep more detail in 1080p outlined subtitles; aggressively downscaling the
  // strip can hide characters drawn over light clothing or hands.
  const started = performance.now(), scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height));
  const timings: OcrTimings | undefined = profiling ? { detectorPrepareMs: 0, detectorRunMs: 0, detectorOutputMs: 0, detectorPostMs: 0, recognizerPrepareMs: 0, recognizerRunMs: 0, recognizerOutputMs: 0, ctcMs: 0, visualPostMs: 0, outputBytes: 0, boxes: 0 } : undefined;
  const w = Math.max(32, Math.round(bitmap.width * scale / 32) * 32), h = Math.max(32, Math.round(bitmap.height * scale / 32) * 32);
  canvas.width = w; canvas.height = h; context.drawImage(bitmap, 0, 0, w, h);
  const input = await inputTensor(w, h, false);
  if (timings) timings.detectorPrepareMs = performance.now() - started;
  let boxes: Region[];
  let ignoredTextBoxes = 0;
  let out: ort.InferenceSession.OnnxValueMapType = {};
  try {
    const runStarted = profiling ? performance.now() : 0;
    out = await detector.run({ [detector.inputNames[0]]: input });
    if (timings) timings.detectorRunMs = performance.now() - runStarted;
    const value = out[detector.outputNames[0]], dims = value.dims;
    if (dims.length !== 4 || dims[0] !== 1 || dims[1] !== 1) throw new Error('检测模型输出必须为 [1, 1, 高度, 宽度] 的 DB 概率图。');
    // The probability map has the crop's aspect ratio. Use pixel coordinates for
    // box geometry so horizontal spacing is comparable with text height.
    const mapWidth = dims[dims.length - 1], mapHeight = dims[dims.length - 2];
    const outputStarted = profiling ? performance.now() : 0;
    const probabilities = profiling ? await value.getData() as Float32Array : value.data as Float32Array;
    if (timings) { timings.detectorOutputMs = performance.now() - outputStarted; timings.outputBytes += probabilities.byteLength; }
    const postStarted = profiling ? performance.now() : 0;
    ({ boxes, ignoredTextBoxes } = detectTextBoxes(probabilities, mapWidth, mapHeight, bitmap.width, bitmap.height, ignoreClippedText, edgePixels(bitmap, mapWidth, mapHeight, ignoreClippedText)));
    if (timings) { timings.detectorPostMs = performance.now() - postStarted; timings.boxes = boxes.length; }
  } finally { input.dispose(); Object.values(out).forEach(t => t.dispose()); }
  const lines: OcrLine[] = [];
  for (const detected of boxes) {
    const prepareStarted = profiling ? performance.now() : 0;
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
    if (timings) timings.recognizerPrepareMs += performance.now() - prepareStarted;
    let results: ort.InferenceSession.OnnxValueMapType = {};
    try {
      const runStarted = profiling ? performance.now() : 0;
      results = await recognizer.run({ [recognizer.inputNames[0]]: tensor });
      if (timings) timings.recognizerRunMs += performance.now() - runStarted;
      const value = results[recognizer.outputNames[0]], outputStarted = profiling ? performance.now() : 0;
      const probabilities = profiling ? await value.getData() as Float32Array : value.data as Float32Array;
      if (timings) { timings.recognizerOutputMs += performance.now() - outputStarted; timings.outputBytes += probabilities.byteLength; }
      const ctcStarted = profiling ? performance.now() : 0;
      const decoded = decodeCTC(probabilities, value.dims, dictionary);
      if (timings) timings.ctcMs += performance.now() - ctcStarted;
      const visualStarted = profiling ? performance.now() : 0;
      const pixels = context.getImageData(0, 0, width, 48).data;
      // Share this crop's projection only when a visual check actually needs it.
      let projection: ReturnType<typeof outlinedTextProjection> | undefined;
      const getProjection = () => projection ||= outlinedTextProjection(pixels, width, 48, contentWidth);
      const tokens = filterUnsupportedEdgeTokens(decoded.tokens, pixels, width, 48, value.dims[1], contentWidth, getProjection);
      const filteredText = tokens.map(token => token.text).join('').trim();
      const text = restoreVisualSpaces(filteredText, tokens, pixels, width, 48, value.dims[1], contentWidth, getProjection);
      if (timings) timings.visualPostMs += performance.now() - visualStarted;
      if (text && decoded.confidence >= minConfidence) lines.push({ text, confidence: decoded.confidence, box, spacingInferred: text !== filteredText, edgeFiltered: tokens.length !== decoded.tokens.length });
    } finally { tensor.dispose(); Object.values(results).forEach(t => t.dispose()); }
  }
  return { ...assembleLines(lines), ignoredTextBoxes, elapsed: performance.now() - started, counts: { detectorCalls: 1, detectorBatch2: 0, recognizerCalls: boxes.length, recognizerBatch2: 0 }, ...(timings ? { timings } : {}) };
}

function assembleLines(lines: OcrLine[]) {
  const rows: OcrLine[][] = [];
  for (const line of lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)) {
    const row = rows.find(r => Math.abs((r[0].box.y + r[0].box.height / 2) - (line.box.y + line.box.height / 2)) < Math.min(r[0].box.height, line.box.height) * 0.5);
    if (row) row.push(line); else rows.push([line]);
  }
  const text = rows.map(row => row.sort((a, b) => a.box.x - b.box.x).map(l => l.text).join(' ')).join('\n');
  return { text, confidence: lines.length ? lines.reduce((s, l) => s + l.confidence * l.text.length, 0) / lines.reduce((s, l) => s + l.text.length, 0) : 0, lines };
}

interface CropJob { width: number; height: number; index: number; box?: Region; contentWidth?: number }
interface JobOutput { probabilities: Float32Array; dims: readonly number[]; pixels?: Uint8ClampedArray }

async function joinInputs(inputs: ort.Tensor[], width: number, height: number) {
  if (inputs.length === 1) return inputs[0];
  if (!device) throw new Error('批量推理需要 WebGPU。');
  const bytes = width * height * 3 * 4;
  const buffer = device.createBuffer({ size: bytes * inputs.length, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  try {
    const encoder = device.createCommandEncoder();
    inputs.forEach((input, i) => encoder.copyBufferToBuffer(input.gpuBuffer, 0, buffer, i * bytes, bytes));
    device.queue.submit([encoder.finish()]);
    return ort.Tensor.fromGpuBuffer(buffer, { dataType: 'float32', dims: [inputs.length, 3, height, width], dispose: () => buffer.destroy() });
  } catch (error) { buffer.destroy(); throw error; }
}

async function recognizeWindow(bitmaps: ImageBitmap[], minConfidence: number, batch = true, ignoreClippedText = false) {
  if (!detector || !recognizer) throw new Error('请先加载模型。');
  if (!bitmaps.length || bitmaps.length > OCR_WINDOW_FRAMES) throw new Error('每次最多处理 8 张裁图。');
  const bytes = bitmaps.reduce((sum, bitmap) => sum + bitmap.width * bitmap.height * 4, 0);
  if (bitmaps.length > 1 && bytes > OCR_WINDOW_BYTES) throw new Error('裁图暂存量超过限制。');
  const started = performance.now();
  const counts: OcrBatchCounts = { detectorCalls: 0, detectorBatch2: 0, recognizerCalls: 0, recognizerBatch2: 0 };
  const timings: OcrTimings | undefined = profiling ? { detectorPrepareMs: 0, detectorRunMs: 0, detectorOutputMs: 0, detectorPostMs: 0, recognizerPrepareMs: 0, recognizerRunMs: 0, recognizerOutputMs: 0, ctcMs: 0, visualPostMs: 0, outputBytes: 0, boxes: 0 } : undefined;
  const ignoredTextBoxes = bitmaps.map(() => 0);
  const boxes: Region[][] = bitmaps.map(() => []), lines: OcrLine[][] = bitmaps.map(() => []);

  // Prepare only the current pair. Recognition jobs store geometry, not tensors
  // or pixel buffers, so many detected boxes cannot accumulate GPU inputs.
  const infer = async (model: ort.InferenceSession, jobs: readonly CropJob[], recognition: boolean): Promise<JobOutput[]> => {
    const inputs: ort.Tensor[] = [], pixels: (Uint8ClampedArray | undefined)[] = [];
    let input: ort.Tensor | undefined, outputs: ort.InferenceSession.OnnxValueMapType = {};
    const phase = recognition ? 'recognizer' : 'detector';
    try {
      const prepareStarted = performance.now();
      for (const job of jobs) {
        const bitmap = bitmaps[job.index];
        canvas.width = job.width; canvas.height = job.height;
        if (recognition) {
          const box = job.box!;
          context.fillStyle = '#808080'; context.fillRect(0, 0, job.width, job.height);
          context.drawImage(bitmap, box.x * bitmap.width, box.y * bitmap.height, box.width * bitmap.width, box.height * bitmap.height, 0, 0, job.contentWidth!, 48);
          pixels.push(context.getImageData(0, 0, job.width, 48).data);
        } else {
          context.drawImage(bitmap, 0, 0, job.width, job.height); pixels.push(undefined);
        }
        inputs.push(await inputTensor(job.width, job.height, recognition, job.contentWidth ?? job.width));
      }
      input = await joinInputs(inputs, jobs[0].width, jobs[0].height);
      if (timings) timings[`${phase}PrepareMs`] += performance.now() - prepareStarted;
      const runStarted = performance.now();
      counts[`${phase}Calls`]++;
      if (jobs.length === 2) counts[`${phase}Batch2`]++;
      outputs = await model.run({ [model.inputNames[0]]: input });
      if (timings) timings[`${phase}RunMs`] += performance.now() - runStarted;
      const value = outputs[model.outputNames[0]], dims = value.dims;
      if (dims[0] !== jobs.length || (recognition ? dims.length !== 3 : dims.length !== 4 || dims[1] !== 1)) {
        throw new Error(recognition ? '识别输出必须为 [N, T, C]。' : '检测输出必须为 [N, 1, H, W]。');
      }
      const outputStarted = performance.now();
      const probabilities = await value.getData() as Float32Array;
      if (timings) { timings[`${phase}OutputMs`] += performance.now() - outputStarted; timings.outputBytes += probabilities.byteLength; }
      const stride = probabilities.length / jobs.length;
      return jobs.map((_, i) => ({ probabilities: probabilities.subarray(i * stride, (i + 1) * stride), dims: [1, ...dims.slice(1)], pixels: pixels[i] }));
    } finally {
      Object.values(outputs).forEach(value => value.dispose());
      if (input && !inputs.includes(input)) input.dispose();
      inputs.forEach(value => value.dispose());
    }
  };

  const detectJobs = bitmaps.map((bitmap, index): CropJob => {
    const scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height));
    return { index, width: Math.max(32, Math.round(bitmap.width * scale / 32) * 32), height: Math.max(32, Math.round(bitmap.height * scale / 32) * 32) };
  });
  for (const group of groupOcrJobs(detectJobs, batch ? 2 : 1)) {
    // Large selections can greatly increase activation memory. Run them singly.
    const groups = group[0].width * group[0].height > 512 * 1024 ? group.map(job => [job]) : [group];
    for (const jobs of groups) {
      const values = await detectorBatch.run(jobs, batch => infer(detector!, batch, false));
      const postStarted = performance.now();
      jobs.forEach((job, i) => {
        const bitmap = bitmaps[job.index], value = values[i];
        const detected = detectTextBoxes(value.probabilities, value.dims[3], value.dims[2], bitmap.width, bitmap.height, ignoreClippedText, edgePixels(bitmap, value.dims[3], value.dims[2], ignoreClippedText));
        boxes[job.index] = detected.boxes; ignoredTextBoxes[job.index] = detected.ignoredTextBoxes;
        if (timings) timings.boxes += boxes[job.index].length;
      });
      if (timings) timings.detectorPostMs += performance.now() - postStarted;
    }
  }
  const recognitionJobs: CropJob[] = [];
  bitmaps.forEach((bitmap, index) => {
    for (const detected of boxes[index]) {
      let left = clamp(detected.x - detected.height * bitmap.height / bitmap.width * 0.35, 0, 1);
      let right = clamp(detected.x + detected.width + detected.height * bitmap.height / bitmap.width * 0.35, 0, 1);
      for (const neighbor of boxes[index]) {
        if (neighbor === detected || Math.abs(neighbor.y + neighbor.height / 2 - detected.y - detected.height / 2) > Math.min(neighbor.height, detected.height) / 2) continue;
        if (neighbor.x + neighbor.width <= detected.x) left = Math.max(left, (neighbor.x + neighbor.width + detected.x) / 2);
        if (neighbor.x >= detected.x + detected.width) right = Math.min(right, (detected.x + detected.width + neighbor.x) / 2);
      }
      const box = { ...detected, x: left, width: right - left };
      const contentWidth = Math.max(8, Math.min(2048, Math.ceil(48 * box.width * bitmap.width / (box.height * bitmap.height))));
      recognitionJobs.push({ index, box, contentWidth, width: Math.max(320, Math.ceil(contentWidth / 32) * 32), height: 48 });
    }
  });
  for (const jobs of groupOcrJobs(recognitionJobs, batch ? 2 : 1)) {
    const values = await recognizerBatch.run(jobs, batch => infer(recognizer!, batch, true));
    jobs.forEach((job, i) => {
      const value = values[i], ctcStarted = performance.now();
      const decoded = decodeCTC(value.probabilities, value.dims, dictionary);
      if (timings) timings.ctcMs += performance.now() - ctcStarted;
      const visualStarted = performance.now(), pixels = value.pixels!;
      let projection: ReturnType<typeof outlinedTextProjection> | undefined;
      const getProjection = () => projection ||= outlinedTextProjection(pixels, job.width, 48, job.contentWidth!);
      const tokens = filterUnsupportedEdgeTokens(decoded.tokens, pixels, job.width, 48, value.dims[1], job.contentWidth!, getProjection);
      const filteredText = tokens.map(token => token.text).join('').trim();
      const text = restoreVisualSpaces(filteredText, tokens, pixels, job.width, 48, value.dims[1], job.contentWidth!, getProjection);
      if (timings) timings.visualPostMs += performance.now() - visualStarted;
      if (text && decoded.confidence >= minConfidence) lines[job.index].push({ text, confidence: decoded.confidence, box: job.box!, spacingInferred: text !== filteredText, edgeFiltered: tokens.length !== decoded.tokens.length });
    });
  }
  return { values: lines.map((value, index) => ({ ...assembleLines(value), ignoredTextBoxes: ignoredTextBoxes[index] })), elapsed: performance.now() - started, counts, fallback: !detectorBatch.enabled || !recognizerBatch.enabled, ...(timings ? { timings } : {}) };
}

const frameReuse = new FrameReuse();
let signatureReader: FrameSignatureReader | undefined;
async function recognizeChangedWindow(data: { bitmaps: ImageBitmap[]; minConfidence: number } & OcrWindowOptions): Promise<OcrWindowResult> {
  const { bitmaps, minConfidence } = data;
  if (!data.deduplicate) return { ...await recognizeWindow(bitmaps, minConfidence, data.batch, data.ignoreClippedText), reusedFrames: 0, ocrFrames: bitmaps.length };
  if (!bitmaps.length || bitmaps.length > OCR_WINDOW_FRAMES || (bitmaps.length > 1 && bitmaps.reduce((sum, bitmap) => sum + bitmap.width * bitmap.height * 4, 0) > OCR_WINDOW_BYTES)) throw new Error('裁图暂存量超过限制。');
  if (!data.scope || !data.times) throw new Error('画面去重需要任务标识和采样时间。');
  const started = performance.now();
  signatureReader ||= new FrameSignatureReader();
  const signatures = bitmaps.map(bitmap => signatureReader!.read(bitmap));
  const signatureMs = performance.now() - started;
  frameReuse.reset(`${data.scope}:clip=${Boolean(data.ignoreClippedText)}:confidence=${minConfidence}`);
  const counts: OcrBatchCounts = { detectorCalls: 0, detectorBatch2: 0, recognizerCalls: 0, recognizerBatch2: 0 };
  let timings: OcrTimings | undefined, fallback = false, ocrFrames = 0;
  const result = await frameReuse.recognize(signatures, data.times, async indices => {
    const result = await recognizeWindow(indices.map(index => bitmaps[index]), minConfidence, data.batch, data.ignoreClippedText);
    ocrFrames += indices.length; fallback ||= result.fallback;
    for (const key of Object.keys(counts) as (keyof OcrBatchCounts)[]) counts[key] += result.counts[key];
    if (result.timings) {
      if (!timings) timings = { ...result.timings };
      else for (const key of Object.keys(timings) as (keyof OcrTimings)[]) timings[key] += result.timings[key];
    }
    return result.values;
  });
  return { ...result, ocrFrames, signatureMs, counts, fallback, elapsed: performance.now() - started, ...(timings ? { timings } : {}) };
}

// The shared canvas and sessions require serialized requests, including init.
let tasks = Promise.resolve();
self.onmessage = (event: MessageEvent) => {
  const { id, type, data } = event.data;
  tasks = tasks.then(async () => {
    try {
      const result = type === 'init' ? await init(data) : type === 'window' ? await recognizeChangedWindow(data) : await recognize(data.bitmap, data.minConfidence, data.ignoreClippedText);
      self.postMessage({ id, result });
    } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
    finally {
      if (type === 'recognize') data.bitmap.close();
      if (type === 'window') data.bitmaps.forEach((bitmap: ImageBitmap) => bitmap.close());
    }
  });
};
