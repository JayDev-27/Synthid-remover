import sharp from 'sharp';
import {
  processImagePipeline,
  scanBufferProvenance,
  applyBoundedFourierScramble,
  applyInpaintMask,
  stripMetadata,
  disruptEmbeddedSignals,
  removeCornerBadge,
} from '../lib/imageProcessor.ts';

async function probe() {
  console.log('--- TEST 1: TINY IMAGES ---');
  const tinySizes = [
    { w: 1, h: 1 },
    { w: 8, h: 8 },
    { w: 16, h: 16 },
    { w: 127, h: 313 },
  ];

  for (const size of tinySizes) {
    try {
      const buf = await sharp({
        create: {
          width: size.w,
          height: size.h,
          channels: 4,
          background: { r: 120, g: 60, b: 200, alpha: 1 },
        },
      }).png().toBuffer();

      console.log(`Testing size ${size.w}x${size.h}...`);
      for (const mode of ['metadata-only', 'balanced', 'aggressive']) {
        const res = await processImagePipeline(buf, {
          disruptionMode: mode,
          disruptionStrength: 75,
          targetFormat: 'png',
        });
        const outMeta = await sharp(res.buffer).metadata();
        console.log(`  Mode: ${mode} -> out dims: ${outMeta.width}x${outMeta.height}, time: ${res.telemetry.executionTimeMs}ms`);
      }
    } catch (e) {
      console.error(`  ERROR on ${size.w}x${size.h}:`, e);
    }
  }
}

probe().catch(console.error);
