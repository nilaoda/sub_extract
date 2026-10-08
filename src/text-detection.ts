import { clamp, mergeTextBoxes, type Region } from './core';

function findCandidates(probabilities: Float32Array, width: number, height: number, pixels?: Uint8ClampedArray) {
  const visited = new Uint8Array(width * height), queue = new Int32Array(width * height), boxes: (Region & { clipped: boolean })[] = [];
  let strokes: ReturnType<typeof clippedLightStrokes> | undefined;
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
    let clipped = y0 <= 1 || y1 >= height - 2;
    // DB may detect only an interior fragment of a cropped glyph. Check original
    // light strokes near the edge too; middle-of-strip text is never rejected
    // just because a light background happens to connect to the crop border.
    const center = (y0 + y1) / 2;
    if (!clipped && pixels && (center < height * .4 || center > height * .6)) {
      strokes ||= clippedLightStrokes(pixels, width, height);
      for (let y = y0; y <= y1 && !clipped; y++) for (let x = x0; x <= x1 && !clipped; x++) {
        const edge = strokes.edges[strokes.labels[y * width + x]];
        clipped = center < height * .4 ? Boolean(edge & 1) : Boolean(edge & 2);
      }
    }
    boxes.push({ clipped, x: left / width, y: top / height, width: (clamp(x1 + margin + 1, 0, width) - left) / width, height: (clamp(y1 + margin + 1, 0, height) - top) / height });
  }
  return boxes.sort((a, b) => a.y - b.y || a.x - b.x).slice(0, 20);
}

/** Filter the raw DB contour, not the expanded crop: padding alone may touch
 * the edge of an otherwise intact subtitle. Merge first to reject the whole
 * detected line when one of its components is clipped. */
export function detectTextBoxes(probabilities: Float32Array, width: number, height: number,
  cropWidth: number, cropHeight: number, ignoreClippedText = false, pixels?: Uint8ClampedArray) {
  const candidates = findCandidates(probabilities, width, height, ignoreClippedText ? pixels : undefined);
  const scaled = candidates.map(b => ({ x: b.x * cropWidth, y: b.y * cropHeight, width: b.width * cropWidth, height: b.height * cropHeight }));
  const merged = mergeTextBoxes(scaled);
  let ignoredTextBoxes = 0;
  const boxes = merged.filter(box => {
    const clipped = ignoreClippedText && candidates.some((candidate, index) => {
      if (!candidate.clipped) return false;
      const part = scaled[index], epsilon = 1e-6;
      return part.x >= box.x - epsilon && part.y >= box.y - epsilon
        && part.x + part.width <= box.x + box.width + epsilon && part.y + part.height <= box.y + box.height + epsilon;
    });
    if (clipped) ignoredTextBoxes++;
    return !clipped;
  }).map(b => ({ x: b.x / cropWidth, y: b.y / cropHeight, width: b.width / cropWidth, height: b.height / cropHeight }));
  return { boxes, ignoredTextBoxes };
}

/** A small crop-local flood fill, only allocated for an enabled edge check.
 * It complements DB geometry for pale glyphs whose remaining strokes can be
 * disconnected in the probability map. Labels let us require actual shared
 * pixels instead of the bounding rectangle of a background object. */
function clippedLightStrokes(pixels: Uint8ClampedArray, width: number, height: number) {
  const labels = new Int32Array(width * height), queue = new Int32Array(labels.length), edges = [0];
  const light = (index: number) => {
    const i = index * 4, high = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
    return pixels[i + 3] !== 0 && high >= 180 && high - Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) <= 75;
  };
  for (let index = 0; index < labels.length; index++) {
    if (labels[index] || !light(index)) continue;
    const id = edges.length;
    let head = 0, tail = 1, edge = 0, x0 = width, x1 = 0, y0 = height, y1 = 0;
    queue[0] = index; labels[index] = id;
    while (head < tail) {
      const current = queue[head++], x = current % width, y = Math.floor(current / width);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      if (y <= 1) edge |= 1;
      if (y >= height - 2) edge |= 2;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (!labels[next] && light(next)) { labels[next] = id; queue[tail++] = next; }
      }
    }
    edges.push(tail >= 8 && x1 - x0 >= 2 && y1 - y0 >= 2 ? edge : 0);
  }
  return { labels, edges };
}
