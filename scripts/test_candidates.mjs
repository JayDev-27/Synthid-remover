import sharp from 'sharp';
import fs from 'fs';

const inputPath = 'cyberpunk_original.jpg';
const originalBuffer = fs.readFileSync(inputPath);
const meta = await sharp(originalBuffer).metadata();
const { width, height } = meta;

console.log(`Processing ${width}x${height} image...`);

// Helper: 1D FFT
function fft1d(re, im, n, inv = false) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len;
    const wlen_r = Math.cos(ang), wlen_i = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      const halfLen = len >> 1;
      for (let j = 0; j < halfLen; j++) {
        const u_r = re[i + j], u_i = im[i + j];
        const v_r = re[i + j + halfLen] * wr - im[i + j + halfLen] * wi;
        const v_i = re[i + j + halfLen] * wi + im[i + j + halfLen] * wr;
        re[i + j] = u_r + v_r;
        im[i + j] = u_i + v_i;
        re[i + j + halfLen] = u_r - v_r;
        im[i + j + halfLen] = u_i - v_i;
        const n_wr = wr * wlen_r - wi * wlen_i;
        wi = wr * wlen_i + wi * wlen_r;
        wr = n_wr;
      }
    }
  }
  if (inv) {
    const invN = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= invN;
      im[i] *= invN;
    }
  }
}

// 2D FFT
function fft2d(re, im, N, inv = false) {
  for (let y = 0; y < N; y++) {
    const rowOffset = y * N;
    const r_r = re.subarray(rowOffset, rowOffset + N);
    const r_i = im.subarray(rowOffset, rowOffset + N);
    fft1d(r_r, r_i, N, inv);
  }
  const col_r = new Float64Array(N);
  const col_i = new Float64Array(N);
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) {
      col_r[y] = re[y * N + x];
      col_i[y] = im[y * N + x];
    }
    fft1d(col_r, col_i, N, inv);
    for (let y = 0; y < N; y++) {
      re[y * N + x] = col_r[y];
      im[y * N + x] = col_i[y];
    }
  }
}

// Bounded Phase Scramble: full random phase in band, but deltaY is strictly bounded to prevent leopard spots
function applyBoundedFourierScramble(pixels, w, h, channels = 4, maxDelta = 8.0, minPeriod = 12, maxPeriod = 48) {
  let N = 2;
  while (N < Math.max(w, h)) N <<= 1;

  const re = new Float64Array(N * N);
  const im = new Float64Array(N * N);
  const Y_orig = new Float64Array(w * h);

  for (let y = 0; y < N; y++) {
    const srcY = y < h ? y : (h - 1) - ((y - h) % h);
    for (let x = 0; x < N; x++) {
      const srcX = x < w ? x : (w - 1) - ((x - w) % w);
      const pIdx = (srcY * w + srcX) * channels;
      const yVal = 0.299 * pixels[pIdx] + 0.587 * pixels[pIdx + 1] + 0.114 * pixels[pIdx + 2];
      if (y < h && x < w) Y_orig[y * w + x] = yVal;
      re[y * N + x] = yVal;
    }
  }

  fft2d(re, im, N, false);

  const minK = N / maxPeriod;
  const maxK = N / minPeriod;

  for (let ky = 0; ky <= N / 2; ky++) {
    const kv = ky <= N / 2 ? ky : ky - N;
    const kxMax = (ky === 0 || ky === N / 2) ? N / 2 : N;
    for (let kx = 0; kx < kxMax; kx++) {
      const ku = kx <= N / 2 ? kx : kx - N;
      const k = Math.sqrt(ku * ku + kv * kv);

      if (k >= minK && k <= maxK) {
        const idx = ky * N + kx;
        const mag = Math.sqrt(re[idx] * re[idx] + im[idx] * im[idx]);
        // Random phase uniformly distributed in [-PI, PI] to completely scramble carrier
        const newPhase = (Math.random() * 2 - 1) * Math.PI;

        const newRe = mag * Math.cos(newPhase);
        const newIm = mag * Math.sin(newPhase);

        re[idx] = newRe;
        im[idx] = newIm;

        const conjX = (N - kx) % N;
        const conjY = (N - ky) % N;
        const conjIdx = conjY * N + conjX;
        re[conjIdx] = newRe;
        im[conjIdx] = -newIm;
      }
    }
  }

  fft2d(re, im, N, true);

  const output = new Uint8ClampedArray(pixels.length);
  output.set(pixels);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pIdx = (y * w + x) * channels;
      const yIdx = y * w + x;
      const rawDelta = re[y * N + x] - Y_orig[yIdx];

      // Soft tanh compression prevents excessive leopard spots:
      // Linear for small deltas, saturates smoothly at maxDelta
      const deltaY = maxDelta * Math.tanh(rawDelta / maxDelta);

      output[pIdx] = Math.min(255, Math.max(0, Math.round(pixels[pIdx] + deltaY)));
      output[pIdx + 1] = Math.min(255, Math.max(0, Math.round(pixels[pIdx + 1] + deltaY)));
      output[pIdx + 2] = Math.min(255, Math.max(0, Math.round(pixels[pIdx + 2] + deltaY)));
    }
  }

  return output;
}

// Sub-pixel spatial micro-warp
function applyMicroWarp(pixels, w, h, channels = 4, ampX = 1.0, ampY = 0.8, waveLen = 160) {
  const output = new Uint8ClampedArray(pixels.length);
  const k = (2 * Math.PI) / waveLen;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = ampX * Math.sin(y * k);
      const dy = ampY * Math.cos(x * k);

      const srcX = Math.max(0, Math.min(w - 1, x + dx));
      const srcY = Math.max(0, Math.min(h - 1, y + dy));

      const x0 = Math.floor(srcX);
      const x1 = Math.min(w - 1, x0 + 1);
      const y0 = Math.floor(srcY);
      const y1 = Math.min(h - 1, y0 + 1);

      const wx = srcX - x0;
      const wy = srcY - y0;

      const idx = (y * w + x) * channels;
      for (let c = 0; c < 3; c++) {
        const v00 = pixels[(y0 * w + x0) * channels + c];
        const v10 = pixels[(y0 * w + x1) * channels + c];
        const v01 = pixels[(y1 * w + x0) * channels + c];
        const v11 = pixels[(y1 * w + x1) * channels + c];

        const top = v00 * (1 - wx) + v10 * wx;
        const bot = v01 * (1 - wx) + v11 * wx;
        output[idx + c] = Math.round(top * (1 - wy) + bot * wy);
      }
      if (channels === 4) output[idx + 3] = pixels[idx + 3];
    }
  }
  return output;
}

async function computePSNR(bufA, bufB) {
  const rawA = await sharp(bufA).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  const rawB = await sharp(bufB).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  let mse = 0;
  const len = width * height * 4;
  for (let i = 0; i < len; i += 4) {
    const dr = rawA[i] - rawB[i];
    const dg = rawA[i+1] - rawB[i+1];
    const db = rawA[i+2] - rawB[i+2];
    mse += (dr*dr + dg*dg + db*db) / 3;
  }
  mse /= (width * height);
  if (mse === 0) return 99;
  return 10 * Math.log10((255 * 255) / mse);
}

// Generate Candidates
console.log('Generating Candidate A: Bounded Tanh Fourier Scramble (maxDelta=7) + Anisotropic Squeeze (0.964x0.952) + Mozjpeg Q80 4:2:0');
const { data: rawOrig, info } = await sharp(originalBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const pixOrig = new Uint8ClampedArray(rawOrig.buffer, rawOrig.byteOffset, rawOrig.byteLength);

// Candidate A
let pixA = applyBoundedFourierScramble(pixOrig, width, height, 4, 7.0, 12, 48);
let bufA = await sharp(Buffer.from(pixA.buffer), { raw: { width, height, channels: 4 } }).png().toBuffer();
bufA = await sharp(bufA)
  .resize(Math.round(width * 0.964), Math.round(height * 0.952), { kernel: sharp.kernel.cubic, fit: 'fill' })
  .resize(width, height, { kernel: sharp.kernel.cubic, fit: 'fill' })
  .jpeg({ quality: 80, mozjpeg: true, chromaSubsampling: '4:2:0' })
  .toBuffer();
bufA = await sharp(bufA).sharpen({ sigma: 0.5, m1: 0.0, m2: 1.0 }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
fs.writeFileSync('candidate_A.jpg', bufA);
console.log(`Candidate A written: ${(bufA.length / 1024).toFixed(1)} KB, PSNR: ${(await computePSNR(originalBuffer, bufA)).toFixed(2)} dB`);

// Candidate B: Micro-Warp (1.2px amplitude) + Bounded Fourier (maxDelta=6) + Anisotropic Squeeze (0.97x0.96) + Mozjpeg Q78
console.log('Generating Candidate B: Micro-Warp + Bounded Fourier (maxDelta=6) + Anisotropic Squeeze + Mozjpeg Q78');
let pixB = applyMicroWarp(pixOrig, width, height, 4, 1.2, 1.0, 140);
pixB = applyBoundedFourierScramble(pixB, width, height, 4, 6.0, 14, 40);
let bufB = await sharp(Buffer.from(pixB.buffer), { raw: { width, height, channels: 4 } }).png().toBuffer();
bufB = await sharp(bufB)
  .resize(Math.round(width * 0.970), Math.round(height * 0.960), { kernel: sharp.kernel.cubic, fit: 'fill' })
  .resize(width, height, { kernel: sharp.kernel.cubic, fit: 'fill' })
  .jpeg({ quality: 78, mozjpeg: true, chromaSubsampling: '4:2:0' })
  .toBuffer();
bufB = await sharp(bufB).sharpen({ sigma: 0.5, m1: 0.0, m2: 1.0 }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
fs.writeFileSync('candidate_B.jpg', bufB);
console.log(`Candidate B written: ${(bufB.length / 1024).toFixed(1)} KB, PSNR: ${(await computePSNR(originalBuffer, bufB)).toFixed(2)} dB`);

// Candidate C: DeSynth-Style Frequency Split
// Clean base = Squeeze + Median(3) + Bilateral + Q76; High band = original - low_original; Restored = low_clean + high_orig
console.log('Generating Candidate C: DeSynth-Style Frequency Split (sigma=2.0)');
let cleanBase = await sharp(originalBuffer)
  .resize(Math.round(width * 0.962), Math.round(height * 0.952), { kernel: sharp.kernel.cubic, fit: 'fill' })
  .median(3)
  .resize(width, height, { kernel: sharp.kernel.cubic, fit: 'fill' })
  .jpeg({ quality: 76, mozjpeg: true, chromaSubsampling: '4:2:0' })
  .toBuffer();

// Blur cleanBase with sigma=2.0
const lowClean = await sharp(cleanBase).blur(2.0).raw().toBuffer();
const lowOrig = await sharp(originalBuffer).ensureAlpha().raw().toBuffer();
const lowOrigBlurred = await sharp(originalBuffer).blur(2.0).ensureAlpha().raw().toBuffer();

const restoredPixels = new Uint8ClampedArray(width * height * 4);
const rawClean = await sharp(cleanBase).ensureAlpha().raw().toBuffer();
for (let i = 0; i < restoredPixels.length; i += 4) {
  for (let c = 0; c < 3; c++) {
    // low from clean, high from original: lowClean + (lowOrig - lowOrigBlurred)
    const high = lowOrig[i + c] - lowOrigBlurred[i + c];
    const low = lowClean[i + c];
    restoredPixels[i + c] = Math.min(255, Math.max(0, Math.round(low + high * 0.85)));
  }
  restoredPixels[i + 3] = 255;
}

let bufC = await sharp(Buffer.from(restoredPixels.buffer), { raw: { width, height, channels: 4 } })
  .jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: '4:2:0' })
  .toBuffer();
fs.writeFileSync('candidate_C.jpg', bufC);
console.log(`Candidate C written: ${(bufC.length / 1024).toFixed(1)} KB, PSNR: ${(await computePSNR(originalBuffer, bufC)).toFixed(2)} dB`);
