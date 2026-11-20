import sharp from 'sharp';
import fs from 'fs';

const inputPath = 'cyberpunk_original.jpg';
const originalBuffer = fs.readFileSync(inputPath);
const meta = await sharp(originalBuffer).metadata();
const { width, height } = meta;

console.log(`Testing with 0.6px micro-warp added to cleanBase...`);

const origRgb = await sharp(originalBuffer).toColourspace('srgb').raw().toBuffer();

// Sobel edge mask
const gray = new Float32Array(width * height);
for (let i = 0, j = 0; i < origRgb.length; i += 3, j++) {
  gray[j] = 0.299 * origRgb[i] + 0.587 * origRgb[i + 1] + 0.114 * origRgb[i + 2];
}

const edgeMask = new Float32Array(width * height);
for (let y = 1; y < height - 1; y++) {
  for (let x = 1; x < width - 1; x++) {
    const idx = y * width + x;
    const gx = -gray[idx - width - 1] + gray[idx - width + 1]
             - 2 * gray[idx - 1] + 2 * gray[idx + 1]
             - gray[idx + width - 1] + gray[idx + width + 1];
    const gy = -gray[idx - width - 1] - 2 * gray[idx - width] - gray[idx - width + 1]
             + gray[idx + width - 1] + 2 * gray[idx + width] + gray[idx + width + 1];
    edgeMask[idx] = Math.sqrt(gx * gx + gy * gy);
  }
}
const sortedEdges = Float32Array.from(edgeMask).sort();
const p99 = sortedEdges[Math.floor(sortedEdges.length * 0.99)] || 1.0;
for (let i = 0; i < edgeMask.length; i++) {
  edgeMask[i] = Math.min(1.0, edgeMask[i] / p99);
}

// 0.6px micro-warp on origRgb
function applyMicroWarpRgb(pixels, w, h, amp = 0.6, waveLen = 160) {
  const output = new Uint8ClampedArray(pixels.length);
  const k = (2 * Math.PI) / waveLen;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = amp * Math.sin(y * k);
      const dy = amp * Math.cos(x * k);

      const srcX = Math.max(0, Math.min(w - 1, x + dx));
      const srcY = Math.max(0, Math.min(h - 1, y + dy));

      const x0 = Math.floor(srcX);
      const x1 = Math.min(w - 1, x0 + 1);
      const y0 = Math.floor(srcY);
      const y1 = Math.min(h - 1, y0 + 1);

      const wx = srcX - x0;
      const wy = srcY - y0;

      const idx = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        const v00 = pixels[(y0 * w + x0) * 3 + c];
        const v10 = pixels[(y0 * w + x1) * 3 + c];
        const v01 = pixels[(y1 * w + x0) * 3 + c];
        const v11 = pixels[(y1 * w + x1) * 3 + c];

        const top = v00 * (1 - wx) + v10 * wx;
        const bot = v01 * (1 - wx) + v11 * wx;
        output[idx + c] = Math.round(top * (1 - wy) + bot * wy);
      }
    }
  }
  return output;
}

const warpedPixels = applyMicroWarpRgb(origRgb, width, height, 0.6, 160);

// Bilateral smoothing
const sigmaR = 18;
const lut = new Float32Array(768);
const denom = 2 * sigmaR * sigmaR;
for (let d = 0; d < 768; d++) lut[d] = Math.exp(-(d * d) / denom);

const bilateralPixels = new Uint8ClampedArray(warpedPixels.length);
for (let y = 1; y < height - 1; y++) {
  for (let x = 1; x < width - 1; x++) {
    const idx = (y * width + x) * 3;
    const r = warpedPixels[idx], g = warpedPixels[idx + 1], b = warpedPixels[idx + 2];
    let sumR = 0, sumG = 0, sumB = 0, totalW = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nIdx = ((y + dy) * width + (x + dx)) * 3;
        const nr = warpedPixels[nIdx], ng = warpedPixels[nIdx + 1], nb = warpedPixels[nIdx + 2];
        const diff = Math.abs(r - nr) + Math.abs(g - ng) + Math.abs(b - nb);
        const w = lut[diff];
        sumR += nr * w; sumG += ng * w; sumB += nb * w; totalW += w;
      }
    }
    const invW = 1.0 / totalW;
    bilateralPixels[idx] = Math.round(sumR * invW);
    bilateralPixels[idx + 1] = Math.round(sumG * invW);
    bilateralPixels[idx + 2] = Math.round(sumB * invW);
  }
}

let cleanBaseBuffer = await sharp(Buffer.from(bilateralPixels.buffer), { raw: { width, height, channels: 3 } })
  .resize(Math.round(width * 0.954), Math.round(height * 0.942), { kernel: sharp.kernel.cubic, fit: 'fill' })
  .median(3)
  .resize(width, height, { kernel: sharp.kernel.cubic, fit: 'fill' })
  .jpeg({ quality: 74, mozjpeg: true, chromaSubsampling: '4:2:0' })
  .toBuffer();

const sigmaSafe = 2.1;
const sigmaEdge = 1.2;

const cleanLowSafe = await sharp(cleanBaseBuffer).blur(sigmaSafe).toColourspace('srgb').raw().toBuffer();
const cleanLowEdge = await sharp(cleanBaseBuffer).blur(sigmaEdge).toColourspace('srgb').raw().toBuffer();

const origLowSafe = await sharp(originalBuffer).blur(sigmaSafe).toColourspace('srgb').raw().toBuffer();
const origLowEdge = await sharp(originalBuffer).blur(sigmaEdge).toColourspace('srgb').raw().toBuffer();

const outRgb = new Uint8Array(width * height * 3);

for (let p = 0; p < width * height; p++) {
  const m = edgeMask[p];
  const i = p * 3;

  for (let c = 0; c < 3; c++) {
    const highEdge = origRgb[i + c] - origLowEdge[i + c];
    const valEdge = cleanLowEdge[i + c] + highEdge;

    const highSafe = origRgb[i + c] - origLowSafe[i + c];
    const valSafe = cleanLowSafe[i + c] + highSafe * 0.40;

    const blended = m * valEdge + (1.0 - m) * valSafe;
    outRgb[i + c] = Math.min(255, Math.max(0, Math.round(blended)));
  }
}

const finalBuffer = await sharp(Buffer.from(outRgb.buffer), { raw: { width, height, channels: 3 } })
  .jpeg({ quality: 85, mozjpeg: true, chromaSubsampling: '4:2:0' })
  .toBuffer();

fs.writeFileSync('cyberpunk_cleaned_warped_edge.jpg', finalBuffer);

let mse = 0;
const finalRgb = await sharp(finalBuffer).toColourspace('srgb').raw().toBuffer();
for (let i = 0; i < outRgb.length; i++) {
  const d = origRgb[i] - finalRgb[i];
  mse += d * d;
}
mse /= outRgb.length;
const psnr = 10 * Math.log10((255 * 255) / mse);

console.log(`Warped edge output written: ${(finalBuffer.length / 1024).toFixed(1)} KB, PSNR: ${psnr.toFixed(2)} dB`);
