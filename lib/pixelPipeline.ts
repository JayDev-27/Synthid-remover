export type GeminiRemoverSyncFn = (imageData: ImageData, options?: Record<string, any>) => any;

let cachedRemoverSync: GeminiRemoverSyncFn | null = null;
let cachedAlphaMaps: { 24?: Float32Array; 48?: Float32Array } = {};

function resampleAlphaMap(src: Float32Array, srcSize: number, dstSize: number): Float32Array {
  if (srcSize === dstSize) return src;
  const out = new Float32Array(dstSize * dstSize);
  for (let y = 0; y < dstSize; y++) {
    const sy = (y * (srcSize - 1)) / Math.max(1, dstSize - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcSize - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < dstSize; x++) {
      const sx = (x * (srcSize - 1)) / Math.max(1, dstSize - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcSize - 1, x0 + 1);
      const wx = sx - x0;
      out[y * dstSize + x] =
        src[y0 * srcSize + x0] * (1 - wx) * (1 - wy) +
        src[y0 * srcSize + x1] * wx * (1 - wy) +
        src[y1 * srcSize + x0] * (1 - wx) * wy +
        src[y1 * srcSize + x1] * wx * wy;
    }
  }
  return out;
}

/**
 * Lazily loads `@pilio/gemini-watermark-remover/image-data` and caches embedded alpha maps so callers
 * work seamlessly across Next.js client bundles, Edge/Node ESM scripts, and CommonJS contexts.
 */
export async function loadGeminiWatermarkRemoverSync(): Promise<GeminiRemoverSyncFn | null> {
  if (cachedRemoverSync && cachedAlphaMaps[24]) return cachedRemoverSync;
  try {
    const mod = await import('@pilio/gemini-watermark-remover/image-data');
    if (typeof mod.removeWatermarkFromImageDataSync === 'function') {
      cachedRemoverSync = mod.removeWatermarkFromImageDataSync as GeminiRemoverSyncFn;
    }
    if (typeof mod.createWatermarkEngine === 'function' && !cachedAlphaMaps[24]) {
      const engine = await mod.createWatermarkEngine();
      cachedAlphaMaps[24] = await engine.getAlphaMap(24);
      cachedAlphaMaps[48] = await engine.getAlphaMap(48);
    }
  } catch {
    // Fallback to procedural star-rescue if package cannot be resolved
  }
  return cachedRemoverSync;
}

export type DisruptionMode = 'balanced' | 'aggressive' | 'metadata-only';
export type WatermarkCornerPreset = 'auto' | 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface SparkleLockBox {
  x: number;
  y: number;
  size: number;
  gain?: number;
}

export interface SparkleRemovalMeta {
  applied: boolean;
  decisionTier?: string | null;
  alphaGain?: number;
  rescueApplied?: boolean;
  rescuePosition?: { x: number; y: number; size: number } | null;
  lockBox?: SparkleLockBox | null;
}

/**
 * Builds a normalized 4-pointed astroid Gemini sparkle alpha template of size S x S.
 */
function buildSparkleTemplate(size: number): Float32Array {
  const template = new Float32Array(size * size);
  const half = (size - 1) / 2;
  const radius = half * 0.92;
  for (let y = 0; y < size; y++) {
    const dy = (y - half) / radius;
    for (let x = 0; x < size; x++) {
      const dx = (x - half) / radius;
      // 4-pointed concave astroid profile matching Gemini badge geometry
      const norm = Math.pow(Math.abs(dx), 0.62) + Math.pow(Math.abs(dy), 0.62);
      if (norm <= 1.0) {
        const edgeFade = Math.min(1, Math.max(0, (1.0 - norm) * 4.5));
        const coreBoost = norm < 0.45 ? 1.0 : 0.78 + 0.22 * edgeFade;
        template[y * size + x] = Math.min(1.0, edgeFade * coreBoost);
      }
    }
  }
  return template;
}

const TEMPLATE_CACHE = new Map<number, { tpl: Float32Array; gx: Float32Array; gy: Float32Array; norm: number }>();
function getSparkleTemplateEntry(size: number) {
  let entry = TEMPLATE_CACHE.get(size);
  if (!entry) {
    let tpl: Float32Array;
    if (size === 24 && cachedAlphaMaps[24]) {
      tpl = cachedAlphaMaps[24];
    } else if (size === 48 && cachedAlphaMaps[48]) {
      tpl = cachedAlphaMaps[48];
    } else if (cachedAlphaMaps[48]) {
      tpl = resampleAlphaMap(cachedAlphaMaps[48], 48, size);
    } else {
      tpl = buildSparkleTemplate(size);
    }

    const gx = new Float32Array(size * size);
    const gy = new Float32Array(size * size);
    let norm = 0;
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const i = y * size + x;
        gx[i] = (tpl[i + 1] - tpl[i - 1]) * 0.5;
        gy[i] = (tpl[(y + 1) * size + x] - tpl[(y - 1) * size + x]) * 0.5;
        norm += gx[i] * gx[i] + gy[i] * gy[i];
      }
    }
    entry = { tpl, gx, gy, norm: Math.sqrt(norm) };
    TEMPLATE_CACHE.set(size, entry);
  }
  return entry;
}

function getRoiLumaAt(roiLum: Float32Array, roiW: number, rx: number, ry: number): number {
  return roiLum[ry * roiW + rx];
}

function hasRadialStarPeak(roiLum: Float32Array, roiW: number, rx0: number, ry0: number, size: number): boolean {
  const half = size >> 1;
  const cx = rx0 + half;
  const cy = ry0 + half;
  const armR = Math.max(4, Math.round(size * 0.25));
  const diagR = Math.max(3, Math.round(size * 0.2));

  const c = getRoiLumaAt(roiLum, roiW, cx, cy);
  const armN = getRoiLumaAt(roiLum, roiW, cx, cy - armR);
  const armS = getRoiLumaAt(roiLum, roiW, cx, cy + armR);
  const armW = getRoiLumaAt(roiLum, roiW, cx - armR, cy);
  const armE = getRoiLumaAt(roiLum, roiW, cx + armR, cy);
  const dNW = getRoiLumaAt(roiLum, roiW, cx - diagR, cy - diagR);
  const dNE = getRoiLumaAt(roiLum, roiW, cx + diagR, cy - diagR);
  const dSW = getRoiLumaAt(roiLum, roiW, cx - diagR, cy + diagR);
  const dSE = getRoiLumaAt(roiLum, roiW, cx + diagR, cy + diagR);

  let ridges = 0;
  if (armN > dNW + 12 && armN > dNE + 12) ridges++;
  if (armS > dSW + 12 && armS > dSE + 12) ridges++;
  if (armW > dNW + 12 && armW > dSW + 12) ridges++;
  if (armE > dNE + 12 && armE > dSE + 12) ridges++;
  const centerPopCount =
    (c - dNW > 25 ? 1 : 0) +
    (c - dNE > 25 ? 1 : 0) +
    (c - dSW > 25 ? 1 : 0) +
    (c - dSE > 25 ? 1 : 0);
  return ridges >= 2 || (ridges >= 1 && centerPopCount >= 3);
}

/**
 * Unblends a detected Gemini star box using inverse alpha compositing cleanly.
 */
export function unblendSparkleBox(
  rgba: Uint8ClampedArray,
  width: number,
  x0: number,
  y0: number,
  size: number,
  gainOverride?: number
): void {
  const { tpl } = getSparkleTemplateEntry(size);
  let tplMax = 0.25;
  for (let i = 0; i < tpl.length; i++) {
    if (tpl[i] > tplMax) tplMax = tpl[i];
  }
  const gain = gainOverride ?? Math.min(0.92, 0.42 / tplMax);

  for (let dy = 0; dy < size; dy++) {
    const rowOff = (y0 + dy) * width;
    for (let dx = 0; dx < size; dx++) {
      const a = Math.min(0.88, tpl[dy * size + dx] * gain);
      if (a < 0.03) continue;
      const p = (rowOff + x0 + dx) * 4;
      const invA = 1.0 / (1.0 - a);
      for (let c = 0; c < 3; c++) {
        rgba[p + c] = Math.min(255, Math.max(0, Math.round((rgba[p + c] - a * 255) * invA)));
      }
    }
  }
}

/**
 * Fast precomputed-gradient off-grid 4-pointed Gemini sparkle detector & unblender.
 * Precomputes bottom-right ROI luminance & gradient maps once (<0.5ms) so multi-scale detection is near-instant.
 */
export function rescueOffGridSparkle(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): { x: number; y: number; size: number; gain: number } | null {
  if (width < 40 || height < 40) return null;

  const roiX = Math.max(0, width - 148);
  const roiY = Math.max(0, height - 134);
  const roiW = width - roiX;
  const roiH = height - roiY;
  if (roiW < 28 || roiH < 28) return null;

  // Precompute ROI luminance, central-difference gradients, and integral squared-magnitude once
  const roiLum = new Float32Array(roiW * roiH);
  for (let ry = 0; ry < roiH; ry++) {
    const y = roiY + ry;
    const rowP = y * width * 4;
    const dstOff = ry * roiW;
    for (let rx = 0; rx < roiW; rx++) {
      const p = rowP + (roiX + rx) * 4;
      roiLum[dstOff + rx] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    }
  }

  const roiGx = new Float32Array(roiW * roiH);
  const roiGy = new Float32Array(roiW * roiH);
  const roiMagSq = new Float32Array(roiW * roiH);
  for (let ry = 1; ry < roiH - 1; ry++) {
    const rOff = ry * roiW;
    for (let rx = 1; rx < roiW - 1; rx++) {
      const idx = rOff + rx;
      const gx = (roiLum[idx + 1] - roiLum[idx - 1]) * 0.5;
      const gy = (roiLum[idx + roiW] - roiLum[idx - roiW]) * 0.5;
      roiGx[idx] = gx;
      roiGy[idx] = gy;
      roiMagSq[idx] = gx * gx + gy * gy;
    }
  }

  const sizes = [24, 32, 48];
  let best: { score: number; x: number; y: number; size: number } | null = null;

  for (const size of sizes) {
    if (size + 6 > roiW || size + 6 > roiH) continue;
    const { gx: gxT, gy: gyT, norm: normT } = getSparkleTemplateEntry(size);
    if (normT <= 1e-6) continue;

    const maxRx = roiW - size - 4;
    const maxRy = roiH - size - 4;

    for (let ry0 = 1; ry0 <= maxRy; ry0++) {
      for (let rx0 = 1; rx0 <= maxRx; rx0++) {
        if (!hasRadialStarPeak(roiLum, roiW, rx0, ry0, size)) continue;

        let dot = 0;
        let normI = 0;
        for (let dy = 1; dy < size - 1; dy++) {
          const roiRow = (ry0 + dy) * roiW + rx0;
          const tplRow = dy * size;
          for (let dx = 1; dx < size - 1; dx++) {
            const rIdx = roiRow + dx;
            const tIdx = tplRow + dx;
            dot += roiGx[rIdx] * gxT[tIdx] + roiGy[rIdx] * gyT[tIdx];
            normI += roiMagSq[rIdx];
          }
        }
        if (normI <= 800) continue;
        const score = dot / (Math.sqrt(normI) * normT);
        if (score >= 0.32 && (!best || score > best.score)) {
          best = { score, x: roiX + rx0, y: roiY + ry0, size };
        }
      }
    }
  }

  if (!best) return null;

  const { tpl } = getSparkleTemplateEntry(best.size);
  let tplMax = 0.25;
  for (let i = 0; i < tpl.length; i++) {
    if (tpl[i] > tplMax) tplMax = tpl[i];
  }
  const gain = Math.min(0.92, 0.42 / tplMax);
  unblendSparkleBox(rgba, width, best.x, best.y, best.size, gain);

  return { x: best.x, y: best.y, size: best.size, gain: Number(gain.toFixed(2)) };
}

/**
 * Flips/mirrors RGBA coordinates in-place so any corner preset maps to bottom-right for uniform detection.
 */
function transformCornerToBottomRight(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  corner: Exclude<WatermarkCornerPreset, 'auto' | 'bottom-right'>
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  const flipX = corner === 'bottom-left' || corner === 'top-left';
  const flipY = corner === 'top-right' || corner === 'top-left';

  for (let y = 0; y < height; y++) {
    const dstY = flipY ? height - 1 - y : y;
    for (let x = 0; x < width; x++) {
      const dstX = flipX ? width - 1 - x : x;
      const srcP = (y * width + x) * 4;
      const dstP = (dstY * width + dstX) * 4;
      out[dstP] = rgba[srcP];
      out[dstP + 1] = rgba[srcP + 1];
      out[dstP + 2] = rgba[srcP + 2];
      out[dstP + 3] = rgba[srcP + 3];
    }
  }
  return out;
}

/**
 * Erases visible Gemini sparkle badges in RGBA pixel buffers using adaptive Reverse Alpha Blending
 * plus off-grid/cropped 4-point star rescue (supports Image, GIF frames, and Video frames uniformly).
 */
export function eraseGeminiSparklePixelData(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options?: {
    cornerHint?: WatermarkCornerPreset;
    forceRescue?: boolean;
    removerSyncFn?: GeminiRemoverSyncFn | null;
  }
): SparkleRemovalMeta {
  const cornerHint = options?.cornerHint || 'auto';
  const needsOrient = cornerHint !== 'auto' && cornerHint !== 'bottom-right';
  const workRgba = needsOrient ? transformCornerToBottomRight(rgba, width, height, cornerHint) : rgba;
  const removeFn = options?.removerSyncFn ?? cachedRemoverSync;

  let applied = false;
  let decisionTier: string | null | undefined = null;
  let alphaGain: number | undefined;
  let rescueMatch: { x: number; y: number; size: number; gain: number } | null = null;
  let lockBox: SparkleLockBox | null = null;

  try {
    const result = removeFn
      ? removeFn(
          { width, height, data: workRgba } as ImageData,
          {
            adaptiveMode: 'always',
            aggressiveLocatedFallback: true,
            locatedAggressiveRemoval: true,
          }
        )
      : null;

    if (result?.imageData?.data) {
      workRgba.set(result.imageData.data);
      applied = Boolean(result.meta?.applied ?? true);
      decisionTier = result.meta?.decisionTier ?? 'auto';
      alphaGain = result.meta?.alphaGain;
      const pos = result.meta?.position;
      if (applied && pos && typeof pos.x === 'number' && typeof pos.y === 'number' && pos.width > 0) {
        const gainVal = typeof alphaGain === 'number' ? alphaGain : 0.8;
        lockBox = { x: pos.x, y: pos.y, size: pos.width, gain: gainVal };
      }
    }

    // Run off-grid 4-point star rescue when residual sparkle persists (e.g. cropped 16:9 / video / GIF frames)
    const shouldCheckRescue =
      options?.forceRescue ||
      !removeFn ||
      !applied ||
      (result?.meta as any)?.qualityStatus === 'visible-residual' ||
      (result?.meta as any)?.selectionDebug?.tooDark;

    if (shouldCheckRescue) {
      rescueMatch = rescueOffGridSparkle(workRgba, width, height);
      if (rescueMatch) {
        applied = true;
        decisionTier = `${decisionTier || 'auto'}+star-rescue`;
        lockBox = {
          x: rescueMatch.x,
          y: rescueMatch.y,
          size: rescueMatch.size,
          gain: rescueMatch.gain,
        };
      }
    }
  } catch {
    rescueMatch = rescueOffGridSparkle(workRgba, width, height);
    if (rescueMatch) {
      applied = true;
      decisionTier = 'star-rescue';
      lockBox = {
        x: rescueMatch.x,
        y: rescueMatch.y,
        size: rescueMatch.size,
        gain: rescueMatch.gain,
      };
    }
  }

  if (needsOrient) {
    const restored = transformCornerToBottomRight(workRgba, width, height, cornerHint);
    rgba.set(restored);
  } else if (workRgba !== rgba) {
    rgba.set(workRgba);
  }

  return {
    applied,
    decisionTier,
    alphaGain,
    rescueApplied: Boolean(rescueMatch),
    rescuePosition: rescueMatch ? { x: rescueMatch.x, y: rescueMatch.y, size: rescueMatch.size } : null,
    lockBox,
  };
}

/**
 * Fast O(size^2) frame-locked badge unblender for multi-frame GIF & Video streams once keyframe
 * detection has locked the badge coordinates, avoiding repeated full-frame searches.
 */
export function applyLockedCornerUnblend(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  lockBox: SparkleLockBox,
  cornerHint: WatermarkCornerPreset = 'auto'
): void {
  const needsOrient = cornerHint !== 'auto' && cornerHint !== 'bottom-right';
  const workRgba = needsOrient ? transformCornerToBottomRight(rgba, width, height, cornerHint) : rgba;
  unblendSparkleBox(workRgba, width, lockBox.x, lockBox.y, lockBox.size, lockBox.gain);
  if (needsOrient) {
    rgba.set(transformCornerToBottomRight(workRgba, width, height, cornerHint));
  } else if (workRgba !== rgba) {
    rgba.set(workRgba);
  }
}

/**
 * Pure pixel-domain gradient-adaptive bilateral carrier disruption + multi-band phase dither.
 */
export function applyBilateralCarrierDisruptionRgba(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  sigmaR: number,
  noiseScale: number,
  mode: DisruptionMode
): { output: Uint8ClampedArray; hasTransparency: boolean } {
  const output = new Uint8ClampedArray(src.length);
  output.set(src);

  const lut = new Float32Array(768);
  const denom = 2 * sigmaR * sigmaR;
  for (let d = 0; d < 768; d++) {
    lut[d] = Math.exp(-(d * d) / denom);
  }

  const ditherProb = mode === 'aggressive' ? 0.70 : 0.50;
  let hasTransparency = false;

  for (let y = 1; y < h - 1; y++) {
    const rowOffset = y * w * 4;
    for (let x = 1; x < w - 1; x++) {
      const idx = rowOffset + x * 4;
      if (src[idx + 3] < 255) hasTransparency = true;

      const r = src[idx];
      const g = src[idx + 1];
      const b = src[idx + 2];

      let sumR = 0, sumG = 0, sumB = 0, totalW = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const nRow = (y + dy) * w * 4;
        for (let dx = -1; dx <= 1; dx++) {
          const nIdx = nRow + (x + dx) * 4;
          const nr = src[nIdx];
          const ng = src[nIdx + 1];
          const nb = src[nIdx + 2];
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

      if (Math.random() < ditherProb) {
        const jChroma = (Math.random() - 0.5) * noiseScale;
        const jLuma = (Math.random() - 0.5) * (noiseScale * (mode === 'aggressive' ? 0.55 : 0.35));
        outR = Math.min(255, Math.max(0, outR + jChroma + jLuma));
        outG = Math.min(255, Math.max(0, outG + jLuma));
        outB = Math.min(255, Math.max(0, outB - jChroma + jLuma));
      }

      output[idx] = Math.round(outR);
      output[idx + 1] = Math.round(outG);
      output[idx + 2] = Math.round(outB);
    }
  }

  if (!hasTransparency) {
    for (let i = 3; i < src.length; i += 64) {
      if (src[i] < 255) {
        hasTransparency = true;
        break;
      }
    }
  }

  return { output, hasTransparency };
}

/**
 * Pure pixel-domain 3x3 median order-statistic filter to strip outlier carrier noise.
 */
export function applyMedianFilter3x3Rgba(src: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(src.length);
  output.set(src);

  const winR = new Uint8Array(9);
  const winG = new Uint8Array(9);
  const winB = new Uint8Array(9);

  for (let y = 1; y < h - 1; y++) {
    const rowOffset = y * w * 4;
    for (let x = 1; x < w - 1; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const srcOffset = (y + dy) * w * 4 + (x - 1) * 4;
        for (let dx = 0; dx < 3; dx++) {
          const idx = srcOffset + dx * 4;
          winR[k] = src[idx];
          winG[k] = src[idx + 1];
          winB[k] = src[idx + 2];
          k++;
        }
      }
      const dstIdx = rowOffset + x * 4;
      winR.sort();
      winG.sort();
      winB.sort();
      output[dstIdx] = winR[4];
      output[dstIdx + 1] = winG[4];
      output[dstIdx + 2] = winB[4];
    }
  }

  return output;
}

/**
 * Pure pixel-domain anisotropic bilinear coordinate squeeze + restore to desynchronize 8x8 DCT grids.
 * Used cleanly across GIF frames in headless/Node/Browser environments without DOM dependencies.
 */
export function applyAnisotropicCoordinateShiftRgba(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  scaleX: number,
  scaleY: number
): Uint8ClampedArray {
  if (w < 8 || h < 8) return new Uint8ClampedArray(src);

  const sw = Math.max(4, Math.round(w * scaleX));
  const sh = Math.max(4, Math.round(h * scaleY));
  const small = new Uint8ClampedArray(sw * sh * 4);

  const bilinearSample = (
    buf: Uint8ClampedArray,
    bw: number,
    bh: number,
    fx: number,
    fy: number,
    outBuf: Uint8ClampedArray,
    dstIdx: number
  ) => {
    const x0 = Math.max(0, Math.min(bw - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(bh - 1, Math.floor(fy)));
    const x1 = Math.min(bw - 1, x0 + 1);
    const y1 = Math.min(bh - 1, y0 + 1);
    const wx = fx - x0;
    const wy = fy - y0;
    const w00 = (1 - wx) * (1 - wy);
    const w10 = wx * (1 - wy);
    const w01 = (1 - wx) * wy;
    const w11 = wx * wy;
    const p00 = (y0 * bw + x0) * 4;
    const p10 = (y0 * bw + x1) * 4;
    const p01 = (y1 * bw + x0) * 4;
    const p11 = (y1 * bw + x1) * 4;
    for (let c = 0; c < 4; c++) {
      outBuf[dstIdx + c] = Math.round(
        buf[p00 + c] * w00 + buf[p10 + c] * w10 + buf[p01 + c] * w01 + buf[p11 + c] * w11
      );
    }
  };

  for (let y = 0; y < sh; y++) {
    const srcY = (y / Math.max(1, sh - 1)) * (h - 1);
    for (let x = 0; x < sw; x++) {
      const srcX = (x / Math.max(1, sw - 1)) * (w - 1);
      bilinearSample(src, w, h, srcX, srcY, small, (y * sw + x) * 4);
    }
  }

  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcY = (y / Math.max(1, h - 1)) * (sh - 1);
    for (let x = 0; x < w; x++) {
      const srcX = (x / Math.max(1, w - 1)) * (sw - 1);
      bilinearSample(small, sw, sh, srcX, srcY, out, (y * w + x) * 4);
    }
  }
  return out;
}

/**
 * Iterative boundary-diffusion mask inpainting directly in a Uint8ClampedArray RGBA buffer.
 * Operates strictly within the mask bounding box so multi-frame GIF & Video inpainting runs in milliseconds per frame.
 */
export function inpaintMaskOnRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  maskRgba: Uint8ClampedArray
): number {
  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;
  let hasMask = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (maskRgba[idx + 3] > 20 && maskRgba[idx] > 20) {
        hasMask = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (!hasMask) return 0;

  const pad = 12;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);

  const roiW = maxX - minX + 1;
  const roiH = maxY - minY + 1;
  const resolved = new Uint8Array(roiW * roiH);
  let totalMasked = 0;

  for (let ry = 0; ry < roiH; ry++) {
    const y = minY + ry;
    for (let rx = 0; rx < roiW; rx++) {
      const x = minX + rx;
      const idx = (y * width + x) * 4;
      if (maskRgba[idx + 3] > 30 && maskRgba[idx] > 30) {
        resolved[ry * roiW + rx] = 1;
        totalMasked++;
      }
    }
  }

  const initialMasked = totalMasked;
  const maskRadius = Math.max(roiW, roiH) / 2;
  const passes = Math.max(6, Math.min(36, Math.ceil(maskRadius / 2)));
  const radius = 3;

  for (let pass = 0; pass < passes && totalMasked > 0; pass++) {
    const newlyResolved: number[] = [];
    for (let ry = 0; ry < roiH; ry++) {
      const y = minY + ry;
      for (let rx = 0; rx < roiW; rx++) {
        const roiCoord = ry * roiW + rx;
        if (resolved[roiCoord] !== 1) continue;

        const x = minX + rx;
        let rSum = 0, gSum = 0, bSum = 0, count = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          const nry = ny - minY;
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const nrx = nx - minX;
            const insideRoi = nrx >= 0 && nrx < roiW && nry >= 0 && nry < roiH;
            if (!insideRoi || resolved[nry * roiW + nrx] === 0) {
              const weight = 1 / (1 + Math.hypot(dx, dy));
              const nIdx = (ny * width + nx) * 4;
              rSum += rgba[nIdx] * weight;
              gSum += rgba[nIdx + 1] * weight;
              bSum += rgba[nIdx + 2] * weight;
              count += weight;
            }
          }
        }

        if (count > 0) {
          const idx = (y * width + x) * 4;
          rgba[idx] = Math.round(rSum / count);
          rgba[idx + 1] = Math.round(gSum / count);
          rgba[idx + 2] = Math.round(bSum / count);
          newlyResolved.push(roiCoord);
        }
      }
    }
    for (const c of newlyResolved) {
      resolved[c] = 0;
    }
    totalMasked -= newlyResolved.length;
    if (newlyResolved.length === 0) break;
  }

  return initialMasked;
}
