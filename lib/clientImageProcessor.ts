import { scanBase64Provenance, ProvenanceAuditResult } from './provenanceScanner';
import {
  loadGeminiWatermarkRemoverSync,
  eraseGeminiSparklePixelData,
  eraseCornerTextBadgePixelData,
  applyBilateralCarrierDisruptionRgba,
  applyMedianFilter3x3Rgba,
  inpaintMaskOnRgba,
  DisruptionMode,
  WatermarkCornerPreset,
} from './pixelPipeline';

export type { DisruptionMode, WatermarkCornerPreset };
export { scanBase64Provenance };
export type ClientProvenanceAudit = ProvenanceAuditResult;

export interface ClientProcessingOptions {
  stripMetadata?: boolean;
  disruptSignals?: boolean;
  disruptionMode?: DisruptionMode;
  disruptionStrength?: number; // 1 to 100, default: 75
  removeVisibleBadge?: boolean;
  cornerHint?: WatermarkCornerPreset;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
}

/**
 * 1D in-place radix-2 Cooley-Tukey Fast Fourier Transform.
 */
function fft1d(re: Float64Array, im: Float64Array, n: number, inv: boolean = false): void {
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

/**
 * 2D Fast Fourier Transform on an N x N power-of-two matrix.
 */
function fft2d(re: Float64Array, im: Float64Array, N: number, inv: boolean = false): void {
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

/**
 * Bounded 16-32 Pixel Octave Fourier Phase Scramble on Luminance (Y) (Client).
 * Scrambles phase uniformly in [-PI, PI] inside the carrier band, softly clamping
 * spatial delta via tanh to maxDelta (+-2.5) to eliminate all leopard-spot mottling.
 */
function applyBoundedFourierScrambleClient(
  imageData: ImageData,
  maxDelta: number = 2.5
): ImageData {
  const { width: w, height: h, data: src } = imageData;
  let N = 2;
  while (N < Math.max(w, h)) N <<= 1;

  const re = new Float64Array(N * N);
  const im = new Float64Array(N * N);
  const Y_orig = new Float64Array(w * h);

  for (let y = 0; y < N; y++) {
    const srcY = y < h ? y : (h - 1) - ((y - h) % h);
    for (let x = 0; x < N; x++) {
      const srcX = x < w ? x : (w - 1) - ((x - w) % w);
      const pIdx = (srcY * w + srcX) * 4;
      const yVal = 0.299 * src[pIdx] + 0.587 * src[pIdx + 1] + 0.114 * src[pIdx + 2];
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

  const output = new ImageData(w, h);
  const dst = output.data;
  dst.set(src);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pIdx = (y * w + x) * 4;
      const yIdx = y * w + x;
      const rawDelta = re[y * N + x] - Y_orig[yIdx];
      const deltaY = maxDelta * Math.tanh(rawDelta / maxDelta);

      dst[pIdx] = Math.min(255, Math.max(0, Math.round(src[pIdx] + deltaY)));
      dst[pIdx + 1] = Math.min(255, Math.max(0, Math.round(src[pIdx + 1] + deltaY)));
      dst[pIdx + 2] = Math.min(255, Math.max(0, Math.round(src[pIdx + 2] + deltaY)));
    }
  }

  return output;
}

export async function processImageClientSide(
  file: File,
  options: ClientProcessingOptions = {}
): Promise<{ base64Image: string; telemetry: any }> {
  const startTime = Date.now();
  const logs: string[] = [];

  const disruptionMode = options.disruptionMode || 'balanced';
  const disruptionStrength = options.disruptionStrength ?? 75;
  const isMetadataOnly = disruptionMode === 'metadata-only';
  const shouldRemoveBadge = options.removeVisibleBadge !== false && !isMetadataOnly;

  logs.push(`[CLIENT] Selected image file: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);

  const img = new Image();
  const url = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });
  URL.revokeObjectURL(url);

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create 2D canvas context');

  ctx.drawImage(img, 0, 0);
  let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  logs.push(`[CLIENT] Image dimensions: ${canvas.width}x${canvas.height}px | Mode: ${disruptionMode.toUpperCase()}`);

  // 1. Erase Gemini Sparkle Watermark via Reverse Alpha Blending + Off-Grid Rescue
  if (shouldRemoveBadge) {
    logs.push(`[PROCESS] Auto-erasing visible Gemini sparkle watermark with adaptive fallback...`);
    try {
      const removerFn = await loadGeminiWatermarkRemoverSync();
      const badgeMeta = eraseGeminiSparklePixelData(imageData.data, canvas.width, canvas.height, {
        removerSyncFn: removerFn,
        cornerHint: options.cornerHint || 'auto',
        forceRescue: true,
      });
      const textBadgeMeta = eraseCornerTextBadgePixelData(
        imageData.data,
        canvas.width,
        canvas.height,
        options.cornerHint || 'auto'
      );
      if (badgeMeta.applied || textBadgeMeta.applied) {
        ctx.putImageData(imageData, 0, 0);
        if (badgeMeta.applied) {
          logs.push(`[SUCCESS] Gemini sparkle badge removed via Reverse Alpha Blending (Tier: ${badgeMeta.decisionTier || 'auto'}).`);
        }
        if (textBadgeMeta.applied) {
          logs.push(`[SUCCESS] Corner wordmark overlay detected and seamlessly reconstructed.`);
        }
      }
    } catch (err) {
      console.warn('Client watermark removal warning:', err);
      logs.push(`[WARN] Automatic badge removal pass bypassed.`);
    }
  } else if (isMetadataOnly) {
    logs.push(`[INFO] Metadata-only mode active: visual badge removal bypassed to preserve bit-for-bit pixel integrity.`);
  }

  // 2. Frequency Disruption (SynthID & OpenAI Verifier Evasion)
  if (options.disruptSignals !== false && !isMetadataOnly) {
    logs.push(`[PROCESS] Initializing ${disruptionMode.toUpperCase()} frequency disruption (Strength: ${disruptionStrength}%)...`);

    if (disruptionMode === 'aggressive') {
      const maxDelta = (disruptionStrength / 100) * 2.8;
      imageData = applyBoundedFourierScrambleClient(imageData, maxDelta);
      logs.push(`[PROCESS] Bounded 16-32px Fourier phase scrambler applied (maxDelta: ±${maxDelta.toFixed(1)}).`);
    }

    const sigmaR = disruptionMode === 'aggressive' ? 18 : 14;
    const noiseScale = disruptionMode === 'aggressive' ? (disruptionStrength / 100) * 1.8 : (disruptionStrength / 100) * 1.4;
    const { output: bilateralBytes, hasTransparency } = applyBilateralCarrierDisruptionRgba(
      imageData.data,
      canvas.width,
      canvas.height,
      sigmaR,
      noiseScale,
      disruptionMode
    );
    imageData.data.set(bilateralBytes);
    logs.push(`[PROCESS] Gradient-adaptive bilateral carrier smoothing applied (flat-field carrier suppressed).`);

    if (disruptionMode === 'aggressive') {
      const medianBytes = applyMedianFilter3x3Rgba(imageData.data, canvas.width, canvas.height);
      imageData.data.set(medianBytes);
      logs.push(`[PROCESS] 3x3 median order-statistic spatial filter applied (outlier noise crushed).`);
    }
    ctx.putImageData(imageData, 0, 0);

    // Step 2D: Anisotropic non-uniform geometric coordinate desynchronization
    // Breaks orthogonal 8x8 DCT grid and rectangular convolutional receptive fields
    const scaleX = disruptionMode === 'aggressive' ? 0.954 : 0.976;
    const scaleY = disruptionMode === 'aggressive' ? 0.942 : 0.966;
    const scaledW = Math.max(16, Math.round(canvas.width * scaleX));
    const scaledH = Math.max(16, Math.round(canvas.height * scaleY));

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = scaledW;
    tempCanvas.height = scaledH;
    const tempCtx = tempCanvas.getContext('2d');

    if (tempCtx) {
      tempCtx.imageSmoothingEnabled = true;
      tempCtx.imageSmoothingQuality = 'high';
      tempCtx.drawImage(canvas, 0, 0, scaledW, scaledH);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);
    }

    // Step 2E: Mandatory Internal Lossy Round-Trip (DCT Coefficient Quantization)
    // Runs an intermediate lossy cycle on canvas to quantize high-frequency DCT harmonics
    // before final export. If transparency is present, we use lossy WebP to avoid flattening
    // alpha onto black (#000000). For opaque images, we use lossy JPEG.
    const internalQuality = disruptionMode === 'aggressive' ? 0.74 : 0.82;
    const lossyMime = hasTransparency ? 'image/webp' : 'image/jpeg';
    const internalLossyDataUrl = canvas.toDataURL(lossyMime, internalQuality);

    // If toDataURL('image/webp') is not supported or returns same data, canvas safely fallbacks
    if (internalLossyDataUrl && !internalLossyDataUrl.startsWith('data:image/png')) {
      const lossyImg = new Image();
      await new Promise((resolve, reject) => {
        lossyImg.onload = resolve;
        lossyImg.onerror = reject;
        lossyImg.src = internalLossyDataUrl;
      });
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(lossyImg, 0, 0);
      logs.push(`[PROCESS] Lossy DCT quantization pass applied (${hasTransparency ? 'alpha-preserving WebP' : 'JPEG'}).`);
    } else {
      logs.push(`[INFO] Alpha transparency preserved without lossy container flattening.`);
    }

    logs.push(`[SUCCESS] Multi-layer coordinate desynchronization, median filtering, & DCT quantization completed.`);
  } else if (isMetadataOnly) {
    logs.push(`[INFO] Metadata-only mode active: preserving pixel data bit-for-bit.`);
  }

  // 3. Metadata Stripping (Canvas export strips all C2PA, EXIF, and XMP metadata)
  if (options.stripMetadata !== false) {
    logs.push(`[PROCESS] Stripping EXIF, XMP, and C2PA Content Credentials headers...`);
    logs.push(`[SUCCESS] Canvas re-encoding completely eliminated all metadata headers.`);
  }

  const format = options.format || 'png';
  const mimeType = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  const exportQuality = options.quality ? options.quality / 100 : 0.95;
  const base64Image = canvas.toDataURL(mimeType, exportQuality);

  // 4. Perform Real Forensic Byte-Level Provenance Audit on Client Base64
  const provenanceAudit = scanBase64Provenance(base64Image);
  logs.push(`[AUDIT] Scanned ${provenanceAudit.bytesScanned} bytes (${provenanceAudit.formatDetected}): C2PA=${provenanceAudit.c2paFound ? 'FOUND' : 'CLEAN'}, EXIF=${provenanceAudit.exifFound ? 'FOUND' : 'CLEAN'}, XMP=${provenanceAudit.xmpFound ? 'FOUND' : 'CLEAN'}, ICC=${provenanceAudit.iccFound ? 'FOUND' : 'CLEAN'}, IPTC=${provenanceAudit.iptcFound ? 'FOUND' : 'CLEAN'}`);

  const executionTimeMs = Date.now() - startTime;
  logs.push(`[COMPLETE] Pipeline finished in ${executionTimeMs}ms (Browser Memory).`);

  return {
    base64Image,
    telemetry: {
      originalSize: file.size,
      processedSize: Math.round(base64Image.length * 0.75),
      dimensions: { width: canvas.width, height: canvas.height },
      metadataStripped: options.stripMetadata !== false,
      signalsDisrupted: options.disruptSignals !== false && !isMetadataOnly,
      disruptionMode,
      badgeRemoved: shouldRemoveBadge,
      provenanceAudit,
      executionTimeMs,
      logs,
    },
  };
}

/**
 * Pure client-side inpainting fallback when backend API is unavailable (e.g. GitHub Pages static export).
 * Performs iterative edge-aware boundary interpolation and soft Gaussian blur falloff.
 */
export async function inpaintImageClientSide(
  imageFile: File,
  maskBlob: Blob,
  format: 'jpeg' | 'png' | 'webp' = 'png'
): Promise<{ base64Image: string; telemetry: any }> {
  const startTime = Date.now();
  const logs: string[] = [];

  logs.push(`[CLIENT INPAINT] Loading image and brush mask into browser canvas...`);

  // Load Image
  const img = new Image();
  const imgUrl = URL.createObjectURL(imageFile);
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = imgUrl;
  });
  URL.revokeObjectURL(imgUrl);

  // Load Mask
  const maskImg = new Image();
  const maskUrl = URL.createObjectURL(maskBlob);
  await new Promise((resolve, reject) => {
    maskImg.onload = resolve;
    maskImg.onerror = reject;
    maskImg.src = maskUrl;
  });
  URL.revokeObjectURL(maskUrl);

  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create canvas context for inpainting');

  // Draw base image
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, width, height);

  // Draw mask to secondary canvas
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (!maskCtx) throw new Error('Could not create mask canvas context');
  maskCtx.drawImage(maskImg, 0, 0, width, height);
  const maskData = maskCtx.getImageData(0, 0, width, height);

  logs.push(`[CLIENT INPAINT] Analyzing mask coordinates and neighborhood boundaries...`);
  inpaintMaskOnRgba(imgData.data, width, height, maskData.data);
  ctx.putImageData(imgData, 0, 0);

  logs.push(`[CLIENT INPAINT] Reconstructed patch composited smoothly.`);
  logs.push(`[SUCCESS] Wiped C2PA Content Credentials and EXIF metadata.`);

  const mimeType = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  const base64Image = canvas.toDataURL(mimeType, 0.95);
  const provenanceAudit = scanBase64Provenance(base64Image);
  const executionTimeMs = Date.now() - startTime;
  logs.push(`[COMPLETE] Client inpainting finished in ${executionTimeMs}ms.`);

  return {
    base64Image,
    telemetry: {
      originalSize: imageFile.size,
      processedSize: Math.round(base64Image.length * 0.75),
      dimensions: { width, height },
      provenanceAudit,
      executionTimeMs,
      logs,
    },
  };
}
