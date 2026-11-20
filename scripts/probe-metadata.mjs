import sharp from 'sharp';
import { processImagePipeline, stripMetadata } from '../lib/imageProcessor.ts';

async function probeMetadataOnly() {
  console.log('--- TEST 4: METADATA-ONLY BIT-FOR-BIT IDENTITY ACROSS CHANNELS/COLORSPACES ---');

  const testCases = [
    {
      name: 'RGB (3 channels)',
      create: () => sharp({
        create: {
          width: 50,
          height: 50,
          channels: 3,
          background: { r: 111, g: 222, b: 33 },
        },
      }).png().toBuffer(),
    },
    {
      name: 'RGBA (4 channels)',
      create: () => sharp({
        create: {
          width: 50,
          height: 50,
          channels: 4,
          background: { r: 50, g: 150, b: 250, alpha: 0.7 },
        },
      }).png().toBuffer(),
    },
    {
      name: 'Grayscale (1 channel)',
      create: () => sharp({
        create: {
          width: 50,
          height: 50,
          channels: 3,
          background: { r: 142, g: 142, b: 142 },
        },
      }).toColourspace('b-w').png().toBuffer(),
    },
    {
      name: 'CMYK (4 channels)',
      create: () => sharp({
        create: {
          width: 50,
          height: 50,
          channels: 3,
          background: { r: 100, g: 150, b: 200 },
        },
      }).toColourspace('cmyk').jpeg().toBuffer(),
    },
  ];

  for (const tc of testCases) {
    const inputBuf = await tc.create();
    const inMeta = await sharp(inputBuf).metadata();

    const res = await processImagePipeline(inputBuf, {
      disruptionMode: 'metadata-only',
      targetFormat: 'png',
    });

    // Check pixel-for-pixel identity
    const { data: dIn, info: iIn } = await sharp(inputBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { data: dOut, info: iOut } = await sharp(res.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    let diffCount = 0;
    let maxDiff = 0;
    for (let i = 0; i < dIn.length; i++) {
      const diff = Math.abs(dIn[i] - dOut[i]);
      if (diff > 0) {
        diffCount++;
        if (diff > maxDiff) maxDiff = diff;
      }
    }

    console.log(`Test: ${tc.name} (${inMeta.channels} ch, space: ${inMeta.space}, fmt: ${inMeta.format})`);
    console.log(`  Output: ${iOut.channels} ch, dims: ${iOut.width}x${iOut.height}`);
    if (diffCount === 0) {
      console.log(`  ✅ 100% Bit-for-bit lossless identity verified (diffCount: 0)`);
    } else {
      console.log(`  ⚠️ Differences found: ${diffCount} bytes differed, maxDiff: ${maxDiff}`);
    }
  }
}

probeMetadataOnly().catch(console.error);
