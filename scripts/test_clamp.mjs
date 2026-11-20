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

async function run() {
  const input = fs.readFileSync('cyberpunk_original.jpg');
  const meta = await sharp(input).metadata();
  const { width, height } = meta;

  const { data: rawPixels } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8ClampedArray(rawPixels.buffer);

  let N = 2;
  while (N < Math.max(width, height)) N <<= 1;

  const re = new Float64Array(N * N);
  const im = new Float64Array(N * N);
  const Y_orig = new Float64Array(width * height);

  for (let y = 0; y < N; y++) {
    const srcY = y < height ? y : (height - 1) - ((y - height) % height);
    for (let x = 0; x < N; x++) {
      const srcX = x < width ? x : (width - 1) - ((x - width) % width);
      const pIdx = (srcY * width + srcX) * 4;
      const yVal = 0.299 * pixels[pIdx] + 0.587 * pixels[pIdx + 1] + 0.114 * pixels[pIdx + 2];
      if (y < height && x < width) Y_orig[y * width + x] = yVal;
      re[y * N + x] = yVal;
    }
  }

  fft2d(re, im, N, false);

  // Exact 1a5c4d3 band: 16 to 32 pixels
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

  for (const maxDelta of [2.5, 4.0, 6.0]) {
    const outPixels = new Uint8ClampedArray(pixels.length);
    outPixels.set(pixels);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pIdx = (y * width + x) * 4;
        const yIdx = y * width + x;
        const rawDelta = re[y * N + x] - Y_orig[yIdx];

        // Tanh soft clamp
        const deltaY = maxDelta * Math.tanh(rawDelta / maxDelta);

        outPixels[pIdx] = Math.min(255, Math.max(0, Math.round(pixels[pIdx] + deltaY)));
        outPixels[pIdx + 1] = Math.min(255, Math.max(0, Math.round(pixels[pIdx + 1] + deltaY)));
        outPixels[pIdx + 2] = Math.min(255, Math.max(0, Math.round(pixels[pIdx + 2] + deltaY)));
      }
    }

    let buf = await sharp(Buffer.from(outPixels.buffer), { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();

    // 1a5c4d3 step 4: median(3) + squeeze (0.972 x 0.962)
    buf = await sharp(buf)
      .median(3)
      .resize(Math.round(width * 0.972), Math.round(height * 0.962), { kernel: sharp.kernel.cubic, fit: 'fill' })
      .resize(width, height, { kernel: sharp.kernel.cubic, fit: 'fill' })
      .jpeg({ quality: 76, mozjpeg: true, chromaSubsampling: '4:2:0' })
      .toBuffer();

    const outName = `test_clamped_d${maxDelta}.jpg`;
    fs.writeFileSync(outName, buf);
    console.log(`Written ${outName}, size: ${(buf.length / 1024).toFixed(1)} KB`);
  }
}
run();
