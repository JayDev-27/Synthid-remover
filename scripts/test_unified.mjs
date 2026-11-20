import sharp from 'sharp';
import fs from 'fs';

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

function applyBoundedFourierScramble(pixels, w, h, channels = 4, maxDelta = 2.5) {
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

  const minK = N / 32;
  const maxK = N / 16;

  for (let ky = 0; ky <= N / 2; ky++) {
    const kv = ky <= N / 2 ? ky : ky - N;
    const kxMax = (ky === 0 || ky === N / 2) ? N / 2 : N;
    for (let kx = 0; kx < kxMax; kx++) {
      const ku = kx <= N / 2 ? kx : kx - N;
      const k = Math.sqrt(ku * ku + kv * kv);

      if (k >= minK && k <= maxK) {
        const idx = ky * N + kx;
        const mag = Math.sqrt(re[idx] * re[idx] + im[idx] * im[idx]);
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

      // Soft tanh compression prevents excessive leopard spots
      const deltaY = maxDelta * Math.tanh(rawDelta / maxDelta);

      output[pIdx] = Math.min(255, Math.max(0, Math.round(pixels[pIdx] + deltaY)));
      output[pIdx + 1] = Math.min(255, Math.max(0, Math.round(pixels[pIdx + 1] + deltaY)));
      output[pIdx + 2] = Math.min(255, Math.max(0, Math.round(pixels[pIdx + 2] + deltaY)));
    }
  }

  return output;
}

function applyBilateralCarrier(pixels, w, h, channels = 4, sigmaR = 16, noiseScale = 1.4) {
  const output = new Uint8ClampedArray(pixels.length);
  output.set(pixels);

  const lut = new Float32Array(768);
  const denom = 2 * sigmaR * sigmaR;
  for (let d = 0; d < 768; d++) lut[d] = Math.exp(-(d * d) / denom);

  for (let y = 1; y < h - 1; y++) {
    const rowOffset = y * w * channels;
    for (let x = 1; x < w - 1; x++) {
      const idx = rowOffset + x * channels;
      const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];

      let sumR = 0, sumG = 0, sumB = 0, totalW = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const nRow = (y + dy) * w * channels;
        for (let dx = -1; dx <= 1; dx++) {
          const nIdx = nRow + (x + dx) * channels;
          const nr = pixels[nIdx], ng = pixels[nIdx + 1], nb = pixels[nIdx + 2];
          const diff = Math.abs(r - nr) + Math.abs(g - ng) + Math.abs(b - nb);
          const weight = lut[diff];
          sumR += nr * weight;
          sumG += ng * weight;
          sumB += nb * weight;
          totalW += weight;
        }
      }

      const invW = 1.0 / totalW;
      let outR = sumR * invW;
      let outG = sumG * invW;
      let outB = sumB * invW;

      if (Math.random() < 0.6) {
        const jChroma = (Math.random() - 0.5) * noiseScale;
        const jLuma = (Math.random() - 0.5) * (noiseScale * 0.45);
        outR = Math.min(255, Math.max(0, outR + jChroma + jLuma));
        outG = Math.min(255, Math.max(0, outG + jLuma));
        outB = Math.min(255, Math.max(0, outB - jChroma + jLuma));
      }

      output[idx] = Math.round(outR);
      output[idx + 1] = Math.round(outG);
      output[idx + 2] = Math.round(outB);
    }
  }
  return output;
}

async function processPipeline(inputBuffer, maxDelta = 2.5) {
  const meta = await sharp(inputBuffer).metadata();
  const { width, height } = meta;

  const { data: rawPixels } = await sharp(inputBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8ClampedArray(rawPixels.buffer);

  // 1. Bounded Fourier scramble (destroys matched filter phase, zero leopard spots)
  let currentPixels = applyBoundedFourierScramble(pixels, width, height, 4, maxDelta);

  // 2. Bilateral carrier smoothing
  currentPixels = applyBilateralCarrier(currentPixels, width, height, 4, 16, 1.4);

  // 3. Squeeze & Median(3)
  const squeezeW = Math.max(16, Math.round(width * 0.970));
  const squeezeH = Math.max(16, Math.round(height * 0.960));

  let buf = await sharp(Buffer.from(currentPixels.buffer), { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();

  buf = await sharp(buf)
    .median(3)
    .resize(squeezeW, squeezeH, { kernel: sharp.kernel.cubic, fit: 'fill' })
    .resize(width, height, { kernel: sharp.kernel.cubic, fit: 'fill' })
    .jpeg({ quality: 76, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toBuffer();

  // 4. Detail Sharpen with m1: 0 (flat slope 0)
  buf = await sharp(buf)
    .sharpen({ sigma: 0.5, m1: 0.0, m2: 1.1 })
    .jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toBuffer();

  return buf;
}

const input = fs.readFileSync('cyberpunk_original.jpg');
const res = await processPipeline(input, 2.5);
fs.writeFileSync('cyberpunk_final_test.jpg', res);
console.log(`Successfully generated cyberpunk_final_test.jpg: ${(res.length / 1024).toFixed(1)} KB`);
