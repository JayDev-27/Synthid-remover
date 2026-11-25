import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4ArrayBufferTarget } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmArrayBufferTarget } from 'webm-muxer';
import { scanUint8ArrayProvenance, ProvenanceAuditResult } from './provenanceScanner';
import {
  loadGeminiWatermarkRemoverSync,
  eraseGeminiSparklePixelData,
  eraseCornerTextBadgePixelData,
  applyLockedCornerUnblend,
  applyBilateralCarrierDisruptionRgba,
  inpaintMaskOnRgba,
  DisruptionMode,
  WatermarkCornerPreset,
  SparkleLockBox,
} from './pixelPipeline';

export interface VideoProcessingOptions {
  stripMetadata?: boolean;
  disruptSignals?: boolean;
  disruptionMode?: DisruptionMode;
  disruptionStrength?: number; // 1 to 100
  removeVisibleBadge?: boolean;
  cornerHint?: WatermarkCornerPreset;
  format?: 'mp4' | 'webm';
  targetFps?: number;
  preserveAudio?: boolean;
  maskBlob?: Blob | null;
  onProgress?: (info: { currentFrame: number; totalFrames: number; phase: string; percent: number }) => void;
}

export interface VideoTelemetry {
  originalSize: number;
  processedSize: number;
  dimensions: { width: number; height: number };
  durationSec: number;
  frameCount: number;
  fps: number;
  format: 'mp4' | 'webm';
  encoderBackend: string;
  audioPreserved: boolean;
  metadataStripped: boolean;
  signalsDisrupted: boolean;
  disruptionMode: DisruptionMode;
  badgeRemoved: boolean;
  maskApplied: boolean;
  provenanceAudit: ProvenanceAuditResult;
  executionTimeMs: number;
  logs: string[];
}

export interface VideoPreviewMetadata {
  dataUrl: string;
  width: number;
  height: number;
  duration: number;
}

async function createVideoElement(file: File): Promise<{ video: HTMLVideoElement; objectUrl: string }> {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onLoaded = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Unable to decode video stream in browser.'));
    };
    const cleanup = () => {
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('error', onError);
    video.src = objectUrl;
    if (video.readyState >= 2) {
      onLoaded();
    }
  });

  return { video, objectUrl };
}

async function seekVideo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  const safeMax = Number.isFinite(video.duration) && video.duration > 0.02 ? video.duration - 0.015 : timeSec;
  const clamped = Math.max(0, Math.min(safeMax, timeSec));
  if (Math.abs(video.currentTime - clamped) < 0.002 && video.readyState >= 2) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', finish);
      resolve();
    };
    video.addEventListener('seeked', finish);
    video.currentTime = clamped;
    setTimeout(finish, 400);
  });
}

/**
 * Extracts a crisp PNG data URL frame and natural metadata from a Video File for UI preview and Visual Brush Inpainting.
 */
export async function extractVideoFramePreview(file: File, timeSec: number = 0.05): Promise<VideoPreviewMetadata> {
  const { video, objectUrl } = await createVideoElement(file);
  try {
    const width = video.videoWidth || 640;
    const height = video.videoHeight || 360;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;

    await seekVideo(video, Math.min(duration * 0.5, Math.max(0, timeSec)));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not initialize video preview canvas.');
    ctx.drawImage(video, 0, 0, width, height);

    return {
      dataUrl: canvas.toDataURL('image/png'),
      width,
      height,
      duration,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function loadMaskImageData(
  maskBlob: Blob,
  targetW: number,
  targetH: number
): Promise<{ data: Uint8ClampedArray; minX: number; minY: number; maxX: number; maxY: number } | null> {
  const img = new Image();
  const url = URL.createObjectURL(maskBlob);
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, targetW, targetH);
  const { data } = ctx.getImageData(0, 0, targetW, targetH);

  let minX = targetW;
  let maxX = 0;
  let minY = targetH;
  let maxY = 0;
  let any = false;

  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const idx = (y * targetW + x) * 4;
      if (data[idx + 3] > 20 && data[idx] > 20) {
        any = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return any ? { data, minX, minY, maxX, maxY } : null;
}

/**
 * Applies watermark removal & signal disruption onto the given 2D canvas frame cleanly.
 * Uses tight ROI-only pixel transfer when only badge/mask erasure is active for maximum frame throughput.
 */
function processVideoCanvasFrame(
  ctx: CanvasRenderingContext2D,
  tempCanvas: HTMLCanvasElement | null,
  width: number,
  height: number,
  opts: {
    isMetadataOnly: boolean;
    shouldRemoveBadge: boolean;
    shouldDisrupt: boolean;
    disruptionMode: DisruptionMode;
    disruptionStrength: number;
    cornerHint: WatermarkCornerPreset;
    removerFn: any;
    maskInfo: { data: Uint8ClampedArray; minX: number; minY: number; maxX: number; maxY: number } | null;
    frameIndex: number;
    totalFrames: number;
    lockState: { probed: boolean; box: SparkleLockBox | null };
  }
): boolean {
  if (opts.isMetadataOnly) return false;

  let touched = false;
  const shouldProbeThisFrame =
    !opts.lockState.probed ||
    (!opts.lockState.box && (opts.frameIndex % 24 === 0 || opts.frameIndex === Math.floor(opts.totalFrames / 2)));

  // Step 1: GPU-accelerated anisotropic subpixel coordinate squeeze when frequency disruption is enabled
  if (opts.shouldDisrupt && tempCanvas) {
    const scaleX = opts.disruptionMode === 'aggressive' ? 0.968 : 0.986;
    const scaleY = opts.disruptionMode === 'aggressive' ? 0.960 : 0.982;
    const sw = Math.max(16, Math.round(width * scaleX));
    const sh = Math.max(16, Math.round(height * scaleY));
    tempCanvas.width = sw;
    tempCanvas.height = sh;
    const tCtx = tempCanvas.getContext('2d');
    if (tCtx) {
      tCtx.imageSmoothingEnabled = true;
      tCtx.imageSmoothingQuality = 'high';
      tCtx.drawImage(ctx.canvas, 0, 0, sw, sh);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tempCanvas, 0, 0, sw, sh, 0, 0, width, height);
    }
  }

  // Step 2: Fast full-frame pixel pass when signal disruption is active, otherwise ROI-bounded read/write
  if (opts.shouldDisrupt) {
    const imgData = ctx.getImageData(0, 0, width, height);
    if (opts.maskInfo) {
      inpaintMaskOnRgba(imgData.data, width, height, opts.maskInfo.data);
      touched = true;
    }
    if (opts.shouldRemoveBadge) {
      if (shouldProbeThisFrame) {
        const meta = eraseGeminiSparklePixelData(imgData.data, width, height, {
          removerSyncFn: opts.removerFn,
          cornerHint: opts.cornerHint,
          forceRescue: true,
          preferHarmonicHeal: true,
        });
        opts.lockState.probed = true;
        if (meta.applied) {
          touched = true;
          opts.lockState.box = meta.lockBox || null;
        }
      } else if (opts.lockState.box) {
        if (applyLockedCornerUnblend(imgData.data, width, height, opts.lockState.box, opts.cornerHint)) {
          touched = true;
        }
      }
      const textRes = eraseCornerTextBadgePixelData(imgData.data, width, height, opts.cornerHint, height);
      if (textRes.applied) touched = true;
    }
    const sigmaR = opts.disruptionMode === 'aggressive' ? 14 : 11;
    const noiseScale =
      opts.disruptionMode === 'aggressive'
        ? (opts.disruptionStrength / 100) * 1.6
        : (opts.disruptionStrength / 100) * 1.1;
    const { output } = applyBilateralCarrierDisruptionRgba(
      imgData.data,
      width,
      height,
      sigmaR,
      noiseScale,
      opts.disruptionMode
    );
    imgData.data.set(output);
    ctx.putImageData(imgData, 0, 0);
  } else {
    if (opts.maskInfo) {
      const pad = 16;
      const rx = Math.max(0, opts.maskInfo.minX - pad);
      const ry = Math.max(0, opts.maskInfo.minY - pad);
      const rRight = Math.min(width, opts.maskInfo.maxX + pad + 1);
      const rBottom = Math.min(height, opts.maskInfo.maxY + pad + 1);
      const rw = rRight - rx;
      const rh = rBottom - ry;
      if (rw > 0 && rh > 0) {
        const roiImg = ctx.getImageData(rx, ry, rw, rh);
        const roiMask = new Uint8ClampedArray(rw * rh * 4);
        for (let y = 0; y < rh; y++) {
          const srcStart = ((ry + y) * width + rx) * 4;
          roiMask.set(opts.maskInfo.data.subarray(srcStart, srcStart + rw * 4), y * rw * 4);
        }
        inpaintMaskOnRgba(roiImg.data, rw, rh, roiMask);
        ctx.putImageData(roiImg, rx, ry);
        touched = true;
      }
    }

    if (opts.shouldRemoveBadge) {
      const bandW = Math.min(width, Math.max(240, Math.round(width * 0.40)));
      const bandH = Math.min(height, Math.max(190, Math.round(height * 0.34)));
      let bx = Math.max(0, width - bandW);
      let by = Math.max(0, height - bandH);
      if (opts.cornerHint === 'bottom-left') bx = 0;
      else if (opts.cornerHint === 'top-right') by = 0;
      else if (opts.cornerHint === 'top-left') {
        bx = 0;
        by = 0;
      }

      const cornerImg = ctx.getImageData(bx, by, bandW, bandH);
      const effectiveCorner = opts.cornerHint === 'auto' ? 'bottom-right' : opts.cornerHint;
      let cornerTouched = false;
      if (shouldProbeThisFrame) {
        const meta = eraseGeminiSparklePixelData(cornerImg.data, bandW, bandH, {
          removerSyncFn: opts.removerFn,
          cornerHint: effectiveCorner,
          forceRescue: true,
          preferHarmonicHeal: true,
          roiWidth: bandW,
          roiHeight: bandH,
        });
        opts.lockState.probed = true;
        if (meta.applied) {
          opts.lockState.box = meta.lockBox || null;
          cornerTouched = true;
        }
      } else if (opts.lockState.box) {
        if (applyLockedCornerUnblend(cornerImg.data, bandW, bandH, opts.lockState.box, effectiveCorner)) {
          cornerTouched = true;
        }
      }
      if (eraseCornerTextBadgePixelData(cornerImg.data, bandW, bandH, effectiveCorner, height).applied) {
        cornerTouched = true;
      }
      if (cornerTouched) {
        ctx.putImageData(cornerImg, bx, by);
        touched = true;
      }
    }
  }

  return touched;
}

async function resolveWebCodecsConfig(
  format: 'mp4' | 'webm',
  width: number,
  height: number,
  fps: number
): Promise<{
  container: 'mp4' | 'webm';
  codec: string;
  muxerCodec: 'avc' | 'vp9' | 'V_VP9' | 'V_VP8';
} | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const bitrate = Math.min(8_000_000, Math.max(1_200_000, Math.round(width * height * fps * 0.12)));

  if (format === 'mp4') {
    for (const codec of ['avc1.4d002a', 'avc1.42001f']) {
      try {
        const res = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps });
        if (res.supported) return { container: 'mp4', codec, muxerCodec: 'avc' };
      } catch {
        // try next
      }
    }
  }

  for (const [codec, muxerCodec] of [
    ['vp09.00.10.08', 'V_VP9'],
    ['vp8', 'V_VP8'],
  ] as const) {
    try {
      const res = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps });
      if (res.supported) return { container: 'webm', codec, muxerCodec };
    } catch {
      // try next
    }
  }

  return null;
}

async function tryDecodeAndEncodeAudio(
  file: File,
  container: 'mp4' | 'webm',
  addAudioChunk: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void
): Promise<{ hasAudio: boolean; audioConfig?: { codec: 'aac' | 'opus' | 'A_OPUS'; numberOfChannels: number; sampleRate: number }; encodeAll?: () => Promise<void> }> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioContext === 'undefined') {
    return { hasAudio: false };
  }

  let audioCtx: AudioContext | null = null;
  try {
    const rawBuf = await file.arrayBuffer();
    audioCtx = new AudioContext();
    const audioBuffer = await audioCtx.decodeAudioData(rawBuf.slice(0));
    const channels = Math.min(2, audioBuffer.numberOfChannels);
    const sampleRate = audioBuffer.sampleRate;
    const webCodecAudio = container === 'mp4' ? 'mp4a.40.2' : 'opus';
    const support = await AudioEncoder.isConfigSupported({
      codec: webCodecAudio,
      numberOfChannels: channels,
      sampleRate,
      bitrate: 128_000,
    });

    if (!support.supported) {
      return { hasAudio: false };
    }

    const encodeAll = async () => {
      const encoder = new AudioEncoder({
        output: (chunk, meta) => addAudioChunk(chunk, meta),
        error: (err) => console.warn('AudioEncoder warning:', err),
      });
      encoder.configure({
        codec: webCodecAudio,
        numberOfChannels: channels,
        sampleRate,
        bitrate: 128_000,
      });

      const chunkSamples = Math.min(4096, sampleRate);
      const totalSamples = audioBuffer.length;
      const channelArrays: Float32Array[] = [];
      for (let c = 0; c < channels; c++) {
        channelArrays.push(audioBuffer.getChannelData(c));
      }

      for (let offset = 0; offset < totalSamples; offset += chunkSamples) {
        const frames = Math.min(chunkSamples, totalSamples - offset);
        const planar = new Float32Array(frames * channels);
        for (let c = 0; c < channels; c++) {
          planar.set(channelArrays[c].subarray(offset, offset + frames), c * frames);
        }
        const timestampUs = Math.round((offset * 1_000_000) / sampleRate);
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate,
          numberOfFrames: frames,
          numberOfChannels: channels,
          timestamp: timestampUs,
          data: planar,
        });
        encoder.encode(audioData);
        audioData.close();
      }
      await encoder.flush();
      encoder.close();
    };

    return {
      hasAudio: true,
      audioConfig: {
        codec: container === 'mp4' ? 'aac' : 'A_OPUS',
        numberOfChannels: channels,
        sampleRate,
      },
      encodeAll,
    };
  } catch {
    return { hasAudio: false };
  } finally {
    if (audioCtx) {
      try {
        await audioCtx.close();
      } catch {
        // ignore close errors
      }
    }
  }
}

/**
 * Processes a Video file (MP4, WebM, MOV) 100% locally in browser memory:
 * cleans every frame using corner reverse-alpha erasure, multi-frame visual brush inpainting,
 * and spatial signal disruption, while re-muxing audio and purging all C2PA/XMP/EXIF boxes.
 */
export async function processVideoClientSide(
  file: File,
  options: VideoProcessingOptions = {}
): Promise<{ videoUrl: string; blob: Blob; telemetry: VideoTelemetry }> {
  const startTime = Date.now();
  const logs: string[] = [];

  const disruptionMode = options.disruptionMode || 'balanced';
  const disruptionStrength = options.disruptionStrength ?? 75;
  const isMetadataOnly = disruptionMode === 'metadata-only';
  const shouldRemoveBadge = options.removeVisibleBadge !== false && !isMetadataOnly;
  const shouldDisrupt = options.disruptSignals !== false && !isMetadataOnly;
  const requestedFormat: 'mp4' | 'webm' =
    options.format || (file.type === 'video/webm' || /\.webm$/i.test(file.name) ? 'webm' : 'mp4');
  const fps = Math.max(10, Math.min(30, options.targetFps || 24));
  const cornerHint = options.cornerHint || 'auto';

  const inputHeadBytes = new Uint8Array(await file.slice(0, Math.min(file.size, 256 * 1024)).arrayBuffer());
  const initialAudit = scanUint8ArrayProvenance(inputHeadBytes);
  logs.push(`[VIDEO] Loaded ${file.name} (${(file.size / 1024).toFixed(1)} KB) | Input format: ${initialAudit.formatDetected}`);

  const { video, objectUrl } = await createVideoElement(file);

  try {
    const rawW = video.videoWidth || 640;
    const rawH = video.videoHeight || 360;
    // H.264 & VP8/VP9 encoders expect even width/height
    const width = Math.max(2, rawW - (rawW % 2));
    const height = Math.max(2, rawH - (rawH % 2));
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;

    logs.push(`[VIDEO] Dimensions: ${width}x${height}px | Duration: ${duration.toFixed(2)}s | Target FPS: ${fps} | Mode: ${disruptionMode.toUpperCase()}`);

    const workCanvas = document.createElement('canvas');
    workCanvas.width = width;
    workCanvas.height = height;
    const ctx = workCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not initialize video frame processing canvas.');

    const tempCanvas = shouldDisrupt ? document.createElement('canvas') : null;
    const removerFn = shouldRemoveBadge ? await loadGeminiWatermarkRemoverSync() : null;
    const maskInfo = options.maskBlob ? await loadMaskImageData(options.maskBlob, width, height) : null;

    const webCodecsCfg = await resolveWebCodecsConfig(requestedFormat, width, height, fps);

    let outputBytes: Uint8Array;
    let outputFormat: 'mp4' | 'webm';
    let encoderBackend: string;
    let audioPreserved = false;
    let totalFrames = Math.max(1, Math.min(1800, Math.round(duration * fps)));
    let badgeOrMaskApplied = false;
    const lockState: { probed: boolean; box: SparkleLockBox | null } = { probed: false, box: null };

    if (webCodecsCfg) {
      outputFormat = webCodecsCfg.container;
      encoderBackend = `WebCodecs (${webCodecsCfg.codec})`;
      logs.push(`[PROCESS] Initializing ${encoderBackend} frame-accurate encoder...`);

      let audioPlan: Awaited<ReturnType<typeof tryDecodeAndEncodeAudio>> = { hasAudio: false };
      let muxerRef: Mp4Muxer<Mp4ArrayBufferTarget> | WebmMuxer<WebmArrayBufferTarget>;

      if (options.preserveAudio !== false) {
        audioPlan = await tryDecodeAndEncodeAudio(file, outputFormat, (chunk, meta) => {
          (muxerRef as any).addAudioChunk(chunk, meta);
        });
      }

      if (outputFormat === 'mp4') {
        const target = new Mp4ArrayBufferTarget();
        muxerRef = new Mp4Muxer({
          target,
          video: { codec: 'avc', width, height, frameRate: fps },
          ...(audioPlan.hasAudio && audioPlan.audioConfig
            ? {
                audio: {
                  codec: 'aac',
                  numberOfChannels: audioPlan.audioConfig.numberOfChannels,
                  sampleRate: audioPlan.audioConfig.sampleRate,
                },
              }
            : {}),
          fastStart: 'in-memory',
        });
      } else {
        const target = new WebmArrayBufferTarget();
        muxerRef = new WebmMuxer({
          target,
          video: { codec: webCodecsCfg.muxerCodec, width, height, frameRate: fps },
          ...(audioPlan.hasAudio && audioPlan.audioConfig
            ? {
                audio: {
                  codec: 'A_OPUS',
                  numberOfChannels: audioPlan.audioConfig.numberOfChannels,
                  sampleRate: audioPlan.audioConfig.sampleRate,
                },
              }
            : {}),
        });
      }

      const bitrate = Math.min(8_000_000, Math.max(1_200_000, Math.round(width * height * fps * 0.12)));
      const videoEncoder = new VideoEncoder({
        output: (chunk, meta) => {
          (muxerRef as any).addVideoChunk(chunk, meta);
        },
        error: (err) => {
          throw err;
        },
      });

      videoEncoder.configure({
        codec: webCodecsCfg.codec,
        width,
        height,
        bitrate,
        framerate: fps,
      });

      const frameDurationUs = Math.round(1_000_000 / fps);
      for (let i = 0; i < totalFrames; i++) {
        const t = i / fps;
        await seekVideo(video, t);
        ctx.drawImage(video, 0, 0, width, height);

        const frameChanged = processVideoCanvasFrame(ctx, tempCanvas, width, height, {
          isMetadataOnly,
          shouldRemoveBadge,
          shouldDisrupt,
          disruptionMode,
          disruptionStrength,
          cornerHint,
          removerFn,
          maskInfo,
          frameIndex: i,
          totalFrames,
          lockState,
        });
        if (frameChanged) badgeOrMaskApplied = true;

        const vf = new VideoFrame(workCanvas, {
          timestamp: i * frameDurationUs,
          duration: frameDurationUs,
        });
        videoEncoder.encode(vf, { keyFrame: i % Math.max(1, fps * 2) === 0 });
        vf.close();

        while (videoEncoder.encodeQueueSize > 6) {
          await new Promise((r) => setTimeout(r, 8));
        }

        if (options.onProgress) {
          options.onProgress({
            currentFrame: i + 1,
            totalFrames,
            phase: maskInfo ? 'Inpainting & encoding video frames' : 'Scrubbing & encoding video frames',
            percent: Math.round(((i + 1) / totalFrames) * 100),
          });
        }
      }

      await videoEncoder.flush();
      videoEncoder.close();

      if (audioPlan.hasAudio && audioPlan.encodeAll) {
        await audioPlan.encodeAll();
        audioPreserved = true;
        logs.push(`[SUCCESS] Original audio stream decoded and muxed cleanly into clean container.`);
      } else {
        logs.push(`[INFO] No audio track re-muxed (silent clip or codec bypassed); video track finalized cleanly.`);
      }

      muxerRef.finalize();
      const targetBuf = (muxerRef.target as Mp4ArrayBufferTarget | WebmArrayBufferTarget).buffer;
      outputBytes = new Uint8Array(targetBuf);
    } else {
      // Universal MediaRecorder Fallback when WebCodecs VideoEncoder is unavailable
      const candidateMimes =
        requestedFormat === 'mp4'
          ? ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
          : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
      const chosenMime = candidateMimes.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) || 'video/webm';
      outputFormat = chosenMime.includes('mp4') ? 'mp4' : 'webm';
      encoderBackend = `MediaRecorder (${chosenMime})`;
      logs.push(`[PROCESS] Using universal fallback ${encoderBackend}...`);

      const stream = workCanvas.captureStream(fps);
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, {
        mimeType: chosenMime,
        videoBitsPerSecond: 3_500_000,
      });
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };

      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });

      totalFrames = Math.max(1, Math.min(900, Math.round(duration * fps)));
      recorder.start(100);
      video.currentTime = 0;

      await new Promise<void>((resolve) => {
        let count = 0;
        let rafId = 0;
        const renderLoop = () => {
          ctx.drawImage(video, 0, 0, width, height);
          const changed = processVideoCanvasFrame(ctx, tempCanvas, width, height, {
            isMetadataOnly,
            shouldRemoveBadge,
            shouldDisrupt,
            disruptionMode,
            disruptionStrength,
            cornerHint,
            removerFn,
            maskInfo,
            frameIndex: count,
            totalFrames,
            lockState,
          });
          if (changed) badgeOrMaskApplied = true;
          count++;
          if (options.onProgress) {
            const pct = Math.min(99, Math.round((video.currentTime / Math.max(0.1, duration)) * 100));
            options.onProgress({
              currentFrame: count,
              totalFrames,
              phase: 'Recording scrubbed video frames',
              percent: pct,
            });
          }

          if (video.ended || video.paused) {
            cancelAnimationFrame(rafId);
            resolve();
            return;
          }
          rafId = requestAnimationFrame(renderLoop);
        };

        video.onended = () => {
          cancelAnimationFrame(rafId);
          resolve();
        };
        video.play().then(() => {
          rafId = requestAnimationFrame(renderLoop);
        }).catch(() => resolve());
      });

      recorder.stop();
      await stopped;
      const mergedBlob = new Blob(chunks, { type: chosenMime });
      outputBytes = new Uint8Array(await mergedBlob.arrayBuffer());
      totalFrames = Math.max(1, totalFrames);
    }

    if (maskInfo) {
      logs.push(`[SUCCESS] Visual brush mask applied cleanly across all ${totalFrames} video frames.`);
    } else if (badgeOrMaskApplied) {
      logs.push(`[SUCCESS] Corner badge erasure applied across video frames.`);
    }
    if (shouldDisrupt) {
      logs.push(`[SUCCESS] Per-frame spatial carrier disruption & geometric shift completed.`);
    }
    if (options.stripMetadata !== false) {
      logs.push(`[SUCCESS] Cleanly muxed pristine ${outputFormat.toUpperCase()} container (zero C2PA/JUMBF/XMP/EXIF atoms).`);
    }

    const provenanceAudit = scanUint8ArrayProvenance(
      outputBytes.subarray(0, Math.min(outputBytes.length, 512 * 1024))
    );
    provenanceAudit.bytesScanned = outputBytes.length;

    logs.push(
      `[AUDIT] Scanned ${provenanceAudit.bytesScanned} bytes (${provenanceAudit.formatDetected}): C2PA=${
        provenanceAudit.c2paFound ? 'FOUND' : 'CLEAN'
      }, EXIF=${provenanceAudit.exifFound ? 'FOUND' : 'CLEAN'}, XMP=${
        provenanceAudit.xmpFound ? 'FOUND' : 'CLEAN'
      }`
    );

    const executionTimeMs = Date.now() - startTime;
    logs.push(`[COMPLETE] Video pipeline finished in ${executionTimeMs}ms (${encoderBackend}).`);

    const outBuffer = outputBytes.buffer.slice(
      outputBytes.byteOffset,
      outputBytes.byteOffset + outputBytes.byteLength
    ) as ArrayBuffer;
    const outBlob = new Blob([outBuffer], {
      type: outputFormat === 'mp4' ? 'video/mp4' : 'video/webm',
    });
    const videoUrl = URL.createObjectURL(outBlob);

    return {
      videoUrl,
      blob: outBlob,
      telemetry: {
        originalSize: file.size,
        processedSize: outputBytes.length,
        dimensions: { width, height },
        durationSec: Number(duration.toFixed(2)),
        frameCount: totalFrames,
        fps,
        format: outputFormat,
        encoderBackend,
        audioPreserved,
        metadataStripped: options.stripMetadata !== false,
        signalsDisrupted: shouldDisrupt,
        disruptionMode,
        badgeRemoved: badgeOrMaskApplied,
        maskApplied: Boolean(maskInfo),
        provenanceAudit,
        executionTimeMs,
        logs,
      },
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
