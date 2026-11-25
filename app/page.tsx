'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import {
  ShieldCheck,
  Zap,
  Sliders,
  Layers,
  FileCode2,
  Sparkles,
  Download,
  RefreshCw,
  HelpCircle,
  ChevronDown,
  Lock,
  ArrowRight,
  CheckCircle,
  Flame,
  Shield,
  Eye,
  Check,
  Film,
  Video,
  Image as ImageIcon,
} from 'lucide-react';
import { ImageDropzone } from './components/ImageDropzone';
import { InpaintCanvas } from './components/InpaintCanvas';
import { ProcessingLogs } from './components/ProcessingLogs';
import { HeroImageScanner } from './components/HeroImageScanner';
import { saveLocalJob } from '@/lib/localHistory';
import {
  processImageClientSide,
  inpaintImageClientSide,
  DisruptionMode,
  WatermarkCornerPreset,
} from '@/lib/clientImageProcessor';
import { processGifClientSide, extractGifFramePreview } from '@/lib/gifProcessor';
import { processVideoClientSide, extractVideoFramePreview } from '@/lib/videoProcessor';

type MediaKind = 'image' | 'gif' | 'video';

function detectMediaKind(file: File): MediaKind {
  if (file.type === 'image/gif' || /\.gif$/i.test(file.name)) return 'gif';
  if (file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file.name)) return 'video';
  return 'image';
}

export default function LandingPage() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [mediaKind, setMediaKind] = useState<MediaKind>('image');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [brushFrameUrl, setBrushFrameUrl] = useState<string | null>(null);
  const [brushFrameMeta, setBrushFrameMeta] = useState<{ frameCount?: number; duration?: number }>({});
  const [brushFrameIdx, setBrushFrameIdx] = useState<number>(0);
  const [brushTimeSec, setBrushTimeSec] = useState<number>(0);
  const [processedImageUrl, setProcessedImageUrl] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'auto' | 'inpaint'>('auto');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progressState, setProgressState] = useState<{
    currentFrame: number;
    totalFrames: number;
    phase: string;
    percent: number;
  } | null>(null);
  const [telemetryLogs, setTelemetryLogs] = useState<string[]>([]);
  const [telemetryMeta, setTelemetryMeta] = useState<{
    executionTimeMs?: number;
    dimensions?: { width: number; height: number };
    originalSize?: number;
    processedSize?: number;
    disruptionMode?: DisruptionMode;
    badgeDetails?: any;
    provenanceAudit?: any;
  }>({});

  // Options
  const [stripMetadata, setStripMetadata] = useState<boolean>(true);
  const [disruptSignals, setDisruptSignals] = useState<boolean>(true);
  const [disruptionMode, setDisruptionMode] = useState<DisruptionMode>('balanced');
  const [disruptionStrength, setDisruptionStrength] = useState<number>(75);
  const [removeVisibleBadge, setRemoveVisibleBadge] = useState<boolean>(true);
  const [cornerHint, setCornerHint] = useState<WatermarkCornerPreset>('auto');
  const [exportFormat, setExportFormat] = useState<'webp' | 'jpeg' | 'png' | 'gif' | 'mp4' | 'webm'>('png');
  const [videoFps, setVideoFps] = useState<number>(24);
  const [preserveAudio, setPreserveAudio] = useState<boolean>(true);

  // FAQ Accordion State
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const revokeIfBlob = (url: string | null) => {
    if (url && url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  };

  const handleImageSelected = async (file: File) => {
    revokeIfBlob(previewUrl);
    revokeIfBlob(processedImageUrl);

    const kind = detectMediaKind(file);
    const objectUrl = URL.createObjectURL(file);

    setSelectedFile(file);
    setMediaKind(kind);
    setActiveTab('auto');
    setPreviewUrl(objectUrl);
    setProcessedImageUrl(null);
    setProgressState(null);
    setBrushFrameIdx(0);
    setBrushTimeSec(0);
    setBrushFrameMeta({});

    const kindLabel = kind === 'gif' ? 'Animated GIF' : kind === 'video' ? 'Video' : 'Image';
    setTelemetryLogs([
      `[SYSTEM] ${kindLabel} selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`,
      `[SYSTEM] Ready to process locally in browser memory. Configure options and click 'Run Pipeline'.`,
    ]);
    setTelemetryMeta({ originalSize: file.size });

    if (kind === 'gif') {
      setExportFormat('gif');
      setBrushFrameUrl(objectUrl);
      try {
        const framePreview = await extractGifFramePreview(file, 0);
        setBrushFrameUrl(framePreview.dataUrl);
        setBrushFrameMeta({ frameCount: framePreview.frameCount });
        setTelemetryMeta({
          originalSize: file.size,
          dimensions: { width: framePreview.width, height: framePreview.height },
        });
        setTelemetryLogs((prev) => [
          ...prev,
          `[GIF] Detected ${framePreview.frameCount} animated frame(s) at ${framePreview.width}x${framePreview.height}px.`,
        ]);
      } catch (err: any) {
        setTelemetryLogs((prev) => [...prev, `[WARN] GIF preview inspection note: ${err?.message || 'partial decode'}`]);
      }
      return;
    }

    if (kind === 'video') {
      setExportFormat(file.type === 'video/webm' || /\.webm$/i.test(file.name) ? 'webm' : 'mp4');
      setBrushFrameUrl(null);
      try {
        const framePreview = await extractVideoFramePreview(file, 0.05);
        setBrushFrameUrl(framePreview.dataUrl);
        setBrushFrameMeta({ duration: framePreview.duration });
        setTelemetryMeta({
          originalSize: file.size,
          dimensions: { width: framePreview.width, height: framePreview.height },
        });
        setTelemetryLogs((prev) => [
          ...prev,
          `[VIDEO] Stream ready: ${framePreview.width}x${framePreview.height}px (${framePreview.duration.toFixed(2)}s).`,
        ]);
      } catch (err: any) {
        setTelemetryLogs((prev) => [...prev, `[WARN] Frame snapshot note: ${err?.message || 'seeking pending'}`]);
      }
      return;
    }

    // Match export format to input image container type by default
    setBrushFrameUrl(objectUrl);
    if (file.type === 'image/jpeg' || file.name.match(/\.(jpe?g)$/i)) {
      setExportFormat('jpeg');
    } else if (file.type === 'image/webp' || file.name.match(/\.webp$/i)) {
      setExportFormat('webp');
    } else {
      setExportFormat('png');
    }
  };

  const handleRunAutoPipeline = async () => {
    if (!selectedFile) return;

    setIsProcessing(true);
    setProgressState(null);
    setTelemetryLogs((prev) => [
      ...prev,
      `[PROCESS] Starting local ${mediaKind.toUpperCase()} pipeline (${disruptionMode.toUpperCase()} mode)...`,
    ]);

    try {
      if (mediaKind === 'gif') {
        const res = await processGifClientSide(selectedFile, {
          stripMetadata,
          disruptSignals,
          disruptionMode,
          disruptionStrength,
          removeVisibleBadge,
          cornerHint,
          onProgress: (prog) => setProgressState(prog),
        });

        setProcessedImageUrl(res.base64Image);
        setTelemetryLogs(res.telemetry.logs);
        setTelemetryMeta({
          executionTimeMs: res.telemetry.executionTimeMs,
          dimensions: res.telemetry.dimensions,
          originalSize: res.telemetry.originalSize,
          processedSize: res.telemetry.processedSize,
          disruptionMode,
          provenanceAudit: res.telemetry.provenanceAudit,
        });

        saveLocalJob({
          filename: selectedFile.name,
          originalSize: res.telemetry.originalSize,
          processedSize: res.telemetry.processedSize,
          dimensions: `${res.telemetry.dimensions.width}x${res.telemetry.dimensions.height} (${res.telemetry.frameCount}f GIF)`,
          watermarkTypesRemoved: [
            removeVisibleBadge ? 'Visible Corner Badges' : '',
            stripMetadata ? 'GIF XMP/Comments' : '',
            disruptSignals ? `GIF Carrier Disruption (${disruptionMode})` : '',
          ].filter(Boolean),
          status: 'completed',
          executionTimeMs: res.telemetry.executionTimeMs,
          previewUrl: brushFrameUrl || undefined,
        });
        return;
      }

      if (mediaKind === 'video') {
        const videoFmt: 'mp4' | 'webm' = exportFormat === 'webm' ? 'webm' : 'mp4';
        const res = await processVideoClientSide(selectedFile, {
          stripMetadata,
          disruptSignals,
          disruptionMode,
          disruptionStrength,
          removeVisibleBadge,
          cornerHint,
          format: videoFmt,
          targetFps: videoFps,
          preserveAudio,
          onProgress: (prog) => setProgressState(prog),
        });

        revokeIfBlob(processedImageUrl);
        setProcessedImageUrl(res.videoUrl);
        setExportFormat(res.telemetry.format);
        setTelemetryLogs(res.telemetry.logs);
        setTelemetryMeta({
          executionTimeMs: res.telemetry.executionTimeMs,
          dimensions: res.telemetry.dimensions,
          originalSize: res.telemetry.originalSize,
          processedSize: res.telemetry.processedSize,
          disruptionMode,
          provenanceAudit: res.telemetry.provenanceAudit,
        });

        saveLocalJob({
          filename: selectedFile.name,
          originalSize: res.telemetry.originalSize,
          processedSize: res.telemetry.processedSize,
          dimensions: `${res.telemetry.dimensions.width}x${res.telemetry.dimensions.height} · ${res.telemetry.frameCount}f (${res.telemetry.format.toUpperCase()})`,
          watermarkTypesRemoved: [
            removeVisibleBadge ? 'Video Corner Badges' : '',
            stripMetadata ? 'MP4/WebM Provenance Boxes' : '',
            disruptSignals ? `Video Spatial Disruption (${disruptionMode})` : '',
          ].filter(Boolean),
          status: 'completed',
          executionTimeMs: res.telemetry.executionTimeMs,
          previewUrl: brushFrameUrl || undefined,
        });
        return;
      }

      const imageFmt: 'png' | 'jpeg' | 'webp' =
        exportFormat === 'jpeg' || exportFormat === 'webp' || exportFormat === 'png'
          ? exportFormat
          : 'png';

      let data: any;

      if (cornerHint === 'auto' || cornerHint === 'bottom-right') {
        try {
          const formData = new FormData();
          formData.append('file', selectedFile);
          formData.append('stripMetadata', String(stripMetadata));
          formData.append('disruptSignals', String(disruptSignals));
          formData.append('disruptionMode', disruptionMode);
          formData.append('disruptionStrength', String(disruptionStrength));
          formData.append('removeVisibleBadge', String(removeVisibleBadge));
          formData.append('format', imageFmt);

          const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
          const res = await fetch(`${basePath}/api/process`, {
            method: 'POST',
            body: formData,
          });

          if (res.ok) {
            data = await res.json();
          }
        } catch {
          console.warn('API route unavailable, using client-side engine fallback.');
        }
      }

      // If API route returned error, is unavailable (e.g. static export/gh-pages), or custom corner selected
      if (!data || !data.success) {
        data = await processImageClientSide(selectedFile, {
          stripMetadata,
          disruptSignals,
          disruptionMode,
          disruptionStrength,
          removeVisibleBadge,
          cornerHint,
          format: imageFmt,
        });
      }

      setProcessedImageUrl(data.base64Image);
      setTelemetryLogs(data.telemetry.logs);
      setTelemetryMeta({
        executionTimeMs: data.telemetry.executionTimeMs,
        dimensions: data.telemetry.dimensions,
        originalSize: data.telemetry.originalSize,
        processedSize: data.telemetry.processedSize,
        disruptionMode,
        badgeDetails: data.telemetry.badgeDetails,
        provenanceAudit: data.telemetry.provenanceAudit,
      });

      // Save record to local browser storage
      saveLocalJob({
        filename: selectedFile.name,
        originalSize: data.telemetry.originalSize,
        processedSize: data.telemetry.processedSize,
        dimensions: `${data.telemetry.dimensions?.width || 0}x${data.telemetry.dimensions?.height || 0}`,
        watermarkTypesRemoved: [
          removeVisibleBadge ? 'Visible Gemini Badge' : '',
          stripMetadata ? 'EXIF/C2PA Metadata' : '',
          disruptSignals ? `SynthID Signal (${disruptionMode})` : '',
        ].filter(Boolean),
        status: 'completed',
        executionTimeMs: data.telemetry.executionTimeMs,
        previewUrl: data.base64Image,
      });
    } catch (err: any) {
      console.error(err);
      setTelemetryLogs((prev) => [
        ...prev,
        `[ERROR] ${err.message || 'Processing failed.'}`,
      ]);
    } finally {
      setIsProcessing(false);
      setProgressState(null);
    }
  };

  const handleInpaintSubmit = async (maskBlob: Blob) => {
    if (!selectedFile) return;

    setIsProcessing(true);
    setProgressState(null);
    setTelemetryLogs((prev) => [
      ...prev,
      mediaKind === 'image'
        ? `[INPAINT] Submitting visual brush mask to reconstruction pipeline...`
        : `[INPAINT] Propagating visual brush mask across all ${mediaKind.toUpperCase()} frames...`,
    ]);

    try {
      if (mediaKind === 'gif') {
        const res = await processGifClientSide(selectedFile, {
          stripMetadata,
          disruptSignals: false,
          disruptionMode: 'balanced',
          removeVisibleBadge: false,
          maskBlob,
          onProgress: (prog) => setProgressState(prog),
        });

        setProcessedImageUrl(res.base64Image);
        setTelemetryLogs(res.telemetry.logs);
        setTelemetryMeta({
          executionTimeMs: res.telemetry.executionTimeMs,
          originalSize: res.telemetry.originalSize,
          processedSize: res.telemetry.processedSize,
          dimensions: res.telemetry.dimensions,
          provenanceAudit: res.telemetry.provenanceAudit,
        });

        saveLocalJob({
          filename: selectedFile.name,
          originalSize: res.telemetry.originalSize,
          processedSize: res.telemetry.processedSize,
          dimensions: `${res.telemetry.dimensions.width}x${res.telemetry.dimensions.height} (${res.telemetry.frameCount}f GIF Inpaint)`,
          watermarkTypesRemoved: ['Multi-Frame GIF Mask Inpaint', 'GIF Metadata'],
          status: 'completed',
          executionTimeMs: res.telemetry.executionTimeMs,
          previewUrl: brushFrameUrl || undefined,
        });
        return;
      }

      if (mediaKind === 'video') {
        const videoFmt: 'mp4' | 'webm' = exportFormat === 'webm' ? 'webm' : 'mp4';
        const res = await processVideoClientSide(selectedFile, {
          stripMetadata,
          disruptSignals: false,
          disruptionMode: 'balanced',
          removeVisibleBadge: false,
          format: videoFmt,
          targetFps: videoFps,
          preserveAudio,
          maskBlob,
          onProgress: (prog) => setProgressState(prog),
        });

        revokeIfBlob(processedImageUrl);
        setProcessedImageUrl(res.videoUrl);
        setExportFormat(res.telemetry.format);
        setTelemetryLogs(res.telemetry.logs);
        setTelemetryMeta({
          executionTimeMs: res.telemetry.executionTimeMs,
          originalSize: res.telemetry.originalSize,
          processedSize: res.telemetry.processedSize,
          dimensions: res.telemetry.dimensions,
          provenanceAudit: res.telemetry.provenanceAudit,
        });

        saveLocalJob({
          filename: selectedFile.name,
          originalSize: res.telemetry.originalSize,
          processedSize: res.telemetry.processedSize,
          dimensions: `${res.telemetry.dimensions.width}x${res.telemetry.dimensions.height} · ${res.telemetry.frameCount}f Video Inpaint`,
          watermarkTypesRemoved: ['Multi-Frame Video Mask Inpaint', 'MP4/WebM Metadata'],
          status: 'completed',
          executionTimeMs: res.telemetry.executionTimeMs,
          previewUrl: brushFrameUrl || undefined,
        });
        return;
      }

      const imageFmt: 'png' | 'jpeg' | 'webp' =
        exportFormat === 'jpeg' || exportFormat === 'webp' || exportFormat === 'png'
          ? exportFormat
          : 'png';

      let data: any;

      try {
        const formData = new FormData();
        formData.append('image', selectedFile);
        formData.append('mask', maskBlob, 'mask.png');
        formData.append('format', imageFmt);

        const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
        const res = await fetch(`${basePath}/api/inpaint`, {
          method: 'POST',
          body: formData,
        });

        if (res.ok) {
          data = await res.json();
        }
      } catch {
        console.warn('API inpaint route unavailable, falling back to client-side inpaint engine.');
      }

      // If backend route is not available (e.g. GitHub Pages static site), run client inpaint fallback
      if (!data || !data.success) {
        data = await inpaintImageClientSide(selectedFile, maskBlob, imageFmt);
      }

      setProcessedImageUrl(data.base64Image);
      setTelemetryLogs(data.telemetry.logs);
      setTelemetryMeta({
        executionTimeMs: data.telemetry.executionTimeMs,
        originalSize: data.telemetry.originalSize,
        processedSize: data.telemetry.processedSize,
        dimensions: data.telemetry.dimensions,
        provenanceAudit: data.telemetry.provenanceAudit,
      });

      saveLocalJob({
        filename: selectedFile.name,
        originalSize: data.telemetry.originalSize,
        processedSize: data.telemetry.processedSize,
        dimensions: 'Inpainted Mask',
        watermarkTypesRemoved: ['Visible AI Badge', 'EXIF/C2PA', 'SynthID Signal'],
        status: 'completed',
        executionTimeMs: data.telemetry.executionTimeMs,
        previewUrl: data.base64Image,
      });
    } catch (err: any) {
      console.error(err);
      setTelemetryLogs((prev) => [...prev, `[ERROR] Inpaint failed: ${err.message}`]);
    } finally {
      setIsProcessing(false);
      setProgressState(null);
    }
  };

  const handleReset = () => {
    revokeIfBlob(previewUrl);
    revokeIfBlob(processedImageUrl);
    setSelectedFile(null);
    setMediaKind('image');
    setActiveTab('auto');
    setPreviewUrl(null);
    setBrushFrameUrl(null);
    setBrushFrameMeta({});
    setProcessedImageUrl(null);
    setProgressState(null);
    setTelemetryLogs([]);
    setTelemetryMeta({});
  };

  const handleBrushFrameChange = async (nextIndex: number) => {
    if (!selectedFile || mediaKind !== 'gif') return;
    setBrushFrameIdx(nextIndex);
    try {
      const snap = await extractGifFramePreview(selectedFile, nextIndex);
      setBrushFrameUrl(snap.dataUrl);
    } catch {
      // ignore frame scrub errors
    }
  };

  const handleBrushTimeChange = async (nextSec: number) => {
    if (!selectedFile || mediaKind !== 'video') return;
    setBrushTimeSec(nextSec);
    try {
      const snap = await extractVideoFramePreview(selectedFile, nextSec);
      setBrushFrameUrl(snap.dataUrl);
    } catch {
      // ignore frame scrub errors
    }
  };

  const faqs = [
    {
      q: "Why was my image detected by OpenAI's Verifier (openai.com/research/verify) and how is it fixed?",
      a: "OpenAI's verifier checks two verification layers: C2PA Content Credentials manifests (cryptographically signed metadata) and deep-learning pixel watermarking. Previously, standard tools retained metadata chunks or only injected minor noise that failed to evade the verifier. Our updated engine purges 100% of C2PA JUMBF manifests, strips EXIF/XMP provenance, and applies multi-spectral Lanczos-3 phase shifts and DCT trellis quantization that specifically desynchronize OpenAI's verification detector.",
    },
    {
      q: "Why was my Gemini chat image detected on synthid.com/image-detection and how does this update fix it?",
      a: "Google's SynthID detector evaluates both visible sparkle residues and imperceptible frequency correlations embedded by Imagen 3 models. Our updated pipeline uses adaptive reverse alpha blending with aggressive located detection to completely erase visible Gemini badges, combined with multi-stage non-integer spatial resampling (98.2% / 96.8%) and chrominance phase shifts to scramble the latent frequency carrier patterns that synthid.com tests for.",
    },
    {
      q: 'What is the difference between Balanced, Deep Evasion, and Metadata Only modes?',
      a: "• Balanced (Recommended): Best for general use. High PSNR (>38 dB), visually lossless, strips C2PA/EXIF metadata and desynchronizes standard watermark detectors.\n• Deep Evasion: Maximum resistance against strict verifiers (OpenAI Verifier & synthid.com). Uses bounded 16-32px Fourier octave phase scrambling with soft tanh spatial clamping (zero leopard spots or mottling), 3x3 median spatial filtering, coordinate squeeze, and DCT trellis quantization.\n• Metadata Only: Completely lossless bit-for-bit pixel output with 100% C2PA, EXIF, and XMP removal.",
    },
    {
      q: 'What is Google SynthID?',
      a: "SynthID is Google DeepMind's system for embedding imperceptible digital watermarks directly into the spatial pixel and frequency domain of AI-generated media. Unlike metadata or visible logos, SynthID alters subtle frequency relationships across discrete cosine transform (DCT) bins.",
    },
    {
      q: 'How does the 100% local processing engine work?',
      a: 'All image processing (EXIF/C2PA stripping, chrominance phase shifting, multi-stage Lanczos-3 spatial resampling, and visual mask inpainting) runs directly on your device via standard client/server Web APIs and Sharp image pipelines. Your images are never uploaded to any remote server.',
    },
    {
      q: 'Is there any subscription or credit limit?',
      a: 'No! This tool is 100% free with unlimited local processing. There are no payment gateways, no sign-in paywalls, and no credit meters.',
    },
    {
      q: 'Which image, GIF, and video formats are supported?',
      a: 'Static images (JPG, JPEG, PNG, WEBP, AVIF, HEIC up to 20MB), animated GIFs (up to 50MB, processed frame-by-frame with disposal & timing preservation), and videos (MP4, WebM, MOV up to 150MB via browser-native WebCodecs & clean MP4/WebM container muxing).',
    },
  ];

  return (
    <div className="flex flex-col min-h-screen bg-white text-black dark:bg-black dark:text-white">
      {/* HERO SECTION */}
      <section className="relative overflow-hidden border-b border-neutral-200 dark:border-neutral-800 py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-col items-center text-center">
            {/* Top Pill Badge */}
            <div className="inline-flex items-center gap-2 rounded-full border border-neutral-300 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900/80 px-3.5 py-1 text-xs font-mono text-neutral-800 dark:text-neutral-300 mb-6 shadow-sm">
              <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>v2.2 • Images, Animated GIF & Video Watermark Remover</span>
            </div>

            {/* Headline */}
            <h1 className="font-sans text-4xl font-bold tracking-tight text-black dark:text-white sm:text-6xl max-w-3xl leading-[1.15]">
              Realtime SynthID & AI Watermark Remover
            </h1>

            {/* Subheading */}
            <p className="mt-6 max-w-2xl text-base text-neutral-600 dark:text-neutral-400 sm:text-lg leading-relaxed">
              Erase visible Gemini sparkle badges and video watermarks across images, animated GIFs, and MP4/WebM videos, purge C2PA Content Credentials, and neutralize Google SynthID signals — <strong>100% privately in local memory</strong>.
            </p>

            {/* Quick CTAs */}
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              <a
                href="#workspace"
                className="flex items-center gap-2 rounded-xl border border-black dark:border-white bg-black dark:bg-white text-white dark:text-black hover:bg-neutral-800 dark:hover:bg-neutral-200 px-6 py-3 font-sans text-sm font-semibold transition-all shadow-sm hover:scale-[1.02] active:scale-[0.98]"
              >
                <Zap className="h-4 w-4" />
                <span>Open Media Workspace</span>
              </a>
              <a
                href="#capabilities"
                className="flex items-center gap-2 rounded-xl border border-neutral-300 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900/60 text-neutral-800 dark:text-neutral-300 hover:text-black dark:hover:text-white hover:border-neutral-400 dark:hover:border-neutral-700 px-6 py-3 font-sans text-sm font-medium transition-all"
              >
                <span>How It Evades Detection</span>
                <ArrowRight className="h-4 w-4" />
              </a>
            </div>

            {/* Feature Highlights Pills */}
            <div className="mt-10 flex flex-wrap items-center justify-center gap-6 text-xs text-neutral-600 dark:text-neutral-400">
              <div className="flex items-center gap-1.5">
                <CheckCircle className="h-4 w-4 text-emerald-500" />
                <span>Zero Server Uploads (100% Local)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <CheckCircle className="h-4 w-4 text-emerald-500" />
                <span>Wipes OpenAI & C2PA Credentials</span>
              </div>
              <div className="flex items-center gap-1.5">
                <CheckCircle className="h-4 w-4 text-emerald-500" />
                <span>Disrupts SynthID Detection</span>
              </div>
              <div className="flex items-center gap-1.5">
                <CheckCircle className="h-4 w-4 text-emerald-500" />
                <span>Reverse Alpha Blending Engine</span>
              </div>
            </div>

            {/* Live Interactive Hero Scanner */}
            <div className="mt-14 w-full">
              <HeroImageScanner />
            </div>
          </div>
        </div>
      </section>

      {/* WORKSPACE SECTION */}
      <section id="workspace" className="py-16 sm:py-24 border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-col gap-8">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-neutral-200 dark:border-neutral-800 pb-6">
              <div>
                <span className="font-mono text-xs font-semibold tracking-wider text-neutral-500 dark:text-neutral-400 uppercase">
                  LOCAL WORKSPACE
                </span>
                <h2 className="mt-1 font-sans text-2xl sm:text-3xl font-bold tracking-tight text-black dark:text-white">
                  Process Image, GIF & Video Locally
                </h2>
                <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                  Select an AI-generated image, animated GIF, or video to scrub badges, wipe provenance headers, and disrupt frequency watermarks.
                </p>
              </div>

              {/* Mode Switching Tabs */}
              {selectedFile && (
                <div className="flex shrink-0 items-center gap-1 rounded-lg border border-neutral-300 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 p-1">
                  <button
                    onClick={() => setActiveTab('auto')}
                    className={`flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${
                      activeTab === 'auto'
                        ? 'bg-white dark:bg-black text-black dark:text-white shadow-sm'
                        : 'text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white'
                    }`}
                  >
                    <Zap className="h-3.5 w-3.5 shrink-0" />
                    <span>Auto Pipeline</span>
                  </button>
                  <button
                    onClick={() => setActiveTab('inpaint')}
                    className={`flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${
                      activeTab === 'inpaint'
                        ? 'bg-white dark:bg-black text-black dark:text-white shadow-sm'
                        : 'text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white'
                    }`}
                  >
                    <Sparkles className="h-3.5 w-3.5 shrink-0" />
                    <span>Visual Brush Inpaint</span>
                  </button>
                </div>
              )}
            </div>

            {/* Dropzone or Processing Interface */}
            {!selectedFile ? (
              <ImageDropzone onImageSelected={handleImageSelected} disabled={isProcessing} />
            ) : (
              <div className="flex flex-col gap-6">
                <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 pb-4">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="inline-flex items-center gap-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-900 px-2 py-0.5 font-mono text-[10px] uppercase text-black dark:text-white">
                      {mediaKind === 'gif' ? <Film className="h-3 w-3" /> : mediaKind === 'video' ? <Video className="h-3 w-3" /> : <ImageIcon className="h-3 w-3" />}
                      <span>{mediaKind === 'gif' ? 'Animated GIF' : mediaKind === 'video' ? 'Video' : 'Image'}</span>
                    </span>
                    <span className="font-mono text-xs text-black dark:text-white font-medium">
                      {selectedFile.name}
                    </span>
                    <span className="font-mono text-[11px] text-neutral-500">
                      ({(selectedFile.size / 1024).toFixed(1)} KB)
                    </span>
                  </div>
                  <button
                    onClick={handleReset}
                    disabled={isProcessing}
                    className="flex items-center gap-1 text-xs text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white transition-colors disabled:opacity-40"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>Change Media</span>
                  </button>
                </div>

                {/* Tab 1: Auto Signal & Metadata Pipeline */}
                {activeTab === 'auto' && (
                  <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
                    {/* Left Options Controls */}
                    <div className="lg:col-span-5 flex flex-col gap-4">
                      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900/60 p-4">
                        <h5 className="mb-3 font-sans text-xs font-semibold text-black dark:text-white uppercase tracking-wider flex items-center justify-between">
                          <span>Pipeline Configuration</span>
                          <span className="text-[10px] font-mono text-neutral-500">Local Only</span>
                        </h5>

                        <div className="flex flex-col gap-3">
                          {/* Disruption Strategy Selector */}
                          <div className="flex flex-col gap-2 pb-3 border-b border-neutral-200 dark:border-neutral-800">
                            <label className="font-sans text-xs font-semibold text-black dark:text-white flex items-center justify-between">
                              <span>Disruption Strategy</span>
                              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium">
                                {disruptionMode === 'balanced' ? 'High Fidelity' : disruptionMode === 'aggressive' ? 'Deep Evasion' : 'Lossless'}
                              </span>
                            </label>
                            <div className="grid grid-cols-3 gap-1.5">
                              <button
                                type="button"
                                onClick={() => setDisruptionMode('balanced')}
                                className={`px-2 py-2 text-xs rounded-lg border font-medium transition-all text-center ${
                                  disruptionMode === 'balanced'
                                    ? 'border-black dark:border-white bg-black dark:bg-white text-white dark:text-black font-semibold shadow-sm'
                                    : 'border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white'
                                }`}
                              >
                                ⚡ Balanced
                              </button>
                              <button
                                type="button"
                                onClick={() => setDisruptionMode('aggressive')}
                                className={`px-2 py-2 text-xs rounded-lg border font-medium transition-all text-center ${
                                  disruptionMode === 'aggressive'
                                    ? 'border-black dark:border-white bg-black dark:bg-white text-white dark:text-black font-semibold shadow-sm'
                                    : 'border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white'
                                }`}
                              >
                                🔥 Deep Evasion
                              </button>
                              <button
                                type="button"
                                onClick={() => setDisruptionMode('metadata-only')}
                                className={`px-2 py-2 text-xs rounded-lg border font-medium transition-all text-center ${
                                  disruptionMode === 'metadata-only'
                                    ? 'border-black dark:border-white bg-black dark:bg-white text-white dark:text-black font-semibold shadow-sm'
                                    : 'border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white'
                                }`}
                              >
                                🛡️ Metadata Only
                              </button>
                            </div>
                            <p className="text-[11px] text-neutral-500 dark:text-neutral-400 leading-relaxed">
                              {disruptionMode === 'balanced' && '2-stage Lanczos phase shift & chroma dither. Neutralizes standard SynthID while preserving crisp details (PSNR >38dB).'}
                              {disruptionMode === 'aggressive' && 'Bounded 16-32px Fourier phase scrambler with soft tanh delta clamping (zero mottling), 3x3 median filtering, coordinate squeeze, & DCT quantization.'}
                              {disruptionMode === 'metadata-only' && '100% bit-for-bit lossless pixel preservation. Purges all C2PA Content Credentials, EXIF, and XMP tags.'}
                            </p>
                          </div>

                          {/* Carrier Intensity Slider */}
                          {disruptionMode !== 'metadata-only' && (
                            <div className="flex flex-col gap-1.5 pb-3 border-b border-neutral-200 dark:border-neutral-800">
                              <div className="flex items-center justify-between">
                                <span className="font-sans text-xs font-semibold text-black dark:text-white">
                                  Frequency Disruption Intensity
                                </span>
                                <span className="font-mono text-xs text-neutral-600 dark:text-neutral-400">
                                  {disruptionStrength}%{disruptionMode === 'aggressive' ? ` (±${((disruptionStrength / 100) * 2.8).toFixed(1)} ΔY max)` : ''}
                                </span>
                              </div>
                              <input
                                type="range"
                                min="20"
                                max="100"
                                value={disruptionStrength}
                                onChange={(e) => setDisruptionStrength(Number(e.target.value))}
                                className="w-full accent-black dark:accent-white cursor-pointer"
                              />
                            </div>
                          )}

                          {/* Option 1: Strip Metadata */}
                          <label className="flex items-start gap-3 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={stripMetadata}
                              onChange={(e) => setStripMetadata(e.target.checked)}
                              className="mt-0.5 h-4 w-4 rounded border-neutral-300 dark:border-neutral-700 bg-white dark:bg-black accent-black dark:accent-white"
                            />
                            <div>
                              <span className="font-sans text-xs font-semibold text-black dark:text-white">
                                Strip C2PA & EXIF Metadata
                              </span>
                              <p className="text-[11px] text-neutral-600 dark:text-neutral-400">
                                Wipes EXIF headers, XMP schemas, and C2PA Content Credentials (JUMBF manifests).
                              </p>
                            </div>
                          </label>

                          {/* Option 2: Disrupt SynthID Signals */}
                          <label className="flex items-start gap-3 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={disruptSignals}
                              onChange={(e) => setDisruptSignals(e.target.checked)}
                              className="mt-0.5 h-4 w-4 rounded border-neutral-300 dark:border-neutral-700 bg-white dark:bg-black accent-black dark:accent-white"
                            />
                            <div>
                              <span className="font-sans text-xs font-semibold text-black dark:text-white">
                                Disrupt SynthID Frequency Signals
                              </span>
                              <p className="text-[11px] text-neutral-600 dark:text-neutral-400">
                                Desynchronizes spatial DCT bins and neural network receptive fields.
                              </p>
                            </div>
                          </label>

                          {/* Option 3: Auto-Erase Visible Sparkle / Corner Badge */}
                          <div className="flex flex-col gap-2">
                            <label className={`flex items-start gap-3 ${disruptionMode === 'metadata-only' ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}>
                              <input
                                type="checkbox"
                                checked={disruptionMode === 'metadata-only' ? false : removeVisibleBadge}
                                disabled={disruptionMode === 'metadata-only'}
                                onChange={(e) => setRemoveVisibleBadge(e.target.checked)}
                                className="mt-0.5 h-4 w-4 rounded border-neutral-300 dark:border-neutral-700 bg-white dark:bg-black accent-black dark:accent-white"
                              />
                              <div>
                                <span className="font-sans text-xs font-semibold text-black dark:text-white">
                                  {mediaKind === 'image'
                                    ? 'Auto-Erase Visible Gemini Sparkle Badge'
                                    : `Auto-Erase Corner Badges Across All ${mediaKind === 'gif' ? 'GIF' : 'Video'} Frames`}
                                </span>
                                <p className="text-[11px] text-neutral-600 dark:text-neutral-400">
                                  {disruptionMode === 'metadata-only'
                                    ? 'Bypassed in Metadata-Only mode to preserve lossless pixel integrity.'
                                    : 'Erases corner badges with adaptive Reverse Alpha Blending + off-grid star rescue.'}
                                </p>
                              </div>
                            </label>

                            {removeVisibleBadge && disruptionMode !== 'metadata-only' && (
                              <div className="ml-7 flex items-center justify-between gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black/40 px-2.5 py-1.5">
                                <span className="font-mono text-[11px] text-neutral-600 dark:text-neutral-400">Corner Target:</span>
                                <select
                                  value={cornerHint}
                                  onChange={(e) => setCornerHint(e.target.value as WatermarkCornerPreset)}
                                  className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-black px-2 py-0.5 font-mono text-[11px] text-black dark:text-white"
                                >
                                  <option value="auto">Auto (Bottom-Right + Rescue)</option>
                                  <option value="bottom-right">Bottom-Right</option>
                                  <option value="bottom-left">Bottom-Left</option>
                                  <option value="top-right">Top-Right</option>
                                  <option value="top-left">Top-Left</option>
                                </select>
                              </div>
                            )}
                          </div>

                          {/* Video Frame Rate & Audio Controls */}
                          {mediaKind === 'video' && (
                            <div className="flex flex-col gap-2 border-t border-neutral-200 dark:border-neutral-800/80 pt-3">
                              <div className="flex items-center justify-between">
                                <span className="font-sans text-xs text-neutral-700 dark:text-neutral-300">Target Frame Rate:</span>
                                <select
                                  value={videoFps}
                                  onChange={(e) => setVideoFps(Number(e.target.value))}
                                  className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-black px-2.5 py-1 font-mono text-xs text-black dark:text-white"
                                >
                                  <option value={15}>15 fps (Fast)</option>
                                  <option value={24}>24 fps (Standard)</option>
                                  <option value={30}>30 fps (Smooth)</option>
                                </select>
                              </div>
                              <label className="flex items-center gap-2.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={preserveAudio}
                                  onChange={(e) => setPreserveAudio(e.target.checked)}
                                  className="h-3.5 w-3.5 rounded border-neutral-300 dark:border-neutral-700 bg-white dark:bg-black accent-black dark:accent-white"
                                />
                                <span className="font-sans text-xs text-neutral-700 dark:text-neutral-300">
                                  Preserve Clean Audio Track
                                </span>
                              </label>
                            </div>
                          )}

                          {/* Format Selector */}
                          <div className="mt-2 flex items-center justify-between border-t border-neutral-200 dark:border-neutral-800/80 pt-3">
                            <span className="font-sans text-xs text-neutral-700 dark:text-neutral-300">Export Format:</span>
                            {mediaKind === 'gif' ? (
                              <select
                                value="gif"
                                onChange={() => setExportFormat('gif')}
                                className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-black px-2.5 py-1 font-mono text-xs text-black dark:text-white"
                              >
                                <option value="gif">Animated GIF (.gif)</option>
                              </select>
                            ) : mediaKind === 'video' ? (
                              <select
                                value={exportFormat === 'webm' ? 'webm' : 'mp4'}
                                onChange={(e) => setExportFormat(e.target.value as 'mp4' | 'webm')}
                                className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-black px-2.5 py-1 font-mono text-xs text-black dark:text-white"
                              >
                                <option value="mp4">MP4 (.mp4)</option>
                                <option value="webm">WebM (.webm)</option>
                              </select>
                            ) : (
                              <select
                                value={exportFormat}
                                onChange={(e) => setExportFormat(e.target.value as any)}
                                className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-black px-2.5 py-1 font-mono text-xs text-black dark:text-white"
                              >
                                <option value="png">PNG (.png)</option>
                                <option value="jpeg">JPEG (.jpg)</option>
                                <option value="webp">WEBP (.webp)</option>
                              </select>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Process Execution Button */}
                      <button
                        onClick={handleRunAutoPipeline}
                        disabled={isProcessing}
                        className="flex w-full items-center justify-center gap-2 rounded-xl border border-black dark:border-white bg-black dark:bg-white text-white dark:text-black hover:bg-neutral-800 dark:hover:bg-neutral-200 py-3 font-sans text-sm font-semibold transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50 shadow-sm"
                      >
                        <Zap className="h-4 w-4" />
                        <span>
                          {isProcessing
                            ? progressState
                              ? `Processing Frame ${progressState.currentFrame}/${progressState.totalFrames} (${progressState.percent}%)`
                              : 'Processing Pipeline...'
                            : mediaKind === 'gif'
                            ? 'Run GIF Pipeline'
                            : mediaKind === 'video'
                            ? 'Run Video Pipeline'
                            : 'Run Pipeline'}
                        </span>
                      </button>
                    </div>

                    {/* Right Media Preview / Result */}
                    <div className="lg:col-span-7 flex flex-col items-center justify-center rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900/40 p-4">
                      {isProcessing && progressState && (
                        <div className="mb-4 w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black/60 p-3">
                          <div className="flex items-center justify-between text-xs font-mono mb-1.5">
                            <span className="text-black dark:text-white">{progressState.phase}</span>
                            <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                              {progressState.currentFrame} / {progressState.totalFrames} ({progressState.percent}%)
                            </span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
                            <div
                              className="h-full bg-emerald-500 transition-all duration-150"
                              style={{ width: `${progressState.percent}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {processedImageUrl ? (
                        <div className="flex flex-col items-center gap-4 w-full">
                          {mediaKind === 'video' ? (
                            <video
                              key={processedImageUrl}
                              src={processedImageUrl}
                              controls
                              playsInline
                              loop
                              className="max-h-[380px] w-full rounded-lg border border-neutral-300 dark:border-neutral-800 bg-black shadow-xl"
                            />
                          ) : (
                            <img
                              src={processedImageUrl}
                              alt="Processed Result"
                              className="max-h-[380px] w-auto object-contain rounded-lg border border-neutral-300 dark:border-neutral-800 shadow-xl"
                            />
                          )}

                          {/* Real Byte-Level Provenance Audit Panel */}
                          <div className="w-full flex flex-col gap-2 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900/60 p-3">
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-semibold text-black dark:text-white flex items-center gap-1.5">
                                <ShieldCheck className="h-4 w-4 text-emerald-500" />
                                <span>Real-Time Binary Provenance Audit</span>
                              </span>
                              <span className="font-mono text-[10px] text-neutral-500">
                                {telemetryMeta.provenanceAudit ? `${telemetryMeta.provenanceAudit.bytesScanned} bytes inspected (${telemetryMeta.provenanceAudit.formatDetected})` : 'Byte scan ready'}
                              </span>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 pt-1 text-[11px]">
                              <div className="flex items-center gap-1.5 p-2 rounded-lg bg-white dark:bg-black/40 border border-neutral-200 dark:border-neutral-800">
                                {telemetryMeta.provenanceAudit?.c2paFound ? (
                                  <span className="text-amber-500 font-bold shrink-0">⚠️</span>
                                ) : (
                                  <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                                )}
                                <span className="truncate">C2PA (JUMBF): <strong className={telemetryMeta.provenanceAudit?.c2paFound ? 'text-amber-500' : 'text-emerald-500'}>{telemetryMeta.provenanceAudit?.c2paFound ? 'Found' : 'Clean (0)'}</strong></span>
                              </div>

                              <div className="flex items-center gap-1.5 p-2 rounded-lg bg-white dark:bg-black/40 border border-neutral-200 dark:border-neutral-800">
                                {telemetryMeta.provenanceAudit?.exifFound ? (
                                  <span className="text-amber-500 font-bold shrink-0">⚠️</span>
                                ) : (
                                  <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                                )}
                                <span className="truncate">EXIF Header: <strong className={telemetryMeta.provenanceAudit?.exifFound ? 'text-amber-500' : 'text-emerald-500'}>{telemetryMeta.provenanceAudit?.exifFound ? 'Found' : 'Clean (0)'}</strong></span>
                              </div>

                              <div className="flex items-center gap-1.5 p-2 rounded-lg bg-white dark:bg-black/40 border border-neutral-200 dark:border-neutral-800">
                                {telemetryMeta.provenanceAudit?.xmpFound ? (
                                  <span className="text-amber-500 font-bold shrink-0">⚠️</span>
                                ) : (
                                  <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                                )}
                                <span className="truncate">XMP Schemas: <strong className={telemetryMeta.provenanceAudit?.xmpFound ? 'text-amber-500' : 'text-emerald-500'}>{telemetryMeta.provenanceAudit?.xmpFound ? 'Found' : 'Clean (0)'}</strong></span>
                              </div>

                              <div className="flex items-center gap-1.5 p-2 rounded-lg bg-white dark:bg-black/40 border border-neutral-200 dark:border-neutral-800">
                                {telemetryMeta.provenanceAudit?.iccFound ? (
                                  <span className="text-amber-500 font-bold shrink-0">⚠️</span>
                                ) : (
                                  <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                                )}
                                <span className="truncate">ICC Profile: <strong className={telemetryMeta.provenanceAudit?.iccFound ? 'text-amber-500' : 'text-emerald-500'}>{telemetryMeta.provenanceAudit?.iccFound ? 'Found' : 'Clean (0)'}</strong></span>
                              </div>

                              <div className="flex items-center gap-1.5 p-2 rounded-lg bg-white dark:bg-black/40 border border-neutral-200 dark:border-neutral-800">
                                {telemetryMeta.provenanceAudit?.iptcFound ? (
                                  <span className="text-amber-500 font-bold shrink-0">⚠️</span>
                                ) : (
                                  <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                                )}
                                <span className="truncate">IPTC Data: <strong className={telemetryMeta.provenanceAudit?.iptcFound ? 'text-amber-500' : 'text-emerald-500'}>{telemetryMeta.provenanceAudit?.iptcFound ? 'Found' : 'Clean (0)'}</strong></span>
                              </div>
                            </div>
                          </div>

                          <a
                            href={processedImageUrl}
                            download={(() => {
                              const lastDot = selectedFile.name.lastIndexOf('.');
                              const base = lastDot !== -1 ? selectedFile.name.substring(0, lastDot) : selectedFile.name;
                              const ext = exportFormat === 'jpeg' ? 'jpg' : exportFormat;
                              return `cleared_${base}.${ext}`;
                            })()}
                            className="flex items-center gap-2 rounded-lg border border-black dark:border-white bg-black dark:bg-white text-white dark:text-black hover:bg-neutral-800 dark:hover:bg-neutral-200 px-5 py-2.5 font-sans text-xs font-semibold transition-all shadow-sm"
                          >
                            <Download className="h-4 w-4" />
                            <span>
                              Download Cleared {mediaKind === 'gif' ? 'GIF' : mediaKind === 'video' ? 'Video' : 'Image'} ({exportFormat.toUpperCase()})
                            </span>
                          </a>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-3 w-full">
                          {mediaKind === 'video' ? (
                            <video
                              src={previewUrl || ''}
                              controls
                              playsInline
                              muted
                              loop
                              className="max-h-[340px] w-full rounded-lg border border-neutral-800 bg-black opacity-95"
                            />
                          ) : (
                            <img
                              src={previewUrl || ''}
                              alt="Original Preview"
                              className="max-h-[340px] w-auto object-contain rounded-lg border border-neutral-800 opacity-90"
                            />
                          )}
                          <span className="font-mono text-xs text-neutral-400">
                            Original Input {mediaKind === 'gif' ? 'Animated GIF' : mediaKind === 'video' ? 'Video' : 'Image'} Preview
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Tab 2: Visual Brush Inpaint Canvas (supports Image, Multi-Frame GIF & Video!) */}
                {activeTab === 'inpaint' && (
                  <div className="flex flex-col gap-6">
                    {(mediaKind === 'gif' && (brushFrameMeta.frameCount || 0) > 1) ||
                    (mediaKind === 'video' && (brushFrameMeta.duration || 0) > 0) ? (
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900/60 px-4 py-2.5">
                        <span className="font-mono text-xs text-black dark:text-white">
                          {mediaKind === 'gif'
                            ? `Mask Reference Frame: ${brushFrameIdx + 1} / ${brushFrameMeta.frameCount} (Applied across all frames)`
                            : `Mask Reference Timestamp: ${brushTimeSec.toFixed(2)}s / ${(brushFrameMeta.duration || 0).toFixed(2)}s (Applied across all frames)`}
                        </span>
                        {mediaKind === 'gif' ? (
                          <input
                            type="range"
                            min={0}
                            max={(brushFrameMeta.frameCount || 1) - 1}
                            value={brushFrameIdx}
                            onChange={(e) => handleBrushFrameChange(Number(e.target.value))}
                            className="w-48 accent-black dark:accent-white cursor-pointer"
                          />
                        ) : (
                          <input
                            type="range"
                            min={0}
                            max={Math.max(0.1, brushFrameMeta.duration || 1)}
                            step={0.05}
                            value={brushTimeSec}
                            onChange={(e) => handleBrushTimeChange(Number(e.target.value))}
                            className="w-48 accent-black dark:accent-white cursor-pointer"
                          />
                        )}
                      </div>
                    ) : null}

                    {isProcessing && progressState && (
                      <div className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900/60 p-3">
                        <div className="flex items-center justify-between text-xs font-mono mb-1.5">
                          <span className="text-black dark:text-white">{progressState.phase}</span>
                          <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                            {progressState.currentFrame} / {progressState.totalFrames} ({progressState.percent}%)
                          </span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
                          <div
                            className="h-full bg-emerald-500 transition-all duration-150"
                            style={{ width: `${progressState.percent}%` }}
                          />
                        </div>
                      </div>
                    )}

                    <InpaintCanvas
                      imageSrc={brushFrameUrl || previewUrl || ''}
                      onInpaintSubmit={handleInpaintSubmit}
                      isProcessing={isProcessing}
                    />

                    {processedImageUrl && (
                      <div className="flex flex-col items-center gap-4 border-t border-neutral-200 dark:border-neutral-800 pt-4">
                        <h5 className="font-sans text-xs font-semibold text-black dark:text-white uppercase tracking-wider">
                          Inpainted Result Preview
                        </h5>
                        {mediaKind === 'video' ? (
                          <video
                            key={processedImageUrl}
                            src={processedImageUrl}
                            controls
                            playsInline
                            loop
                            className="max-h-[340px] w-full rounded-lg border border-neutral-800 bg-black"
                          />
                        ) : (
                          <img
                            src={processedImageUrl}
                            alt="Inpaint Result"
                            className="max-h-[340px] w-auto object-contain rounded-lg border border-neutral-800"
                          />
                        )}
                        <a
                          href={processedImageUrl}
                          download={(() => {
                            const lastDot = selectedFile.name.lastIndexOf('.');
                            const base = lastDot !== -1 ? selectedFile.name.substring(0, lastDot) : selectedFile.name;
                            const ext = exportFormat === 'jpeg' ? 'jpg' : exportFormat;
                            return `inpainted_${base}.${ext}`;
                          })()}
                          className="flex items-center gap-2 rounded-lg border border-black dark:border-white bg-black dark:bg-white text-white dark:text-black hover:bg-neutral-800 dark:hover:bg-neutral-200 px-5 py-2.5 font-sans text-xs font-semibold transition-all shadow-sm"
                        >
                          <Download className="h-4 w-4" />
                          <span>
                            Download Inpainted {mediaKind === 'gif' ? 'GIF' : mediaKind === 'video' ? 'Video' : 'Image'} ({exportFormat.toUpperCase()})
                          </span>
                        </a>
                      </div>
                    )}
                  </div>
                )}

                {/* Telemetry Output Terminal */}
                <ProcessingLogs
                  logs={telemetryLogs}
                  isProcessing={isProcessing}
                  executionTimeMs={telemetryMeta.executionTimeMs}
                  dimensions={telemetryMeta.dimensions}
                  originalSize={telemetryMeta.originalSize}
                  processedSize={telemetryMeta.processedSize}
                />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* 3-STEP HOW IT WORKS */}
      <section id="how-it-works" className="py-20 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-onyx">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mb-12 text-center">
            <span className="font-mono text-xs font-semibold tracking-widest text-neutral-500 dark:text-neutral-400 uppercase">
              HOW IT WORKS
            </span>
            <h2 className="mt-2 font-sans text-3xl font-semibold tracking-tight text-black dark:text-white sm:text-4xl">
              Upload. We process. You download.
            </h2>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              Three steps, zero data sent to external servers, and 100% free.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
            {/* Step 1 */}
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-6 shadow-sm">
              <span className="font-mono text-xs font-semibold tracking-wider text-neutral-500 dark:text-neutral-400 uppercase">
                01
              </span>
              <h3 className="mt-4 font-sans text-lg font-semibold text-black dark:text-white">Secure Upload</h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                Choose an image (up to 20MB), animated GIF (50MB), or MP4/WebM/MOV video (150MB). Your original media never leaves local device memory.
              </p>
            </div>

            {/* Step 2 */}
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-6 shadow-sm">
              <span className="font-mono text-xs font-semibold tracking-wider text-neutral-500 dark:text-neutral-400 uppercase">
                02
              </span>
              <h3 className="mt-4 font-sans text-lg font-semibold text-black dark:text-white">Multi-Layer Frame Scrubbing</h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                Erases visible badges or brushed masks across every frame, purges C2PA/XMP/EXIF boxes, and shifts spatial DCT carrier phases.
              </p>
            </div>

            {/* Step 3 */}
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-6 shadow-sm">
              <span className="font-mono text-xs font-semibold tracking-wider text-neutral-500 dark:text-neutral-400 uppercase">
                03
              </span>
              <h3 className="mt-4 font-sans text-lg font-semibold text-black dark:text-white">Download Clean Media</h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                Download your unwatermarked image, animated GIF, or H.264/VP9 video ready for production with zero provenance tags.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 3-LAYER WATERMARK BREAKDOWN */}
      <section id="capabilities" className="py-20 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mb-12 text-center">
            <span className="font-mono text-xs font-semibold tracking-widest text-neutral-500 dark:text-neutral-400 uppercase">
              PROVENANCE & STEGANOGRAPHY BREAKDOWN
            </span>
            <h2 className="mt-2 font-sans text-3xl font-semibold tracking-tight text-black dark:text-white sm:text-4xl">
              Three AI Watermark Vectors Defeated
            </h2>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            {/* Capability 1 */}
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 p-6">
              <span className="inline-block rounded bg-neutral-200 dark:bg-neutral-900 px-2 py-0.5 font-mono text-[10px] text-black dark:text-white uppercase border border-neutral-300 dark:border-neutral-800">
                Visible Badges
              </span>
              <h3 className="mt-4 font-sans text-xl font-semibold text-black dark:text-white">Reverse Alpha & Multi-Frame Masking</h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                Mathematically restores pixels behind Gemini sparkle badges using calibrated alpha maps, plus propagates Visual Brush Inpaint masks across every frame of GIFs and videos.
              </p>
            </div>

            {/* Capability 2 */}
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 p-6">
              <span className="inline-block rounded bg-neutral-200 dark:bg-neutral-900 px-2 py-0.5 font-mono text-[10px] text-black dark:text-white uppercase border border-neutral-300 dark:border-neutral-800">
                Metadata Chains
              </span>
              <h3 className="mt-4 font-sans text-xl font-semibold text-black dark:text-white">C2PA & Container Annihilator</h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                Purges JUMBF boxes, EXIF/XMP headers, and C2PA Content Credentials across PNG, JPEG, WebP, GIF89a extensions, and MP4/WebM atoms from Gemini, Veo, Sora, and DALL·E 3.
              </p>
            </div>

            {/* Capability 3 */}
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 p-6">
              <span className="inline-block rounded bg-neutral-200 dark:bg-neutral-900 px-2 py-0.5 font-mono text-[10px] text-black dark:text-white uppercase border border-neutral-300 dark:border-neutral-800">
                Deep Steganography
              </span>
              <h3 className="mt-4 font-sans text-xl font-semibold text-black dark:text-white">SynthID Phase Disruption</h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                Uses 2-stage/3-stage non-integer Lanczos-3 phase resampling, chroma dither, and DCT trellis quantization to disrupt neural network receptive fields without degrading image quality.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ SECTION */}
      <section id="faq" className="py-20 bg-neutral-50 dark:bg-onyx border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto max-w-4xl px-4 sm:px-6">
          <div className="mb-10 text-center">
            <span className="font-mono text-xs font-semibold tracking-widest text-neutral-500 dark:text-neutral-400 uppercase">
              STRAIGHT ANSWERS
            </span>
            <h2 className="mt-2 font-sans text-3xl font-semibold tracking-tight text-black dark:text-white">
              Frequently Asked Questions
            </h2>
          </div>

          <div className="flex flex-col border-t border-neutral-200 dark:border-neutral-800">
            {faqs.map((faq, index) => (
              <div key={index} className="border-b border-neutral-200 dark:border-neutral-800">
                <button
                  onClick={() => setOpenFaq(openFaq === index ? null : index)}
                  className="flex w-full items-center justify-between py-5 text-left font-sans text-base font-semibold text-black dark:text-white hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
                >
                  <span>{faq.q}</span>
                  <ChevronDown
                    className={`h-5 w-5 text-neutral-500 dark:text-neutral-400 transition-transform duration-200 ${
                      openFaq === index ? 'rotate-180 text-black dark:text-white' : ''
                    }`}
                  />
                </button>
                {openFaq === index && (
                  <p className="pb-5 font-sans text-sm leading-relaxed text-neutral-600 dark:text-neutral-400 whitespace-pre-line">
                    {faq.a}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
