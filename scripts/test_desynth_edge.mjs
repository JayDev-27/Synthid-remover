import sharp from 'sharp';
import fs from 'fs';

const inputPath = 'cyberpunk_original.jpg';
const originalBuffer = fs.readFileSync(inputPath);
const meta = await sharp(originalBuffer).metadata();
const { width, height } = meta;

console.log(`Testing Enhanced Edge-Aware DeSynth Frequency Split on ${width}x${height}...`);

const origRgb = await sharp(originalBuffer).toColourspace('srgb').raw().toBuffer();

// Step 1: Compute Sobel gradient magnitude on original image to identify edges vs flat regions
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

// Compute 99th percentile for edge normalization
const sortedEdges = Float32Array.from(edgeMask).sort();
const p99 = sortedEdges[Math.floor(sortedEdges.length * 0.99)] || 1.0;
console.log(`Edge magnitude 99th percentile: ${p99.toFixed(1)}`);

for (let i = 0; i < edgeMask.length; i++) {
  edgeMask[i] = Math.min(1.0, edgeMask[i] / p99);
}

// Step 2: Create Clean Base Image
// 1. Bilateral carrier smoothing (LUT-based)
// 2. Anisotropic coordinate desynchronization (0.958 x 0.946)
// 3. Median(3) order-statistic filter
// 4. Mozjpeg Q74 with 4:2:0 subsampling
const sigmaR = 18;
const lut = new Float32Array(768);
const denom = 2 * sigmaR * sigmaR;
for (let d = 0; d < 768; d++) lut[d] = Math.exp(-(d * d) / denom);

const bilateralPixels = new Uint8ClampedArray(origRgb.length);
for (let y = 1; y < height - 1; y++) {
  for (let x = 1; x < width - 1; x++) {
    const idx = (y * width + x) * 3;
    const r = origRgb[idx], g = origRgb[idx + 1], b = origRgb[idx + 2];
    let sumR = 0, sumG = 0, sumB = 0, totalW = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nIdx = ((y + dy) * width + (x + dx)) * 3;
        const nr = origRgb[nIdx], ng = origRgb[nIdx + 1], nb = origRgb[nIdx + 2];
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
  .resize(Math.round(width * 0.958), Math.round(height * 0.946), { kernel: sharp.kernel.cubic, fit: 'fill' })
  .median(3)
  .resize(width, height, { kernel: sharp.kernel.cubic, fit: 'fill' })
  .jpeg({ quality: 74, mozjpeg: true, chromaSubsampling: '4:2:0' })
  .toBuffer();

// Step 3: Dual-Sigma Edge-Aware Frequency Recombination
// High frequencies in flat areas are heavily attenuated (where carrier hides in smooth sky/water),
// while high frequencies at real edges are 100% restored.
const sigmaSafe = 2.1; // for flat areas
const sigmaEdge = 1.2; // for edges

const cleanLowSafe = await sharp(cleanBaseBuffer).blur(sigmaSafe).toColourspace('srgb').raw().toBuffer();
const cleanLowEdge = await sharp(cleanBaseBuffer).blur(sigmaEdge).toColourspace('srgb').raw().toBuffer();

const origLowSafe = await sharp(originalBuffer).blur(sigmaSafe).toColourspace('srgb').raw().toBuffer();
const origLowEdge = await sharp(originalBuffer).blur(sigmaEdge).toColourspace('srgb').raw().toBuffer();

const outRgb = new Uint8Array(width * height * 3);

for (let p = 0; p < width * height; p++) {
  const m = edgeMask[p]; // 0 = flat, 1 = sharp edge
  const i = p * 3;

  for (let c = 0; c < 3; c++) {
    // Edge path: sigma = 1.2
    const highEdge = origRgb[i + c] - origLowEdge[i + c];
    const valEdge = cleanLowEdge[i + c] + highEdge;

    // Safe path: sigma = 2.1
    const highSafe = origRgb[i + c] - origLowSafe[i + c];
    // In flat areas, attenuate residual high-frequency noise by 60%
    const valSafe = cleanLowSafe[i + c] + highSafe * 0.40;

    // Blend by edge magnitude
    const blended = m * valEdge + (1.0 - m) * valSafe;
    outRgb[i + c] = Math.min(255, Math.max(0, Math.round(blended)));
  }
}

// Final lossy save with Mozjpeg Q85
const finalBuffer = await sharp(Buffer.from(outRgb.buffer), { raw: { width, height, channels: 3 } })
  .jpeg({ quality: 85, mozjpeg: true, chromaSubsampling: '4:2:0' })
  .toBuffer();

fs.writeFileSync('cyberpunk_cleaned_edge_aware.jpg', finalBuffer);

// Compute PSNR
let mse = 0;
const finalRgb = await sharp(finalBuffer).toColourspace('srgb').raw().toBuffer();
for (let i = 0; i < outRgb.length; i++) {
  const d = origRgb[i] - finalRgb[i];
  mse += d * d;
}
mse /= outRgb.length;
const psnr = 10 * Math.log10((255 * 255) / mse);

console.log(`Edge-aware output written: ${(finalBuffer.length / 1024).toFixed(1)} KB, PSNR: ${psnr.toFixed(2)} dB`);
