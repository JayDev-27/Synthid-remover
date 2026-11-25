import { GifReader, GifWriter } from 'omggif';
import { scanUint8ArrayProvenance, ProvenanceAuditResult } from './provenanceScanner';
import {
  loadGeminiWatermarkRemoverSync,
  eraseGeminiSparklePixelData,
  eraseCornerTextBadgePixelData,
  applyLockedCornerUnblend,
  applyBilateralCarrierDisruptionRgba,
  applyMedianFilter3x3Rgba,
  applyAnisotropicCoordinateShiftRgba,
  inpaintMaskOnRgba,
  DisruptionMode,
  WatermarkCornerPreset,
  SparkleLockBox,
} from './pixelPipeline';

export interface DecodedGifFrame {
  rgba: Uint8ClampedArray;
  delay: number; // Delay in centiseconds (1/100s)
}

export interface GifMaskData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface GifProcessingOptions {
  stripMetadata?: boolean;
  disruptSignals?: boolean;
  disruptionMode?: DisruptionMode;
  disruptionStrength?: number; // 1 to 100, default: 75
  removeVisibleBadge?: boolean;
  cornerHint?: WatermarkCornerPreset;
  maskRgba?: GifMaskData | null;
  onProgress?: (info: { currentFrame: number; totalFrames: number; phase: string; percent: number }) => void;
}

export interface GifTelemetry {
  originalSize: number;
  processedSize: number;
  dimensions: { width: number; height: number };
  frameCount: number;
  metadataStripped: boolean;
  signalsDisrupted: boolean;
  disruptionMode: DisruptionMode;
  badgeRemoved: boolean;
  maskApplied: boolean;
  provenanceAudit: ProvenanceAuditResult;
  executionTimeMs: number;
  logs: string[];
}

/**
 * Safely encodes a Uint8Array to base64 without overflowing call stack on large animated GIFs.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

/**
 * Decodes an animated or static GIF into full-canvas composited RGBA frames while honoring
 * GIF disposal methods (restore background = 2, restore previous = 3) and timing delays.
 */
export function decodeGifToFrames(bytes: Uint8Array): {
  width: number;
  height: number;
  loopCount: number | null;
  frames: DecodedGifFrame[];
} {
  const reader = new GifReader(bytes);
  const frameCount = reader.numFrames();
  if (frameCount <= 0) {
    throw new Error('GIF container does not contain any visual frames.');
  }

  const width = reader.width;
  const height = reader.height;
  const loopCount = reader.loopCount();
  const composited = new Uint8ClampedArray(width * height * 4);
  const previousSnapshot = new Uint8ClampedArray(width * height * 4);
  const frames: DecodedGifFrame[] = [];

  for (let i = 0; i < frameCount; i++) {
    const info = reader.frameInfo(i);

    if (i > 0) {
      const prevInfo = reader.frameInfo(i - 1);
      if (prevInfo.disposal === 2) {
        for (let y = prevInfo.y; y < prevInfo.y + prevInfo.height; y++) {
          for (let x = prevInfo.x; x < prevInfo.x + prevInfo.width; x++) {
            if (x < 0 || x >= width || y < 0 || y >= height) continue;
            const p = (y * width + x) * 4;
            composited[p] = 0;
            composited[p + 1] = 0;
            composited[p + 2] = 0;
            composited[p + 3] = 0;
          }
        }
      } else if (prevInfo.disposal === 3) {
        composited.set(previousSnapshot);
      }
    }

    if (info.disposal === 3) {
      previousSnapshot.set(composited);
    }

    reader.decodeAndBlitFrameRGBA(i, composited);
    frames.push({
      rgba: new Uint8ClampedArray(composited),
      delay: info.delay > 0 ? info.delay : 8,
    });
  }

  return { width, height, loopCount, frames };
}

interface ColorSample {
  r: number;
  g: number;
  b: number;
}

/**
 * Quantizes an RGBA frame into an indexed 2..256 power-of-two palette via Median Cut + 15-bit LUT.
 */
function quantizeRgbaToGifPalette(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): { palette: number[]; indexed: Uint8Array; transparentIndex: number | null } {
  const pixelCount = width * height;
  const indexed = new Uint8Array(pixelCount);

  let hasTransparency = false;
  const samples: ColorSample[] = [];
  const stride = Math.max(1, Math.floor(pixelCount / 12000));

  for (let i = 0; i < pixelCount; i++) {
    const p = i * 4;
    if (rgba[p + 3] < 128) {
      hasTransparency = true;
    } else if (i % stride === 0) {
      samples.push({ r: rgba[p], g: rgba[p + 1], b: rgba[p + 2] });
    }
  }

  if (!hasTransparency && samples.length === 0) {
    samples.push({ r: 0, g: 0, b: 0 });
  }

  const maxColors = hasTransparency ? 255 : 256;
  const boxes: ColorSample[][] = samples.length > 0 ? [samples] : [];

  while (boxes.length > 0 && boxes.length < maxColors) {
    let splitIdx = -1;
    let bestSpan = -1;
    let bestChannel: 'r' | 'g' | 'b' = 'r';

    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b];
      if (box.length < 2) continue;
      let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
      for (let j = 0; j < box.length; j++) {
        const c = box[j];
        if (c.r < rMin) rMin = c.r;
        if (c.r > rMax) rMax = c.r;
        if (c.g < gMin) gMin = c.g;
        if (c.g > gMax) gMax = c.g;
        if (c.b < bMin) bMin = c.b;
        if (c.b > bMax) bMax = c.b;
      }
      const rSpan = rMax - rMin;
      const gSpan = gMax - gMin;
      const bSpan = bMax - bMin;
      const maxSpan = Math.max(rSpan, gSpan, bSpan);
      if (maxSpan > bestSpan && maxSpan > 0) {
        bestSpan = maxSpan;
        splitIdx = b;
        bestChannel = rSpan === maxSpan ? 'r' : gSpan === maxSpan ? 'g' : 'b';
      }
    }

    if (splitIdx === -1) break;
    const target = boxes.splice(splitIdx, 1)[0];
    target.sort((a, b) => a[bestChannel] - b[bestChannel]);
    const mid = Math.floor(target.length / 2);
    boxes.push(target.slice(0, mid), target.slice(mid));
  }

  const paletteColors: ColorSample[] = [];
  const rawPalette: number[] = [];

  if (hasTransparency) {
    paletteColors.push({ r: 0, g: 0, b: 0 });
    rawPalette.push(0x000000);
  }

  for (const box of boxes) {
    let rs = 0, gs = 0, bs = 0;
    for (let j = 0; j < box.length; j++) {
      rs += box[j].r;
      gs += box[j].g;
      bs += box[j].b;
    }
    const r = Math.round(rs / box.length);
    const g = Math.round(gs / box.length);
    const b = Math.round(bs / box.length);
    paletteColors.push({ r, g, b });
    rawPalette.push((r << 16) | (g << 8) | b);
  }

  // Pad to valid power-of-2 length [2..256] required by omggif GifWriter
  let targetPow2 = 2;
  while (targetPow2 < rawPalette.length && targetPow2 < 256) {
    targetPow2 <<= 1;
  }
  while (rawPalette.length < targetPow2) {
    rawPalette.push(0x000000);
  }

  const lut = new Int16Array(32768).fill(-1);
  const startPaletteIdx = hasTransparency ? 1 : 0;

  for (let i = 0; i < pixelCount; i++) {
    const p = i * 4;
    if (hasTransparency && rgba[p + 3] < 128) {
      indexed[i] = 0;
      continue;
    }
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let idx = lut[key];
    if (idx === -1) {
      let bestDist = Infinity;
      idx = startPaletteIdx;
      for (let c = startPaletteIdx; c < paletteColors.length; c++) {
        const pc = paletteColors[c];
        const dr = r - pc.r;
        const dg = g - pc.g;
        const db = b - pc.b;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          idx = c;
          if (dist === 0) break;
        }
      }
      lut[key] = idx;
    }
    indexed[i] = idx;
  }

  return {
    palette: rawPalette,
    indexed,
    transparentIndex: hasTransparency ? 0 : null,
  };
}

function resizeMaskNearest(mask: GifMaskData, targetW: number, targetH: number): Uint8ClampedArray {
  if (mask.width === targetW && mask.height === targetH) return mask.data;
  const out = new Uint8ClampedArray(targetW * targetH * 4);
  for (let y = 0; y < targetH; y++) {
    const sy = Math.min(mask.height - 1, Math.floor((y * mask.height) / targetH));
    for (let x = 0; x < targetW; x++) {
      const sx = Math.min(mask.width - 1, Math.floor((x * mask.width) / targetW));
      const sp = (sy * mask.width + sx) * 4;
      const dp = (y * targetW + x) * 4;
      out[dp] = mask.data[sp];
      out[dp + 1] = mask.data[sp + 1];
      out[dp + 2] = mask.data[sp + 2];
      out[dp + 3] = mask.data[sp + 3];
    }
  }
  return out;
}

/**
 * Processes an animated or static GIF buffer cleanly across all frames:
 * applies per-frame brush mask inpainting, Reverse Alpha Blending (+ off-grid star rescue),
 * frequency/coordinate carrier disruption, and pure metadata-free GIF89a re-encoding.
 */
export async function processGifBuffer(
  inputBytes: Uint8Array,
  options: GifProcessingOptions = {}
): Promise<{ bytes: Uint8Array; base64Gif: string; telemetry: GifTelemetry }> {
  const startTime = Date.now();
  const logs: string[] = [];

  const disruptionMode = options.disruptionMode || 'balanced';
  const disruptionStrength = options.disruptionStrength ?? 75;
  const isMetadataOnly = disruptionMode === 'metadata-only';
  const shouldRemoveBadge = options.removeVisibleBadge !== false && !isMetadataOnly;
  const shouldDisrupt = options.disruptSignals !== false && !isMetadataOnly;

  const initialAudit = scanUint8ArrayProvenance(inputBytes);
  logs.push(`[GIF] Received animated payload (${(inputBytes.length / 1024).toFixed(1)} KB) | Initial clean: ${initialAudit.clean}`);

  const decoded = decodeGifToFrames(inputBytes);
  const { width, height, loopCount, frames } = decoded;
  logs.push(`[GIF] Decoded ${frames.length} frame(s) at ${width}x${height}px | Mode: ${disruptionMode.toUpperCase()}`);

  const removerFn = shouldRemoveBadge ? await loadGeminiWatermarkRemoverSync() : null;
  const scaledMask = options.maskRgba ? resizeMaskNearest(options.maskRgba, width, height) : null;

  // Allocate generous output buffer with dynamic expansion guard inside frame loop
  let outBuf = new Uint8Array(Math.max(512 * 1024, width * height * frames.length * 2 + 131072));
  const writer = new GifWriter(outBuf, width, height, { loop: loopCount ?? 0 });

  let badgeAppliedCount = 0;
  let maskAppliedPixels = 0;
  let lockedSparkleBox: SparkleLockBox | null = null;
  let keyframeProbed = false;

  for (let i = 0; i < frames.length; i++) {
    let workRgba: Uint8ClampedArray = new Uint8ClampedArray(frames[i].rgba);

    if (scaledMask) {
      const patched = inpaintMaskOnRgba(workRgba, width, height, scaledMask);
      if (patched > 0) maskAppliedPixels = Math.max(maskAppliedPixels, patched);
    }

    if (shouldRemoveBadge) {
      // Probe full detector on Frame 0 (or periodically if unlocked), then track + erase per frame
      if (!keyframeProbed || (!lockedSparkleBox && (i % 12 === 0 || i === Math.floor(frames.length / 2)))) {
        const badgeMeta = eraseGeminiSparklePixelData(workRgba, width, height, {
          removerSyncFn: removerFn,
          cornerHint: options.cornerHint || 'auto',
          forceRescue: true,
          preferHarmonicHeal: frames.length > 1,
        });
        keyframeProbed = true;
        if (badgeMeta.applied) {
          badgeAppliedCount++;
          lockedSparkleBox = badgeMeta.lockBox || null;
        }
      } else if (lockedSparkleBox) {
        if (applyLockedCornerUnblend(workRgba, width, height, lockedSparkleBox, options.cornerHint || 'auto')) {
          badgeAppliedCount++;
        }
      }
      if (eraseCornerTextBadgePixelData(workRgba, width, height, options.cornerHint || 'auto').applied) {
        badgeAppliedCount = Math.max(badgeAppliedCount, 1);
      }
    }

    if (shouldDisrupt) {
      const sigmaR = disruptionMode === 'aggressive' ? 16 : 12;
      const noiseScale =
        disruptionMode === 'aggressive'
          ? (disruptionStrength / 100) * 1.8
          : (disruptionStrength / 100) * 1.2;

      const { output: bilateral } = applyBilateralCarrierDisruptionRgba(
        workRgba,
        width,
        height,
        sigmaR,
        noiseScale,
        disruptionMode
      );
      workRgba = bilateral;

      if (disruptionMode === 'aggressive' && width >= 3 && height >= 3) {
        workRgba = applyMedianFilter3x3Rgba(workRgba, width, height);
      }

      const scaleX = disruptionMode === 'aggressive' ? 0.968 : 0.985;
      const scaleY = disruptionMode === 'aggressive' ? 0.962 : 0.980;
      workRgba = applyAnisotropicCoordinateShiftRgba(workRgba, width, height, scaleX, scaleY);
    }

    const { palette, indexed, transparentIndex } = quantizeRgbaToGifPalette(workRgba, width, height);

    // Grow writer buffer dynamically if approaching 75% capacity
    const curPos = (writer as any).getOutputBufferPosition?.() ?? 0;
    const neededFloor = curPos + width * height * 2 + 16384;
    if (neededFloor > outBuf.length) {
      const grown = new Uint8Array(Math.max(outBuf.length * 2, neededFloor));
      grown.set(outBuf.subarray(0, curPos));
      outBuf = grown;
      (writer as any).setOutputBuffer?.(outBuf);
    }

    writer.addFrame(0, 0, width, height, indexed, {
      palette,
      delay: frames[i].delay,
      disposal: transparentIndex !== null ? 2 : 1,
      ...(transparentIndex !== null ? { transparent: transparentIndex } : {}),
    });

    if (options.onProgress) {
      options.onProgress({
        currentFrame: i + 1,
        totalFrames: frames.length,
        phase: scaledMask ? 'Inpainting & scrubbing GIF frames' : 'Scrubbing GIF frames',
        percent: Math.round(((i + 1) / frames.length) * 100),
      });
    }

    if (typeof window !== 'undefined' && i < frames.length - 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const totalLen = writer.end();
  const outputBytes = outBuf.slice(0, totalLen);

  if (maskAppliedPixels > 0) {
    logs.push(`[SUCCESS] Visual brush mask reconstructed across all ${frames.length} GIF frames (${maskAppliedPixels} masked px/frame).`);
  }
  if (badgeAppliedCount > 0) {
    logs.push(`[SUCCESS] Corner badge erasure applied across ${badgeAppliedCount}/${frames.length} GIF frames.`);
  }
  if (shouldDisrupt) {
    logs.push(`[SUCCESS] Per-frame spatial carrier disruption & anisotropic desynchronization completed.`);
  }
  if (options.stripMetadata !== false) {
    logs.push(`[SUCCESS] Re-encoded pristine GIF89a container without Comment/XMP/C2PA extension blocks.`);
  }

  const provenanceAudit = scanUint8ArrayProvenance(outputBytes);
  logs.push(`[AUDIT] Scanned ${provenanceAudit.bytesScanned} bytes (GIF): C2PA=${provenanceAudit.c2paFound ? 'FOUND' : 'CLEAN'}, EXIF=${provenanceAudit.exifFound ? 'FOUND' : 'CLEAN'}, XMP=${provenanceAudit.xmpFound ? 'FOUND' : 'CLEAN'}`);

  const executionTimeMs = Date.now() - startTime;
  logs.push(`[COMPLETE] Animated GIF pipeline finished in ${executionTimeMs}ms.`);

  const base64Gif = `data:image/gif;base64,${uint8ArrayToBase64(outputBytes)}`;

  return {
    bytes: outputBytes,
    base64Gif,
    telemetry: {
      originalSize: inputBytes.length,
      processedSize: outputBytes.length,
      dimensions: { width, height },
      frameCount: frames.length,
      metadataStripped: options.stripMetadata !== false,
      signalsDisrupted: shouldDisrupt,
      disruptionMode,
      badgeRemoved: badgeAppliedCount > 0 || maskAppliedPixels > 0,
      maskApplied: maskAppliedPixels > 0,
      provenanceAudit,
      executionTimeMs,
      logs,
    },
  };
}

/**
 * Extracts a single frame from an animated/static GIF File as a PNG data URL
 * so Visual Brush Inpaint can display and mask specific frames cleanly.
 */
export async function extractGifFramePreview(
  file: File,
  frameIndex: number = 0
): Promise<{ dataUrl: string; width: number; height: number; frameCount: number }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const decoded = decodeGifToFrames(bytes);
  const clampedIdx = Math.max(0, Math.min(decoded.frames.length - 1, frameIndex));
  const frame = decoded.frames[clampedIdx];

  const canvas = document.createElement('canvas');
  canvas.width = decoded.width;
  canvas.height = decoded.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create canvas context for GIF frame preview');

  const imgData = new ImageData(new Uint8ClampedArray(frame.rgba), decoded.width, decoded.height);
  ctx.putImageData(imgData, 0, 0);

  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: decoded.width,
    height: decoded.height,
    frameCount: decoded.frames.length,
  };
}

/**
 * Browser-side File wrapper for GIF processing (supports optional Blob mask from InpaintCanvas).
 */
export async function processGifClientSide(
  file: File,
  options: Omit<GifProcessingOptions, 'maskRgba'> & { maskBlob?: Blob | null } = {}
): Promise<{ base64Image: string; blob: Blob; telemetry: GifTelemetry }> {
  const inputBytes = new Uint8Array(await file.arrayBuffer());
  let maskRgba: GifMaskData | null = null;

  if (options.maskBlob) {
    const maskImg = new Image();
    const maskUrl = URL.createObjectURL(options.maskBlob);
    await new Promise((resolve, reject) => {
      maskImg.onload = resolve;
      maskImg.onerror = reject;
      maskImg.src = maskUrl;
    });
    URL.revokeObjectURL(maskUrl);

    const canvas = document.createElement('canvas');
    canvas.width = maskImg.naturalWidth || maskImg.width;
    canvas.height = maskImg.naturalHeight || maskImg.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(maskImg, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      maskRgba = { width: canvas.width, height: canvas.height, data: data.data };
    }
  }

  const res = await processGifBuffer(inputBytes, {
    ...options,
    maskRgba,
  });

  const arrayBuf = res.bytes.buffer.slice(res.bytes.byteOffset, res.bytes.byteOffset + res.bytes.byteLength) as ArrayBuffer;
  return {
    base64Image: res.base64Gif,
    blob: new Blob([arrayBuf], { type: 'image/gif' }),
    telemetry: res.telemetry,
  };
}
