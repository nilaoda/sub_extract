import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { MODEL_FILES } from '../src/models';

const video = process.argv[2];
if (!video) throw new Error('用法：npm run test:prepare -- /absolute/path/to/reference-video.mp4');
await stat(video);
await mkdir('.local-test/models', { recursive: true });
const names = { detector: 'det.onnx', recognizer: 'rec.onnx', dictionary: 'dict.txt' };
for (const item of MODEL_FILES) {
  const target = `.local-test/models/${names[item.key]}`;
  let bytes: Uint8Array | undefined;
  try { bytes = await readFile(target); } catch { /* Download below. */ }
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha) {
    console.log(`下载 ${item.name}…`);
    const response = await fetch(item.url, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`${item.name}: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== item.sha) throw new Error(`${item.name}校验失败。`);
    await writeFile(target, bytes);
  }
  console.log(`${target}: SHA-256 verified`);
}
await new Promise<void>((resolve, reject) => {
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '603', '-i', video, '-t', '42', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an', '-movflags', '+faststart', '.local-test/sample-603-645.mp4'], { stdio: 'inherit' });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
});
console.log('测试素材已准备，所有视频和模型都保存在忽略目录 .local-test/。');
