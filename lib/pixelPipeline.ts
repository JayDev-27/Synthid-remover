export type GeminiRemoverSyncFn = (imageData: ImageData, options?: Record<string, any>) => any;

let cachedRemoverSync: GeminiRemoverSyncFn | null = null;
let cachedAlphaMaps: { 24?: Float32Array; 48?: Float32Array } = {};

function resampleAlphaMap(
  src: Float32Array,
  srcSize: number,
  dstSize: number,
  shiftX: number = 0,
  shiftY: number = 0
): Float32Array {
  if (srcSize === dstSize && shiftX === 0 && shiftY === 0) return src;
  const out = new Float32Array(dstSize * dstSize);
  const denom = Math.max(1, dstSize - 1);
  for (let y = 0; y < dstSize; y++) {
    const sy = ((y + shiftY) * (srcSize - 1)) / denom;
    const y0 = Math.max(0, Math.min(srcSize - 1, Math.floor(sy)));
    const y1 = Math.min(srcSize - 1, y0 + 1);
    const wy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < dstSize; x++) {
      const sx = ((x + shiftX) * (srcSize - 1)) / denom;
      const x0 = Math.max(0, Math.min(srcSize - 1, Math.floor(sx)));
      const x1 = Math.min(srcSize - 1, x0 + 1);
      const wx = Math.max(0, Math.min(1, sx - x0));
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
  sx?: number;
  sy?: number;
  vx?: number;
  vy?: number;
  useHarmonicHeal?: boolean;
}

export interface SparkleRemovalMeta {
  applied: boolean;
  decisionTier?: string | null;
  alphaGain?: number;
  rescueApplied?: boolean;
  rescuePosition?: { x: number; y: number; size: number } | null;
  lockBox?: SparkleLockBox | null;
}

export interface CornerTextRemovalResult {
  applied: boolean;
  box?: { x: number; y: number; width: number; height: number } | null;
  pixelCount?: number;
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

const TEMPLATE_CACHE = new Map<string, { tpl: Float32Array; gx: Float32Array; gy: Float32Array; norm: number }>();
function getSparkleTemplateEntry(size: number, sx: number = 0, sy: number = 0) {
  const key = `${size}:${sx.toFixed(1)}:${sy.toFixed(1)}`;
  let entry = TEMPLATE_CACHE.get(key);
  if (!entry) {
    let tpl: Float32Array;
    if (size === 24 && cachedAlphaMaps[24] && sx === 0 && sy === 0) {
      tpl = cachedAlphaMaps[24];
    } else if (size === 48 && cachedAlphaMaps[48] && sx === 0 && sy === 0) {
      tpl = cachedAlphaMaps[48];
    } else if (cachedAlphaMaps[48]) {
      tpl = resampleAlphaMap(cachedAlphaMaps[48], 48, size, sx, sy);
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
        gy[i] = (tpl[i + size] - tpl[(y - 1) * size + x]) * 0.5;
        norm += gx[i] * gx[i] + gy[i] * gy[i];
      }
    }
    entry = { tpl, gx, gy, norm: Math.sqrt(norm) };
    TEMPLATE_CACHE.set(key, entry);
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
 * Evaluates optimal inverse-alpha gain & checks Gradient-Drop + No-Dark-Pit safety gates
 * so textured backgrounds never get carved into black star holes.
 */
function evaluateSparkleCandidateSafety(
  rgba: Uint8ClampedArray,
  width: number,
  x0: number,
  y0: number,
  size: number,
  tpl: Float32Array,
  gxT: Float32Array,
  gyT: Float32Array,
  normT: number,
  beforeScore: number
): { valid: boolean; gain: number; afterScore: number } {
  const lum = new Float32Array(size * size);
  let outerSum = 0;
  let outerMin = 255;
  let outerCount = 0;
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const p = ((y0 + dy) * width + (x0 + dx)) * 4;
      const l = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
      lum[dy * size + dx] = l;
      if (tpl[dy * size + dx] < 0.02) {
        outerSum += l;
        if (l < outerMin) outerMin = l;
        outerCount++;
      }
    }
  }
  const outerMean = outerSum / Math.max(1, outerCount);

  let tplMax = 0.25;
  for (let i = 0; i < tpl.length; i++) if (tpl[i] > tplMax) tplMax = tpl[i];

  const evalTrial = (gain: number) => {
    const u = new Float32Array(size * size);
    let coreSum = 0;
    let coreMin = 255;
    let coreCount = 0;
    for (let i = 0; i < size * size; i++) {
      const a = Math.min(0.86, tpl[i] * gain);
      const val = a >= 0.015 ? Math.min(255, Math.max(0, (lum[i] - a * 255) / (1 - a))) : lum[i];
      u[i] = val;
      if (tpl[i] >= 0.35) {
        coreSum += val;
        if (val < coreMin) coreMin = val;
        coreCount++;
      }
    }
    let dot = 0;
    let normU = 0;
    let dotMild = 0;
    let normMild = 0;
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const i = y * size + x;
        const gx = (u[i + 1] - u[i - 1]) * 0.5;
        const gy = (u[i + size] - u[i - size]) * 0.5;
        const magSq = gx * gx + gy * gy;
        const prod = gx * gxT[i] + gy * gyT[i];
        dot += prod;
        normU += magSq;
        if (magSq < 1225) {
          dotMild += prod;
          normMild += magSq;
        }
      }
    }
    const afterScore = dot / (Math.sqrt(normU) * normT + 1e-6);
    const mildScore = normMild > 150 ? dotMild / (Math.sqrt(normMild) * normT + 1e-6) : afterScore;
    const coreMean = coreSum / Math.max(1, coreCount);
    return { afterScore, mildScore, coreMean, coreMin };
  };

  let bestGain = Math.min(0.86, 0.34 / tplMax);
  let bestAbsAfter = Infinity;
  let bestTrial = evalTrial(bestGain);

  for (const g of [0.48, 0.56, 0.64, 0.72, 0.78, 0.84]) {
    const res = evalTrial(g);
    const absScore = Math.abs(res.mildScore);
    // Do not pick a gain that collapses interior into a dark pit when better balanced gain exists
    const createsDarkPit = outerMean >= 32 && res.coreMin < outerMin - 48 && res.coreMean < outerMean * 0.55;
    if (!createsDarkPit && absScore < bestAbsAfter) {
      bestAbsAfter = absScore;
      bestGain = g;
      bestTrial = res;
    }
  }

  const darkPitBlocked =
    outerMean >= 32 && bestTrial.coreMin < outerMin - 50 && bestTrial.coreMean < outerMean * 0.54;
  const gradientDropped = bestTrial.afterScore < beforeScore * 0.65 || beforeScore >= 0.5;

  return {
    valid: !darkPitBlocked && gradientDropped,
    gain: bestGain,
    afterScore: bestTrial.afterScore,
  };
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
  gainOverride?: number,
  sx: number = 0,
  sy: number = 0
): void {
  const { tpl } = getSparkleTemplateEntry(size, sx, sy);
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
 * Frequency-separated anisotropic harmonic + unblended interior detail reconstruction.
 * Erases scaled/compressed H.264 sparkles cleanly without dark edge ringing or color cast.
 */
export function healSparkleAnisotropicHarmonic(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  size: number,
  gain: number = 0.62,
  sx: number = 0,
  sy: number = 0
): void {
  const { tpl } = getSparkleTemplateEntry(size, sx, sy);
  const P = size + 4;
  const solveMask = new Uint8Array(P * P);
  for (let py = 2; py < P - 2; py++) {
    for (let px = 2; px < P - 2; px++) {
      const tv = tpl[(py - 2) * size + (px - 2)];
      if (tv >= 0.035) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (Math.abs(dx) + Math.abs(dy) <= 1 || tv >= 0.10) {
              solveMask[(py + dy) * P + (px + dx)] = 1;
            }
          }
        }
      }
    }
  }

  const act: number[] = [];
  for (let py = 1; py < P - 1; py++) {
    for (let px = 1; px < P - 1; px++) {
      if (solveMask[py * P + px]) act.push(py * P + px);
    }
  }
  if (act.length === 0) return;

  // Inward topological BFS distance from untouched exterior so edge halo never enters interior HF detail
  const dist = new Int16Array(P * P).fill(-1);
  const q: number[] = [];
  for (let py = 0; py < P; py++) {
    for (let px = 0; px < P; px++) {
      if (!solveMask[py * P + px]) {
        dist[py * P + px] = 0;
        q.push(py * P + px);
      }
    }
  }
  for (let head = 0; head < q.length; head++) {
    const idx = q[head];
    const d = dist[idx];
    const py = Math.floor(idx / P);
    const px = idx % P;
    const neighbors = [
      py > 0 ? (py - 1) * P + px : -1,
      py + 1 < P ? (py + 1) * P + px : -1,
      px > 0 ? py * P + (px - 1) : -1,
      px + 1 < P ? py * P + (px + 1) : -1,
    ];
    for (const nIdx of neighbors) {
      if (nIdx >= 0 && dist[nIdx] === -1) {
        dist[nIdx] = d + 1;
        q.push(nIdx);
      }
    }
  }

  const harm = new Float32Array(P * P * 3);
  for (let py = 0; py < P; py++) {
    const gy = Math.max(0, Math.min(height - 1, y0 + py - 2));
    for (let px = 0; px < P; px++) {
      const gx = Math.max(0, Math.min(width - 1, x0 + px - 2));
      const p = (gy * width + gx) * 4;
      const gi = (py * P + px) * 3;
      harm[gi] = rgba[p];
      harm[gi + 1] = rgba[p + 1];
      harm[gi + 2] = rgba[p + 2];
    }
  }

  let sumGx2 = 0;
  let sumGy2 = 0;
  for (let py = 1; py < P - 1; py++) {
    for (let px = 1; px < P - 1; px++) {
      if (solveMask[py * P + px]) continue;
      const dx = harm[(py * P + px + 1) * 3] - harm[(py * P + px - 1) * 3];
      const dy = harm[((py + 1) * P + px) * 3] - harm[((py - 1) * P + px) * 3];
      sumGx2 += dx * dx;
      sumGy2 += dy * dy;
    }
  }
  const ratio = sumGy2 / Math.max(1, sumGx2 + sumGy2);
  const wH = 0.22 + ratio * 0.22;
  const wV = 0.50 - wH;

  for (const idx of act) {
    const py = Math.floor(idx / P);
    const px = idx % P;
    let lx = px;
    while (lx > 0 && solveMask[py * P + lx]) lx--;
    let rx = px;
    while (rx < P - 1 && solveMask[py * P + rx]) rx++;
    const t = (px - lx) / Math.max(1, rx - lx);
    const lgi = (py * P + lx) * 3;
    const rgi = (py * P + rx) * 3;
    const gi = idx * 3;
    for (let c = 0; c < 3; c++) harm[gi + c] = harm[lgi + c] * (1 - t) + harm[rgi + c] * t;
  }

  const omega = 1.55;
  for (let it = 0; it < 90; it++) {
    for (let k = 0; k < act.length; k++) {
      const idx = act[k];
      const gi = idx * 3;
      const uU = (idx - P) * 3;
      const uD = (idx + P) * 3;
      const uL = (idx - 1) * 3;
      const uR = (idx + 1) * 3;
      for (let c = 0; c < 3; c++) {
        const tgt = wV * (harm[uU + c] + harm[uD + c]) + wH * (harm[uL + c] + harm[uR + c]);
        harm[gi + c] += omega * (tgt - harm[gi + c]);
      }
    }
  }

  // Strictly core-eroded (dist >= 3) inverse-alpha pass to recover cracks/grain cleanly
  const unb = new Float32Array(P * P * 3);
  for (const idx of act) {
    if (dist[idx] < 3) continue;
    const py = Math.floor(idx / P);
    const px = idx % P;
    const tx = px - 2;
    const ty = py - 2;
    if (tx < 0 || tx >= size || ty < 0 || ty >= size) continue;
    const tv = tpl[ty * size + tx];
    const gx = Math.max(0, Math.min(width - 1, x0 + tx));
    const gy = Math.max(0, Math.min(height - 1, y0 + ty));
    const p = (gy * width + gx) * 4;
    const gi = idx * 3;
    const a = Math.min(0.84, tv * gain);
    const inv = 1 / Math.max(0.05, 1 - a);
    for (let c = 0; c < 3; c++) {
      unb[gi + c] = Math.min(255, Math.max(0, (rgba[p + c] - a * 255) * inv));
    }
  }

  const unbLP = new Float32Array(P * P * 3);
  for (const idx of act) {
    if (dist[idx] < 4) continue;
    const py = Math.floor(idx / P);
    const px = idx % P;
    let rs = 0;
    let gs = 0;
    let bs = 0;
    let ws = 0;
    for (let dy = -3; dy <= 3; dy++) {
      const ny = py + dy;
      if (ny < 0 || ny >= P) continue;
      for (let dx = -3; dx <= 3; dx++) {
        const nx = px + dx;
        if (nx < 0 || nx >= P || dist[ny * P + nx] < 3) continue;
        const wt = Math.exp(-(dx * dx + dy * dy) / 5.0);
        const ni = (ny * P + nx) * 3;
        rs += unb[ni] * wt;
        gs += unb[ni + 1] * wt;
        bs += unb[ni + 2] * wt;
        ws += wt;
      }
    }
    if (ws > 0) {
      const gi = idx * 3;
      unbLP[gi] = rs / ws;
      unbLP[gi + 1] = gs / ws;
      unbLP[gi + 2] = bs / ws;
    }
  }

  for (const idx of act) {
    const py = Math.floor(idx / P);
    const px = idx % P;
    const gx = x0 + px - 2;
    const gy = y0 + py - 2;
    if (gx < 0 || gx >= width || gy < 0 || gy >= height) continue;
    const d = dist[idx];
    const t = d < 4 ? 0 : Math.min(1, (d - 3) / 4);
    const taper = t * t * (3 - 2 * t);
    const p = (gy * width + gx) * 4;
    const gi = idx * 3;
    let hfLum = 0;
    if (taper > 0) {
      const hfR = unb[gi] - unbLP[gi];
      const hfG = unb[gi + 1] - unbLP[gi + 1];
      const hfB = unb[gi + 2] - unbLP[gi + 2];
      hfLum = (0.299 * hfR + 0.587 * hfG + 0.114 * hfB) * taper;
    }
    for (let c = 0; c < 3; c++) {
      rgba[p + c] = Math.min(255, Math.max(0, Math.round(harm[gi + c] + hfLum)));
    }
  }
}

function scoreSparkleAtBox(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  size: number,
  gxT: Float32Array,
  gyT: Float32Array,
  normT: number
): number {
  if (x0 < 1 || y0 < 1 || x0 + size + 1 >= width || y0 + size + 1 >= height) return -1;
  let dot = 0;
  let normI = 0;
  for (let dy = 1; dy < size - 1; dy++) {
    const rowY = y0 + dy;
    const tOff = dy * size;
    for (let dx = 1; dx < size - 1; dx++) {
      const colX = x0 + dx;
      const pL = (rowY * width + colX - 1) * 4;
      const pR = (rowY * width + colX + 1) * 4;
      const pU = ((rowY - 1) * width + colX) * 4;
      const pD = ((rowY + 1) * width + colX) * 4;
      const gx = (0.299 * (rgba[pR] - rgba[pL]) + 0.587 * (rgba[pR + 1] - rgba[pL + 1]) + 0.114 * (rgba[pR + 2] - rgba[pL + 2])) * 0.5;
      const gy = (0.299 * (rgba[pD] - rgba[pU]) + 0.587 * (rgba[pD + 1] - rgba[pU + 1]) + 0.114 * (rgba[pD + 2] - rgba[pU + 2])) * 0.5;
      dot += gx * gxT[tOff + dx] + gy * gyT[tOff + dx];
      normI += gx * gx + gy * gy;
    }
  }
  if (normI <= 800) return -1;
  return dot / (Math.sqrt(normI) * normT + 1e-6);
}

/**
 * Fast precomputed-gradient off-grid 4-pointed Gemini sparkle detector & cleaner.
 * Supports panning sparkles across wider corner bands + Dual Safety Gates against black pits.
 */
export function rescueOffGridSparkle(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { preferHarmonicHeal?: boolean; minScore?: number; roiWidth?: number; roiHeight?: number }
): SparkleLockBox | null {
  if (width < 40 || height < 40) return null;

  const roiW = Math.min(width, options?.roiWidth ?? Math.max(180, Math.round(width * 0.36)));
  const roiH = Math.min(height, options?.roiHeight ?? Math.max(160, Math.round(height * 0.32)));
  const roiX = Math.max(0, width - roiW);
  const roiY = Math.max(0, height - roiH);
  if (roiW < 28 || roiH < 28) return null;

  const roiLum = new Float32Array(roiW * roiH);
  for (let ry = 0; ry < roiH; ry++) {
    const rowP = (roiY + ry) * width * 4;
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

  const sizes = [24, 32, 36, 40, 44, 48, 56];
  const minScore = options?.minScore ?? 0.32;
  let best: { score: number; x: number; y: number; size: number } | null = null;

  for (const size of sizes) {
    if (size + 6 > roiW || size + 6 > roiH) continue;
    const { gx: gxT, gy: gyT, norm: normT } = getSparkleTemplateEntry(size, 0, 0);
    if (normT <= 1e-6) continue;

    const maxRx = roiW - size - 2;
    const maxRy = roiH - size - 2;

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
        if (score >= minScore && (!best || score > best.score)) {
          best = { score, x: roiX + rx0, y: roiY + ry0, size };
        }
      }
    }
  }

  if (!best) return null;

  // Subpixel alignment refinement around best match (require clear improvement before moving off integer grid)
  let bestSx = 0;
  let bestSy = 0;
  let bestScore = best.score;
  for (const sx of [-0.4, 0, 0.4]) {
    for (const sy of [-0.4, 0, 0.4]) {
      if (sx === 0 && sy === 0) continue;
      const ent = getSparkleTemplateEntry(best.size, sx, sy);
      const sc = scoreSparkleAtBox(rgba, width, height, best.x, best.y, best.size, ent.gx, ent.gy, ent.norm);
      if (sc > bestScore + 0.01) {
        bestScore = sc;
        bestSx = sx;
        bestSy = sy;
      }
    }
  }

  const finalEntry = getSparkleTemplateEntry(best.size, bestSx, bestSy);
  const safety = evaluateSparkleCandidateSafety(
    rgba,
    width,
    best.x,
    best.y,
    best.size,
    finalEntry.tpl,
    finalEntry.gx,
    finalEntry.gy,
    finalEntry.norm,
    bestScore
  );
  if (!safety.valid) return null;

  const isOffGridScale = best.size !== 24 && best.size !== 48;
  const useHarmonicHeal = Boolean(options?.preferHarmonicHeal || isOffGridScale);

  if (useHarmonicHeal) {
    healSparkleAnisotropicHarmonic(
      rgba,
      width,
      height,
      best.x,
      best.y,
      best.size,
      Math.min(0.70, Math.max(0.56, safety.gain)),
      bestSx,
      bestSy
    );
  } else {
    unblendSparkleBox(rgba, width, best.x, best.y, best.size, safety.gain, bestSx, bestSy);
  }

  return {
    x: best.x,
    y: best.y,
    size: best.size,
    gain: Number(safety.gain.toFixed(2)),
    sx: bestSx,
    sy: bestSy,
    vx: 0,
    vy: 0,
    useHarmonicHeal,
  };
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
 * plus off-grid/cropped/video 4-point star rescue (supports Image, GIF frames, and Video frames uniformly).
 */
export function eraseGeminiSparklePixelData(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options?: {
    cornerHint?: WatermarkCornerPreset;
    forceRescue?: boolean;
    preferHarmonicHeal?: boolean;
    roiWidth?: number;
    roiHeight?: number;
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
  let rescueMatch: SparkleLockBox | null = null;
  let lockBox: SparkleLockBox | null = null;

  // Check raw off-grid / scaled star first when preferHarmonicHeal (video frames) or keep snapshot in case @pilio guesses badly
  const snapshotCopy = new Uint8ClampedArray(workRgba);

  if (options?.preferHarmonicHeal) {
    rescueMatch = rescueOffGridSparkle(workRgba, width, height, {
      preferHarmonicHeal: true,
      minScore: 0.42,
      roiWidth: options.roiWidth,
      roiHeight: options.roiHeight,
    });
    if (rescueMatch) {
      applied = true;
      decisionTier = 'video-star-harmonic';
      alphaGain = rescueMatch.gain;
      lockBox = rescueMatch;
    }
  }

  if (!rescueMatch) {
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
          lockBox = { x: pos.x, y: pos.y, size: pos.width, gain: gainVal, vx: 0, vy: 0 };
        }
      }

      const selDebug = (result?.meta as any)?.selectionDebug;
      const origGradScore = (result?.meta as any)?.detection?.originalGradientScore ?? 1;
      const isConfirmed = Boolean((result?.meta as any)?.presenceConfirmed);
      const pilioLowConfidence = !isConfirmed && origGradScore < 0.22;
      const pilioSuspectDark = Boolean(selDebug?.tooDark) && !isConfirmed && origGradScore < 0.28;

      const shouldCheckRescue =
        options?.forceRescue ||
        !removeFn ||
        !applied ||
        pilioLowConfidence ||
        pilioSuspectDark ||
        (result?.meta as any)?.qualityStatus === 'visible-residual' ||
        selDebug?.tooDark;

      if (shouldCheckRescue) {
        // Restore pre-@pilio pixels if @pilio made an unconfirmed/dark guess so star-rescue reads intact edges
        if (pilioLowConfidence || pilioSuspectDark) {
          const fallbackCopy = new Uint8ClampedArray(workRgba);
          workRgba.set(snapshotCopy);
          rescueMatch = rescueOffGridSparkle(workRgba, width, height, {
            preferHarmonicHeal: options?.preferHarmonicHeal,
            roiWidth: options?.roiWidth,
            roiHeight: options?.roiHeight,
          });
          if (rescueMatch) {
            applied = true;
            decisionTier = 'star-rescue';
            lockBox = rescueMatch;
          } else {
            // Keep @pilio result only if it was not dark-corrupted
            if (!pilioSuspectDark) {
              workRgba.set(fallbackCopy);
            } else {
              applied = false;
              lockBox = null;
            }
          }
        } else {
          rescueMatch = rescueOffGridSparkle(workRgba, width, height, {
            preferHarmonicHeal: options?.preferHarmonicHeal,
            roiWidth: options?.roiWidth,
            roiHeight: options?.roiHeight,
          });
          if (rescueMatch) {
            applied = true;
            decisionTier = `${decisionTier || 'auto'}+star-rescue`;
            lockBox = rescueMatch;
          }
        }
      }
    } catch {
      workRgba.set(snapshotCopy);
      rescueMatch = rescueOffGridSparkle(workRgba, width, height, {
        preferHarmonicHeal: options?.preferHarmonicHeal,
        roiWidth: options?.roiWidth,
        roiHeight: options?.roiHeight,
      });
      if (rescueMatch) {
        applied = true;
        decisionTier = 'star-rescue';
        lockBox = rescueMatch;
      }
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
 * Tracks and erases a locked sparkle across sequential Video/GIF frames within a fast +-10px search window.
 * Follows panning/floating watermarks smoothly (<2ms/frame) and pauses safely during temporary occlusions.
 */
export function applyLockedCornerUnblend(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  lockBox: SparkleLockBox,
  cornerHint: WatermarkCornerPreset = 'auto'
): boolean {
  const needsOrient = cornerHint !== 'auto' && cornerHint !== 'bottom-right';
  const workRgba = needsOrient ? transformCornerToBottomRight(rgba, width, height, cornerHint) : rgba;

  const size = lockBox.size;
  const sx = lockBox.sx ?? 0;
  const sy = lockBox.sy ?? 0;
  const ent = getSparkleTemplateEntry(size, sx, sy);

  const predX = Math.round(lockBox.x + (lockBox.vx ?? 0));
  const predY = Math.round(lockBox.y + (lockBox.vy ?? 0));

  let bestScore = -1;
  let bestX = predX;
  let bestY = predY;

  // Fast coarse->fine local tracking within +-20px horizontally, +-10px vertically
  const searchRx = 20;
  const searchRy = 10;
  for (let dy = -searchRy; dy <= searchRy; dy += 2) {
    for (let dx = -searchRx; dx <= searchRx; dx += 2) {
      const sc = scoreSparkleAtBox(workRgba, width, height, predX + dx, predY + dy, size, ent.gx, ent.gy, ent.norm);
      if (sc > bestScore) {
        bestScore = sc;
        bestX = predX + dx;
        bestY = predY + dy;
      }
    }
  }
  const cX = bestX;
  const cY = bestY;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const sc = scoreSparkleAtBox(workRgba, width, height, cX + dx, cY + dy, size, ent.gx, ent.gy, ent.norm);
      if (sc > bestScore) {
        bestScore = sc;
        bestX = cX + dx;
        bestY = cY + dy;
      }
    }
  }

  let erased = false;
  if (bestScore >= 0.34) {
    // Update smoothed velocity + locked coordinates
    const instVx = bestX - lockBox.x;
    const instVy = bestY - lockBox.y;
    lockBox.vx = (lockBox.vx ?? 0) * 0.4 + instVx * 0.6;
    lockBox.vy = (lockBox.vy ?? 0) * 0.4 + instVy * 0.6;
    lockBox.x = bestX;
    lockBox.y = bestY;

    if (lockBox.useHarmonicHeal) {
      healSparkleAnisotropicHarmonic(
        workRgba,
        width,
        height,
        bestX,
        bestY,
        size,
        Math.min(0.70, Math.max(0.56, lockBox.gain ?? 0.62)),
        sx,
        sy
      );
    } else {
      unblendSparkleBox(workRgba, width, bestX, bestY, size, lockBox.gain, sx, sy);
    }
    erased = true;
  } else {
    // Momentarily occluded (e.g. moving chain/foreground): coast predicted coordinate safely without dark smear
    lockBox.x = Math.max(1, Math.min(width - size - 2, predX));
    lockBox.y = Math.max(1, Math.min(height - size - 2, predY));
  }

  if (needsOrient && erased) {
    rgba.set(transformCornerToBottomRight(workRgba, width, height, cornerHint));
  } else if (workRgba !== rgba && erased) {
    rgba.set(workRgba);
  }
  return erased;
}

/**
 * Automatically detects and removes translucent corner wordmark overlays (such as Google Veo)
 * using isolated stroke contrast & directional harmonic letter reconstruction.
 */
export function eraseCornerTextBadgePixelData(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  cornerHint: WatermarkCornerPreset = 'auto',
  refHeight?: number
): CornerTextRemovalResult {
  const effectiveHeight = refHeight ?? height;
  if (width < 220 || effectiveHeight < 200 || height < 40) return { applied: false };

  const effectiveCorner = cornerHint === 'auto' ? 'bottom-right' : cornerHint;
  const needsOrient = effectiveCorner !== 'bottom-right';
  const workRgba = needsOrient ? transformCornerToBottomRight(rgba, width, height, effectiveCorner) : rgba;

  const scale = Math.max(0.65, Math.min(2.2, effectiveHeight / 720));
  const rx0 = Math.max(0, width - Math.round(48 * scale));
  const rx1 = Math.max(rx0 + 16, width - Math.round(5 * scale));
  const ry0 = Math.max(0, height - Math.round(32 * scale));
  const ry1 = Math.max(ry0 + 10, height - Math.round(10 * scale));
  const rw = rx1 - rx0 + 1;
  const rh = ry1 - ry0 + 1;

  const mask = new Uint8Array(rw * rh);
  let cnt = 0;
  let minX = rw;
  let maxX = 0;
  let minY = rh;
  let maxY = 0;
  const fOffY = Math.max(3, Math.round(4 * scale));
  const fOffX = Math.max(3, Math.round(4 * scale));

  for (let y = 2; y < rh - 2; y++) {
    for (let x = 2; x < rw - 2; x++) {
      const p = ((ry0 + y) * width + (rx0 + x)) * 4;
      const r = workRgba[p];
      const g = workRgba[p + 1];
      const b = workRgba[p + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 32) continue;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;

      const pT = (Math.max(0, ry0 + y - fOffY) * width + (rx0 + x)) * 4;
      const pB = (Math.min(height - 1, ry0 + y + fOffY) * width + (rx0 + x)) * 4;
      const lT = 0.299 * workRgba[pT] + 0.587 * workRgba[pT + 1] + 0.114 * workRgba[pT + 2];
      const lB = 0.299 * workRgba[pB] + 0.587 * workRgba[pB + 1] + 0.114 * workRgba[pB + 2];

      const pL = ((ry0 + y) * width + Math.max(0, rx0 + x - fOffX)) * 4;
      const pR = ((ry0 + y) * width + Math.min(width - 1, rx0 + x + fOffX)) * 4;
      const lL = 0.299 * workRgba[pL] + 0.587 * workRgba[pL + 1] + 0.114 * workRgba[pL + 2];
      const lR = 0.299 * workRgba[pR] + 0.587 * workRgba[pR + 1] + 0.114 * workRgba[pR + 2];

      if (lum - (lT + lB) * 0.5 > 16 && lum - Math.min(lT, lB) > 12 && lum - Math.min(lL, lR) > 10) {
        mask[y * rw + x] = 1;
        cnt++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (
    cnt < Math.round(25 * scale * scale) ||
    bw < Math.round(14 * scale) ||
    bw > Math.round(38 * scale) ||
    bh < Math.round(5 * scale) ||
    bh > Math.round(16 * scale)
  ) {
    return { applied: false };
  }

  const dil = new Uint8Array(rw * rh);
  for (let y = Math.max(1, minY); y <= Math.min(rh - 2, maxY); y++) {
    for (let x = Math.max(1, minX); x <= Math.min(rw - 2, maxX); x++) {
      if (mask[y * rw + x]) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) dil[(y + dy) * rw + (x + dx)] = 1;
        }
      }
    }
  }

  const state = new Uint8Array(dil);
  for (let pass = 0; pass < 10; pass++) {
    const resolved: number[] = [];
    for (let y = Math.max(0, minY - 1); y <= Math.min(rh - 1, maxY + 1); y++) {
      for (let x = Math.max(0, minX - 1); x <= Math.min(rw - 1, maxX + 1); x++) {
        const idx = y * rw + x;
        if (!state[idx]) continue;
        let rs = 0;
        let gs = 0;
        let bs = 0;
        let ws = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= rh) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= rw || state[ny * rw + nx]) continue;
            const wt = 1 / (1 + Math.hypot(dx, dy));
            const p = ((ry0 + ny) * width + (rx0 + nx)) * 4;
            rs += workRgba[p] * wt;
            gs += workRgba[p + 1] * wt;
            bs += workRgba[p + 2] * wt;
            ws += wt;
          }
        }
        if (ws > 0) {
          const p = ((ry0 + y) * width + (rx0 + x)) * 4;
          workRgba[p] = Math.round(rs / ws);
          workRgba[p + 1] = Math.round(gs / ws);
          workRgba[p + 2] = Math.round(bs / ws);
          resolved.push(idx);
        }
      }
    }
    for (const r of resolved) state[r] = 0;
    if (resolved.length === 0) break;
  }

  if (needsOrient) {
    rgba.set(transformCornerToBottomRight(workRgba, width, height, effectiveCorner));
  } else if (workRgba !== rgba) {
    rgba.set(workRgba);
  }

  return {
    applied: true,
    box: { x: rx0 + minX, y: ry0 + minY, width: bw, height: bh },
    pixelCount: cnt,
  };
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
  const lumaScale = noiseScale * (mode === 'aggressive' ? 0.55 : 0.35);
  const stride = w * 4;
  let hasTransparency = false;

  // Fast xorshift32 PRNG avoids per-pixel Math.random() calls across 720p video frames (~4x speedup)
  let rngState = (w * 73856093) ^ (h * 19349663) ^ 0x9e3779b9;
  const nextRand = () => {
    rngState ^= rngState << 13;
    rngState ^= rngState >>> 17;
    rngState ^= rngState << 5;
    return (rngState >>> 0) / 4294967296;
  };

  for (let y = 1; y < h - 1; y++) {
    const rowOffset = y * stride;
    const prevRow = rowOffset - stride;
    const nextRow = rowOffset + stride;
    for (let x = 1; x < w - 1; x++) {
      const idx = rowOffset + x * 4;
      const r = src[idx];
      const g = src[idx + 1];
      const b = src[idx + 2];

      let sumR = r;
      let sumG = g;
      let sumB = b;
      let totalW = 1.0;

      // Unrolled 8 surrounding taps avoiding nested inner loops for V8 hot-path speed
      const offsets = [
        prevRow + (x - 1) * 4,
        prevRow + x * 4,
        prevRow + (x + 1) * 4,
        idx - 4,
        idx + 4,
        nextRow + (x - 1) * 4,
        nextRow + x * 4,
        nextRow + (x + 1) * 4,
      ];
      for (let t = 0; t < 8; t++) {
        const nIdx = offsets[t];
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

      const invW = 1.0 / totalW;
      let outR = sumR * invW;
      let outG = sumG * invW;
      let outB = sumB * invW;

      if (nextRand() < ditherProb) {
        const jChroma = (nextRand() - 0.5) * noiseScale;
        const jLuma = (nextRand() - 0.5) * lumaScale;
        outR += jChroma + jLuma;
        outG += jLuma;
        outB += -jChroma + jLuma;
      }

      output[idx] = outR < 0 ? 0 : outR > 255 ? 255 : (outR + 0.5) | 0;
      output[idx + 1] = outG < 0 ? 0 : outG > 255 ? 255 : (outG + 0.5) | 0;
      output[idx + 2] = outB < 0 ? 0 : outB > 255 ? 255 : (outB + 0.5) | 0;
    }
  }

  for (let i = 3; i < src.length; i += 64) {
    if (src[i] < 255) {
      hasTransparency = true;
      break;
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
