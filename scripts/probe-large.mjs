import sharp from 'sharp';
import {
  applyBoundedFourierScramble,
  processImagePipeline,
} from '../lib/imageProcessor.ts';

async function probeLarge() {
  console.log('--- TEST 2: LARGE IMAGE RESOLUTION & FOURIER SCALING ---');
  const sizes = [512, 1024, 2048];

  for (const dim of sizes) {
    console.log(`\nGenerating ${dim}x${dim} gradient image...`);
    const buf = await sharp({
      create: {
        width: dim,
        height: dim,
        channels: 4,
        background: { r: 100, g: 150, b: 200, alpha: 1 },
      },
    }).png().toBuffer();

    const memBefore = process.memoryUsage();
    const t0 = performance.now();

    const res = await processImagePipeline(buf, {
      disruptionMode: 'aggressive',
      disruptionStrength: 75,
      targetFormat: 'png',
    });

    const t1 = performance.now();
    const memAfter = process.memoryUsage();

    console.log(`Dimensions: ${dim}x${dim}`);
    console.log(`  Execution Time: ${(t1 - t0).toFixed(1)} ms (Pipeline reported: ${res.telemetry.executionTimeMs} ms)`);
    console.log(`  Heap Used Delta: ${((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`  RSS Delta: ${((memAfter.rss - memBefore.rss) / (1024 * 1024)).toFixed(2)} MB`);
  }
}

probeLarge().catch(console.error);
