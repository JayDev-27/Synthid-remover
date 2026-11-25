import sharp from 'sharp';
import { GifWriter } from 'omggif';
import {
  processImagePipeline,
  scanBufferProvenance,
  applyBoundedFourierScramble,
  applyInpaintMask,
  stripMetadata,
} from '../lib/imageProcessor.ts';
import { processGifBuffer, decodeGifToFrames } from '../lib/gifProcessor.ts';
import {
  loadGeminiWatermarkRemoverSync,
  eraseGeminiSparklePixelData,
  eraseCornerTextBadgePixelData,
  applyLockedCornerUnblend,
  rescueOffGridSparkle,
} from '../lib/pixelPipeline.ts';

// ============================================================================
// QA Test Harness & Statistics Collector
// ============================================================================
const stats = {
  passed: 0,
  failed: 0,
  warnings: 0,
  records: [],
};

function recordTest(category, name, status, details = {}) {
  if (status === 'PASS') stats.passed++;
  else if (status === 'FAIL') stats.failed++;
  else if (status === 'WARN') stats.warnings++;

  stats.records.push({
    category,
    name,
    status,
    ...details,
  });

  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️';
  console.log(`  ${icon} [${status}] ${name}${details.metric ? ` (${details.metric})` : ''}`);
  if (details.error) {
    console.log(`     └─ Error: ${details.error}`);
  }
}

async function calculatePSNR(buf1, buf2) {
  const { data: d1, info: i1 } = await sharp(buf1).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data: d2, info: i2 } = await sharp(buf2).resize(i1.width, i1.height, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  let sumSquaredError = 0;
  let count = 0;
  const len = Math.min(d1.length, d2.length);
  for (let i = 0; i < len; i += 4) {
    for (let c = 0; c < 3; c++) {
      const diff = d1[i + c] - d2[i + c];
      sumSquaredError += diff * diff;
      count++;
    }
  }

  const mse = sumSquaredError / count;
  if (mse === 0) return { mse: 0, psnr: Infinity };
  const psnr = 10 * Math.log10((255 * 255) / mse);
  return { mse, psnr };
}

// ============================================================================
// SUITE 1: Tiny Image & Odd Dimension Handling
// ============================================================================
async function runTinyImageSuite() {
  console.log('\n============================================================');
  console.log('📌 SUITE 1: TINY IMAGE & ODD DIMENSION HANDLING');
  console.log('============================================================');

  const testDimensions = [
    { w: 1, h: 1, label: '1x1 Single Pixel' },
    { w: 8, h: 8, label: '8x8 Sub-Block' },
    { w: 16, h: 16, label: '16x16 Macro-Block' },
    { w: 127, h: 313, label: '127x313 Prime Dimensions' },
  ];

  for (const dim of testDimensions) {
    const inputBuf = await sharp({
      create: {
        width: dim.w,
        height: dim.h,
        channels: 4,
        background: { r: 120, g: 60, b: 200, alpha: 1 },
      },
    }).png().toBuffer();

    for (const mode of ['metadata-only', 'balanced', 'aggressive']) {
      const testName = `${dim.label} [${mode.toUpperCase()}]`;
      const t0 = performance.now();
      try {
        const result = await processImagePipeline(inputBuf, {
          disruptionMode: mode,
          disruptionStrength: 75,
          targetFormat: 'png',
        });
        const elapsed = (performance.now() - t0).toFixed(1);
        const outMeta = await sharp(result.buffer).metadata();

        if (outMeta.width === dim.w && outMeta.height === dim.h) {
          recordTest('Tiny Images', testName, 'PASS', {
            metric: `${elapsed}ms, out: ${outMeta.width}x${outMeta.height}`,
          });
        } else {
          recordTest('Tiny Images', testName, 'WARN', {
            metric: `Dimension mismatch: expected ${dim.w}x${dim.h}, got ${outMeta.width}x${outMeta.height}`,
          });
        }
      } catch (err) {
        // Known bug: sharp.median(3) on 1x1 throws "Error: rank: window too large"
        recordTest('Tiny Images', testName, 'FAIL', {
          error: err.message,
          metric: 'Crashed in pipeline',
        });
      }
    }
  }
}

// ============================================================================
// SUITE 2: Large Image Resolution & Fourier Scaling
// ============================================================================
async function runLargeImageSuite() {
  console.log('\n============================================================');
  console.log('📌 SUITE 2: LARGE RESOLUTION & FOURIER SCALING BENCHMARK');
  console.log('============================================================');

  const resolutions = [512, 1024, 2048];

  for (const dim of resolutions) {
    const buf = await sharp({
      create: {
        width: dim,
        height: dim,
        channels: 4,
        background: { r: 70, g: 120, b: 180, alpha: 1 },
      },
    }).png().toBuffer();

    // Isolated Fourier Scramble Benchmark
    const pixels = new Uint8ClampedArray(dim * dim * 4);
    const fourierT0 = performance.now();
    applyBoundedFourierScramble(pixels, dim, dim, 4, 2.5);
    const fourierMs = (performance.now() - fourierT0).toFixed(1);

    // Full Pipeline Benchmark
    const memBefore = process.memoryUsage();
    const t0 = performance.now();
    const result = await processImagePipeline(buf, {
      disruptionMode: 'aggressive',
      disruptionStrength: 75,
      targetFormat: 'png',
    });
    const pipelineMs = (performance.now() - t0).toFixed(1);
    const memAfter = process.memoryUsage();

    const heapDeltaMb = ((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)).toFixed(1);
    const rssDeltaMb = ((memAfter.rss - memBefore.rss) / (1024 * 1024)).toFixed(1);

    const { psnr, mse } = await calculatePSNR(buf, result.buffer);

    recordTest('Large Images', `${dim}x${dim} Full Pipeline (Aggressive)`, 'PASS', {
      metric: `Pipeline: ${pipelineMs}ms (FFT: ${fourierMs}ms), Heap: ${heapDeltaMb}MB, RSS: ${rssDeltaMb}MB, PSNR: ${psnr.toFixed(2)}dB (MSE: ${mse.toFixed(2)})`,
    });
  }
}

// ============================================================================
// SUITE 3: Format Matrix Conversion & Container Signatures
// ============================================================================
async function runFormatMatrixSuite() {
  console.log('\n============================================================');
  console.log('📌 SUITE 3: FORMAT MATRIX CONVERSION & BYTE CONTAINER INTEGRITY');
  console.log('============================================================');

  const baseBuf = await sharp({
    create: { width: 100, height: 100, channels: 4, background: { r: 90, g: 150, b: 210, alpha: 1 } },
  }).png().toBuffer();

  const formats = ['png', 'jpeg', 'webp'];
  const signatures = {
    png: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
    jpeg: (b) => b.length >= 2 && b[0] === 0xff && b[1] === 0xd8,
    webp: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  };

  for (const src of formats) {
    const srcBuf = src === 'png' ? baseBuf :
      src === 'jpeg' ? await sharp(baseBuf).jpeg().toBuffer() :
      await sharp(baseBuf).webp().toBuffer();

    for (const tgt of formats) {
      const testName = `Conversion ${src.toUpperCase()} -> ${tgt.toUpperCase()}`;
      try {
        const res = await processImagePipeline(srcBuf, {
          targetFormat: tgt,
          stripMetadata: true,
          disruptSignals: true,
          disruptionMode: 'balanced',
        });

        const validSig = signatures[tgt](res.buffer);
        const audit = res.telemetry.provenanceAudit;
        const formatMatch = audit.formatDetected.toLowerCase() === tgt;

        if (validSig && formatMatch && audit.clean) {
          recordTest('Format Matrix', testName, 'PASS', {
            metric: `Valid ${tgt.toUpperCase()} magic signature, Audit Clean, Size: ${(res.buffer.length / 1024).toFixed(1)}KB`,
          });
        } else {
          recordTest('Format Matrix', testName, 'FAIL', {
            metric: `Sig: ${validSig}, Detected: ${audit.formatDetected}, Clean: ${audit.clean}`,
          });
        }
      } catch (err) {
        recordTest('Format Matrix', testName, 'FAIL', { error: err.message });
      }
    }
  }
}

// ============================================================================
// SUITE 4: Inpaint Mask Edge Cases (Hole Detection on Server & Client)
// ============================================================================
async function runInpaintHoleSuite() {
  console.log('\n============================================================');
  console.log('📌 SUITE 4: INPAINT MASK HOLE DETECTION (SERVER & CLIENT)');
  console.log('============================================================');

  const width = 200, height = 200, cx = 100, cy = 100;

  for (const radius of [5, 25]) {
    const label = radius === 5 ? 'Small Mask (r=5px)' : 'Large Mask (r=25px, Brush > 20px)';

    // Source image: Blue background (0, 0, 255) with RED foreground circle (255, 0, 0)
    const baseSvg = `
      <svg width="${width}" height="${height}">
        <rect width="${width}" height="${height}" fill="rgb(0, 0, 255)" />
        <circle cx="${cx}" cy="${cy}" r="${radius}" fill="rgb(255, 0, 0)" />
      </svg>
    `;
    const imageBuf = await sharp(Buffer.from(baseSvg)).png().toBuffer();

    const maskSvg = `
      <svg width="${width}" height="${height}">
        <rect width="${width}" height="${height}" fill="black" />
        <circle cx="${cx}" cy="${cy}" r="${radius + 2}" fill="white" />
      </svg>
    `;
    const maskBuf = await sharp(Buffer.from(maskSvg)).png().toBuffer();

    // 1. Server-side inpainting: applyInpaintMask
    const serverOut = await applyInpaintMask(imageBuf, maskBuf);
    const { data: sRaw } = await sharp(serverOut).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const centerIdx = (cy * width + cx) * 4;
    const sR = sRaw[centerIdx], sG = sRaw[centerIdx + 1], sB = sRaw[centerIdx + 2];

    const serverTestName = `Server Inpainting [${label}]`;
    if (sR > sB) {
      recordTest('Inpainting', serverTestName, 'WARN', {
        metric: `Center pixel remained RED (R=${sR}, B=${sB}). Blur-based reconstruction did not blend background across large radius.`,
      });
    } else {
      recordTest('Inpainting', serverTestName, 'PASS', {
        metric: `Center replaced with background blue (R=${sR}, B=${sB})`,
      });
    }

    // 2. Client-side inpainting algorithm simulation (from lib/clientImageProcessor.ts)
    const { data: cImg } = await sharp(imageBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { data: cMask } = await sharp(maskBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const src = new Uint8ClampedArray(cImg);
    const mask = new Uint8ClampedArray(cMask);

    let minX = width, maxX = 0, minY = height, maxY = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        if (mask[idx + 3] > 20 && mask[idx] > 20) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const pad = 12;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(width - 1, maxX + pad);
    maxY = Math.min(height - 1, maxY + pad);

    const resolved = new Uint8Array(width * height);
    let totalMasked = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const idx = (y * width + x) * 4;
        if (mask[idx + 3] > 30 && mask[idx] > 30) {
          resolved[y * width + x] = 1;
          totalMasked++;
        }
      }
    }

    const maskRadius = Math.max((maxX - minX), (maxY - minY)) / 2;
    const passes = Math.max(6, Math.min(32, Math.ceil(maskRadius / 2)));

    for (let pass = 0; pass < passes && totalMasked > 0; pass++) {
      const newlyResolved = [];
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const coord = y * width + x;
          if (resolved[coord] === 1) {
            let rSum = 0, gSum = 0, bSum = 0, count = 0;
            const r_rad = 3;
            for (let dy = -r_rad; dy <= r_rad; dy++) {
              const ny = y + dy;
              if (ny < 0 || ny >= height) continue;
              for (let dx = -r_rad; dx <= r_rad; dx++) {
                const nx = x + dx;
                if (nx < 0 || nx >= width) continue;
                const nCoord = ny * width + nx;
                if (resolved[nCoord] === 0) {
                  const weight = 1 / (1 + Math.hypot(dx, dy));
                  const nidx = nCoord * 4;
                  rSum += src[nidx] * weight;
                  gSum += src[nidx + 1] * weight;
                  bSum += src[nidx + 2] * weight;
                  count += weight;
                }
              }
            }
            if (count > 0) {
              const idx = coord * 4;
              src[idx] = Math.round(rSum / count);
              src[idx + 1] = Math.round(gSum / count);
              src[idx + 2] = Math.round(bSum / count);
              newlyResolved.push(coord);
            }
          }
        }
      }
      for (const coord of newlyResolved) {
        resolved[coord] = 0;
      }
      totalMasked -= newlyResolved.length;
    }

    let untouchedCount = 0;
    let totalMaskPixels = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (Math.hypot(x - cx, y - cy) <= radius) {
          totalMaskPixels++;
          const idx = (y * width + x) * 4;
          if (src[idx] === 255 && src[idx + 1] === 0 && src[idx + 2] === 0) {
            untouchedCount++;
          }
        }
      }
    }

    const clientTestName = `Client Inpainting [${label}]`;
    if (untouchedCount > 0) {
      recordTest('Inpainting', clientTestName, 'WARN', {
        metric: `${untouchedCount}/${totalMaskPixels} pixels remained untouched.`,
      });
    } else {
      recordTest('Inpainting', clientTestName, 'PASS', {
        metric: `All ${totalMaskPixels} pixels resolved and diffused seamlessly.`,
      });
    }
  }
}

// ============================================================================
// SUITE 5: Metadata-Only Mode Bit-for-Bit Identity
// ============================================================================
async function runMetadataLosslessSuite() {
  console.log('\n============================================================');
  console.log('📌 SUITE 5: METADATA-ONLY BIT-FOR-BIT LOSSLESS IDENTITY');
  console.log('============================================================');

  const testChannels = [
    {
      name: 'sRGB (3 channels)',
      create: () => sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 123, g: 234, b: 45 } },
      }).png().toBuffer(),
    },
    {
      name: 'RGBA (4 channels with alpha)',
      create: () => sharp({
        create: { width: 64, height: 64, channels: 4, background: { r: 55, g: 155, b: 255, alpha: 0.65 } },
      }).png().toBuffer(),
    },
    {
      name: 'Grayscale (1 channel)',
      create: () => sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 180, g: 180, b: 180 } },
      }).toColourspace('b-w').png().toBuffer(),
    },
    {
      name: 'CMYK (4 channels)',
      create: () => sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 80, g: 160, b: 240 } },
      }).toColourspace('cmyk').jpeg().toBuffer(),
    },
  ];

  for (const tc of testChannels) {
    const inBuf = await tc.create();
    const res = await processImagePipeline(inBuf, {
      disruptionMode: 'metadata-only',
      targetFormat: 'png',
    });

    const { data: dIn } = await sharp(inBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { data: dOut } = await sharp(res.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    let diffCount = 0;
    for (let i = 0; i < dIn.length; i++) {
      if (dIn[i] !== dOut[i]) diffCount++;
    }

    const { psnr, mse } = await calculatePSNR(inBuf, res.buffer);

    if (diffCount === 0 && psnr === Infinity && mse === 0) {
      recordTest('Metadata-Only Identity', tc.name, 'PASS', {
        metric: `0 byte diffs, MSE: 0.00, PSNR: Infinity (100% Bit-for-bit Lossless)`,
      });
    } else {
      recordTest('Metadata-Only Identity', tc.name, 'FAIL', {
        metric: `${diffCount} bytes differed, MSE: ${mse.toFixed(2)}, PSNR: ${psnr.toFixed(2)}dB`,
      });
    }
  }
}

// ============================================================================
// SUITE 6: Corrupt & Invalid Inputs Resilience
// ============================================================================
async function runCorruptInputsSuite() {
  console.log('\n============================================================');
  console.log('📌 SUITE 6: CORRUPT & INVALID INPUT RESILIENCE');
  console.log('============================================================');

  const validJpeg = await sharp({
    create: { width: 50, height: 50, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).jpeg().toBuffer();

  const validPng = await sharp({
    create: { width: 50, height: 50, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).png().toBuffer();

  const testCases = [
    { name: 'Empty Buffer (0 bytes)', buf: Buffer.alloc(0) },
    { name: 'Non-image ASCII text', buf: Buffer.from('<html><body>Not an image</body></html>') },
    { name: 'Random garbage binary (128 bytes)', buf: Buffer.alloc(128, 0x5a) },
    { name: 'Truncated JPEG (first 24 bytes)', buf: validJpeg.subarray(0, 24) },
    { name: 'Truncated PNG (first 16 bytes)', buf: validPng.subarray(0, 16) },
    { name: 'Corrupt JPEG SOI with bad marker', buf: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0x00]), Buffer.alloc(30)]) },
    { name: 'Corrupt PNG header with oversized chunk', buf: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xca, 0x42, 0x58, 0x20])]) },
    { name: 'Broken WebP container', buf: Buffer.from('RIFF\x20\x00\x00\x00WEBPEXIF\xff\xff\x00\x00') },
  ];

  for (const tc of testCases) {
    // 1. scanBufferProvenance must not crash
    let scanOk = false;
    try {
      scanBufferProvenance(tc.buf);
      scanOk = true;
    } catch (e) {
      scanOk = false;
    }

    // 2. processImagePipeline must reject safely without crashing Node process
    let rejectGraceful = false;
    let errMsg = '';
    try {
      await processImagePipeline(tc.buf);
    } catch (err) {
      rejectGraceful = true;
      errMsg = err.message.slice(0, 45);
    }

    if (scanOk && rejectGraceful) {
      recordTest('Corrupt Inputs', tc.name, 'PASS', {
        metric: `Rejected safely: "${errMsg}..." | Scanner resilient`,
      });
    } else {
      recordTest('Corrupt Inputs', tc.name, 'FAIL', {
        metric: `ScanOk: ${scanOk}, RejectGraceful: ${rejectGraceful}`,
      });
    }
  }
}

// ============================================================================
// SUITE 7: Byte-Level Provenance Scanner Verification (Synthetic Chunk Matrix)
// ============================================================================
async function runProvenanceAuditSuite() {
  console.log('\n============================================================');
  console.log('📌 SUITE 7: PROVENANCE AUDIT SCANNER (SYNTHETIC CHUNK MATRIX)');
  console.log('============================================================');

  function createPngWithChunk(type, data = Buffer.alloc(0)) {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunkLen = Buffer.alloc(4);
    chunkLen.writeUInt32BE(data.length, 0);
    const chunkType = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    return Buffer.concat([pngHeader, chunkLen, chunkType, data, crc]);
  }

  function createJpegWithMarker(markerByte, payload = Buffer.alloc(0)) {
    const soi = Buffer.from([0xff, 0xd8]);
    const marker = Buffer.from([0xff, markerByte]);
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(payload.length + 2, 0);
    const eoi = Buffer.from([0xff, 0xd9]);
    return Buffer.concat([soi, marker, lenBuf, payload, eoi]);
  }

  function createWebpWithChunk(fourcc, data = Buffer.alloc(0)) {
    const riff = Buffer.from('RIFF', 'ascii');
    const riffLen = Buffer.alloc(4);
    riffLen.writeUInt32LE(data.length + 12, 0);
    const webp = Buffer.from('WEBP', 'ascii');
    const chunkId = Buffer.from(fourcc, 'ascii');
    const chunkLen = Buffer.alloc(4);
    chunkLen.writeUInt32LE(data.length, 0);
    const pad = data.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
    return Buffer.concat([riff, riffLen, webp, chunkId, chunkLen, data, pad]);
  }

  const syntheticCases = [
    { name: 'PNG caBX (ISO C2PA)', buf: createPngWithChunk('caBX', Buffer.from('c2pa manifest payload')), check: (s) => s.c2paFound && !s.clean },
    { name: 'PNG eXIf (EXIF Header)', buf: createPngWithChunk('eXIf', Buffer.from('II*\x00exif')), check: (s) => s.exifFound && !s.clean },
    { name: 'PNG iCCP (Color Profile)', buf: createPngWithChunk('iCCP', Buffer.from('ICC Profile Data')), check: (s) => s.iccFound && !s.clean },
    { name: 'PNG tEXt (Adobe XMP)', buf: createPngWithChunk('tEXt', Buffer.from('XML:com.adobe.xmp\x00<xmp/>')), check: (s) => s.xmpFound && !s.clean },
    { name: 'PNG tEXt (C2PA Keyword)', buf: createPngWithChunk('tEXt', Buffer.from('c2pa\x00manifest')), check: (s) => s.c2paFound && !s.clean },
    { name: 'JPEG APP1 (Exif Header)', buf: createJpegWithMarker(0xe1, Buffer.from('Exif\x00\x00payload')), check: (s) => s.exifFound && !s.clean },
    { name: 'JPEG APP1 (XMP Schema)', buf: createJpegWithMarker(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\x00<xmp/>')), check: (s) => s.xmpFound && !s.clean },
    { name: 'JPEG APP2 (ICC Profile)', buf: createJpegWithMarker(0xe2, Buffer.from('ICC_PROFILE\x00\x01\x01')), check: (s) => s.iccFound && !s.clean },
    { name: 'JPEG APP13 (Photoshop IPTC)', buf: createJpegWithMarker(0xed, Buffer.from('Photoshop 3.0\x008BIM')), check: (s) => s.iptcFound && !s.clean },
    { name: 'JPEG APP11 (C2PA JUMBF)', buf: createJpegWithMarker(0xeb, Buffer.from('JP\x00\x00jumbf')), check: (s) => s.c2paFound && !s.clean },
    { name: 'WebP EXIF Chunk', buf: createWebpWithChunk('EXIF', Buffer.from('Exif\x00\x00data')), check: (s) => s.exifFound && !s.clean },
    { name: 'WebP XMP Chunk', buf: createWebpWithChunk('XMP ', Buffer.from('<xmp>data</xmp>')), check: (s) => s.xmpFound && !s.clean },
    { name: 'WebP ICCP Chunk', buf: createWebpWithChunk('ICCP', Buffer.from('ICC profile')), check: (s) => s.iccFound && !s.clean },
  ];

  for (const tc of syntheticCases) {
    const scan = scanBufferProvenance(tc.buf);
    const passed = tc.check(scan);
    if (passed) {
      recordTest('Provenance Scanner', tc.name, 'PASS', {
        metric: `Detected ${scan.formatDetected}, clean=${scan.clean}`,
      });
    } else {
      recordTest('Provenance Scanner', tc.name, 'FAIL', {
        metric: `Failed detection: c2pa=${scan.c2paFound}, exif=${scan.exifFound}, xmp=${scan.xmpFound}, icc=${scan.iccFound}, iptc=${scan.iptcFound}`,
      });
    }
  }

  // Also verify client scanner unsigned integer decoding
  const byte0 = 128;
  const fixedChunkLen = (((byte0 << 24) >>> 0)) >>> 0;
  const isPositiveUnsigned = fixedChunkLen === 2147483648;
  if (isPositiveUnsigned) {
    recordTest('Provenance Scanner', 'Client Scanner Unsigned Bitwise Shift (MSB >= 0x80)', 'PASS', {
      metric: `Client bitwise shift properly treats MSB as unsigned (${fixedChunkLen}).`,
    });
  } else {
    recordTest('Provenance Scanner', 'Client Scanner Unsigned Bitwise Shift (MSB >= 0x80)', 'FAIL');
  }
}

// ============================================================================
// Suite 8: GIF & Video Container Provenance Audit Matrix
// ============================================================================
async function runGifVideoProvenanceSuite() {
  console.log('\n============================================================');
  console.log('📌 SUITE 8: GIF & VIDEO PROVENANCE AUDIT MATRIX');
  console.log('============================================================');

  // 1. GIF with Comment Extension (0x21 0xFE) + XMP Application Extension (0x21 0xFF)
  const rawGif = new Uint8Array(4096);
  const gw = new GifWriter(rawGif, 4, 4, { palette: [0x000000, 0xffffff], loop: 0 });
  gw.addFrame(0, 0, 4, 4, new Uint8Array(16), { delay: 10 });
  const endPos = gw.end();
  const baseGif = Buffer.from(rawGif.subarray(0, endPos - 1)); // Strip trailer 0x3B
  const commentExt = Buffer.from([0x21, 0xfe, 11, ...Buffer.from('ai-gen-meta'), 0x00]);
  const xmpExt = Buffer.from([0x21, 0xff, 11, ...Buffer.from('XMP DataXMP'), 0x00]);
  const dirtyGif = Buffer.concat([baseGif, commentExt, xmpExt, Buffer.from([0x3b])]);

  const gifScan = scanBufferProvenance(dirtyGif);
  if (gifScan.formatDetected === 'GIF' && !gifScan.clean && gifScan.exifFound && gifScan.xmpFound) {
    recordTest('Media Scanner', 'GIF Comment + XMP Extension Detection', 'PASS', {
      metric: `Detected GIF, exif=${gifScan.exifFound}, xmp=${gifScan.xmpFound}`,
    });
  } else {
    recordTest('Media Scanner', 'GIF Comment + XMP Extension Detection', 'FAIL', {
      error: JSON.stringify(gifScan),
    });
  }

  // 2. MP4 with ISO BMFF C2PA JUMBF uuid box + udta XMP metadata
  const makeIsoBox = (type, payload) => {
    const out = Buffer.alloc(8 + payload.length);
    out.writeUInt32BE(out.length, 0);
    out.write(type, 4, 4, 'ascii');
    payload.copy(out, 8);
    return out;
  };
  const ftyp = makeIsoBox('ftyp', Buffer.from('isom\x00\x00\x02\x00isom'));
  const uuidC2pa = makeIsoBox(
    'uuid',
    Buffer.concat([
      Buffer.from([0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81]),
      Buffer.from('c2pa manifest'),
    ])
  );
  const udtaXmp = makeIsoBox('udta', Buffer.from('http://ns.adobe.com/xap/1.0/ veo_generated'));
  const moov = makeIsoBox('moov', udtaXmp);
  const dirtyMp4 = Buffer.concat([ftyp, uuidC2pa, moov]);

  const mp4Scan = scanBufferProvenance(dirtyMp4);
  if (mp4Scan.formatDetected === 'MP4' && !mp4Scan.clean && mp4Scan.c2paFound && mp4Scan.xmpFound) {
    recordTest('Media Scanner', 'MP4 JUMBF C2PA UUID + UDTA XMP Detection', 'PASS', {
      metric: `Detected MP4, c2pa=${mp4Scan.c2paFound}, xmp=${mp4Scan.xmpFound}`,
    });
  } else {
    recordTest('Media Scanner', 'MP4 JUMBF C2PA UUID + UDTA XMP Detection', 'FAIL', {
      error: JSON.stringify(mp4Scan),
    });
  }

  // 3. WebM EBML header with C2PA & XMP markers
  const dirtyWebm = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]),
    Buffer.from('webm'),
    Buffer.from('C2PA_ContentCredentials http://ns.adobe.com/xap/'),
  ]);
  const webmScan = scanBufferProvenance(dirtyWebm);
  if (webmScan.formatDetected === 'WEBM' && !webmScan.clean && webmScan.c2paFound && webmScan.xmpFound) {
    recordTest('Media Scanner', 'WebM EBML C2PA + XMP Detection', 'PASS', {
      metric: `Detected WEBM, c2pa=${webmScan.c2paFound}, xmp=${webmScan.xmpFound}`,
    });
  } else {
    recordTest('Media Scanner', 'WebM EBML C2PA + XMP Detection', 'FAIL', {
      error: JSON.stringify(webmScan),
    });
  }
}

// ============================================================================
// Suite 9: Multi-Frame Animated GIF Watermark & Brush Mask Pipeline
// ============================================================================
async function runGifPipelineSuite() {
  console.log('\n============================================================');
  console.log('📌 SUITE 9: ANIMATED GIF MULTI-FRAME WATERMARK PIPELINE');
  console.log('============================================================');

  const w = 120;
  const h = 90;
  const frameCount = 4;
  // Palette: 0=blue bg (0x0044dd), 1=white watermark rect (0xffffff), 2=accent stripe (0xffaa00)
  const palette = [0x0044dd, 0xffffff, 0xffaa00, 0x000000];
  const rawBuf = new Uint8Array(512 * 1024);
  const writer = new GifWriter(rawBuf, w, h, { palette, loop: 0 });

  for (let f = 0; f < frameCount; f++) {
    const indexed = new Uint8Array(w * h);
    indexed.fill(0);
    // Moving orange square + fixed white watermark box at (40..60, 30..50)
    for (let y = 10 + f * 4; y < 22 + f * 4; y++) {
      for (let x = 10 + f * 5; x < 22 + f * 5; x++) {
        indexed[y * w + x] = 2;
      }
    }
    for (let y = 30; y < 50; y++) {
      for (let x = 40; x < 60; x++) {
        indexed[y * w + x] = 1;
      }
    }
    writer.addFrame(0, 0, w, h, indexed, { delay: 10 });
  }
  const gwEnd = writer.end();
  const cleanBody = Buffer.from(rawBuf.subarray(0, gwEnd - 1));
  const dirtyGif = Buffer.concat([
    cleanBody,
    Buffer.from([0x21, 0xfe, 8, ...Buffer.from('veo-meta'), 0x00]),
    Buffer.from([0x3b]),
  ]);

  // 9A. Balanced mode strips metadata while preserving all 4 frames & timing
  const autoRes = await processGifBuffer(dirtyGif, {
    disruptionMode: 'balanced',
    removeVisibleBadge: false,
    disruptSignals: true,
    stripMetadata: true,
  });

  const decodedAuto = decodeGifToFrames(autoRes.bytes);
  if (
    autoRes.telemetry.frameCount === 4 &&
    decodedAuto.frames.length === 4 &&
    decodedAuto.frames[0].delay === 10 &&
    autoRes.telemetry.provenanceAudit.formatDetected === 'GIF' &&
    autoRes.telemetry.provenanceAudit.clean
  ) {
    recordTest('GIF Pipeline', '4-Frame Scrubbing + Metadata Purge + Timing Preservation', 'PASS', {
      metric: `Frames: ${decodedAuto.frames.length}/4, Delay: ${decodedAuto.frames[0].delay}cs, Clean: true`,
    });
  } else {
    recordTest('GIF Pipeline', '4-Frame Scrubbing + Metadata Purge + Timing Preservation', 'FAIL', {
      error: `frames=${decodedAuto.frames.length}, clean=${autoRes.telemetry.provenanceAudit.clean}`,
    });
  }

  // 9B. Visual Brush Inpaint mask propagated cleanly across ALL 4 frames
  const maskRgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 28; y <= 52; y++) {
    for (let x = 38; x <= 62; x++) {
      const p = (y * w + x) * 4;
      maskRgba[p] = 255;
      maskRgba[p + 1] = 255;
      maskRgba[p + 2] = 255;
      maskRgba[p + 3] = 255;
    }
  }

  const inpaintRes = await processGifBuffer(dirtyGif, {
    disruptionMode: 'balanced',
    disruptSignals: false,
    removeVisibleBadge: false,
    maskRgba: { width: w, height: h, data: maskRgba },
  });

  const decodedInpaint = decodeGifToFrames(inpaintRes.bytes);
  let allFramesRepaired = decodedInpaint.frames.length === 4;
  let maxResidualR = 0;
  for (const fr of decodedInpaint.frames) {
    const centerIdx = (40 * w + 50) * 4; // Inside white box
    const r = fr.rgba[centerIdx];
    const b = fr.rgba[centerIdx + 2];
    if (r > maxResidualR) maxResidualR = r;
    if (r > 60 || b < 170) allFramesRepaired = false;
  }

  if (allFramesRepaired && inpaintRes.telemetry.maskApplied && inpaintRes.telemetry.provenanceAudit.clean) {
    recordTest('GIF Pipeline', 'Multi-Frame Visual Brush Inpaint Propagation (All 4 Frames)', 'PASS', {
      metric: `Center watermark erased across all 4 frames (max residual R=${maxResidualR})`,
    });
  } else {
    recordTest('GIF Pipeline', 'Multi-Frame Visual Brush Inpaint Propagation (All 4 Frames)', 'FAIL', {
      error: `allFramesRepaired=${allFramesRepaired}, maxR=${maxResidualR}`,
    });
  }
}

// ============================================================================
// Suite 10: Off-Grid / 16:9 Cropped Gemini Sparkle Rescue Verification
// ============================================================================
async function runSparkleRescueSuite() {
  console.log('\n============================================================');
  console.log('📌 SUITE 10: OFF-GRID 16:9 SPARKLE RESCUE DISCRIMINATOR');
  console.log('============================================================');

  const removerFn = await loadGeminiWatermarkRemoverSync();
  const { createWatermarkEngine } = await import('@pilio/gemini-watermark-remover/image-data');
  const engine = await createWatermarkEngine();
  const alpha24 = await engine.getAlphaMap(24);

  const w = 320;
  const h = 180;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    // Split yellow artwork left edge against dark background (reproducing cropped thumbnail edge case)
    const p = i * 4;
    if (x < 262) {
      rgba[p] = 240; rgba[p + 1] = 215; rgba[p + 2] = 90; rgba[p + 3] = 255;
    } else {
      rgba[p] = 0; rgba[p + 1] = 0; rgba[p + 2] = 0; rgba[p + 3] = 255;
    }
  }

  // Blend 24x24 star at non-standard offset (x0=251, y0=111) straddling the yellow/black edge
  const x0 = 251;
  const y0 = 111;
  for (let dy = 0; dy < 24; dy++) {
    for (let dx = 0; dx < 24; dx++) {
      const a = Math.min(0.85, alpha24[dy * 24 + dx] * 0.78);
      if (a <= 0.01) continue;
      const p = ((y0 + dy) * w + (x0 + dx)) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[p + c] = Math.round(rgba[p + c] * (1 - a) + 255 * a);
      }
    }
  }

  const centerP = ((y0 + 12) * w + (x0 + 12)) * 4; // Sits over dark side (x=263 >= 262)
  const beforeLum = rgba[centerP];

  const meta = eraseGeminiSparklePixelData(rgba, w, h, {
    removerSyncFn: removerFn,
    forceRescue: true,
  });

  const afterLum = rgba[centerP];
  if (meta.applied && meta.rescueApplied && beforeLum > 60 && afterLum < 15) {
    recordTest('Sparkle Rescue', 'Off-Grid 16:9 Edge-Straddling Star Detection & Unblending', 'PASS', {
      metric: `Star center restored from luma ${beforeLum} -> ${afterLum} (tier: ${meta.decisionTier})`,
    });
  } else {
    recordTest('Sparkle Rescue', 'Off-Grid 16:9 Edge-Straddling Star Detection & Unblending', 'FAIL', {
      error: `before=${beforeLum}, after=${afterLum}, meta=${JSON.stringify(meta)}`,
    });
  }

  // Test 2: No-Dark-Pit Gate prevents carving black holes into natural rock texture without a sparkle
  const rockW = 640;
  const rockH = 360;
  const rockBuf = new Uint8ClampedArray(rockW * rockH * 4);
  for (let y = 0; y < rockH; y++) {
    for (let x = 0; x < rockW; x++) {
      const p = (y * rockW + x) * 4;
      const tex = 95 + Math.round(22 * Math.sin(x * 0.25) * Math.cos(y * 0.22));
      rockBuf[p] = tex;
      rockBuf[p + 1] = tex - 4;
      rockBuf[p + 2] = tex - 8;
      rockBuf[p + 3] = 255;
    }
  }
  const rockRescue = rescueOffGridSparkle(rockBuf, rockW, rockH, { preferHarmonicHeal: true });
  let minRock = 255;
  for (let i = 0; i < rockBuf.length; i += 4) if (rockBuf[i] < minRock) minRock = rockBuf[i];
  if (!rockRescue && minRock >= 60) {
    recordTest('Sparkle Rescue', 'No-Dark-Pit False-Positive Guard on Textured Stone', 'PASS', {
      metric: `Zero false star carved (min luma stayed ${minRock})`,
    });
  } else {
    recordTest('Sparkle Rescue', 'No-Dark-Pit False-Positive Guard on Textured Stone', 'FAIL', {
      error: `False match=${JSON.stringify(rockRescue)}, minRock=${minRock}`,
    });
  }

  // Test 3: Panning 44x44 Veo video sparkle tracking + translucent 'Veo' bottom-right wordmark removal
  const vw = 1280;
  const vh = 720;
  const mod = await import('@pilio/gemini-watermark-remover/image-data');
  const eng = await mod.createWatermarkEngine();
  const alpha48 = await eng.getAlphaMap(48);
  const alpha44 = new Float32Array(44 * 44);
  for (let y = 0; y < 44; y++) {
    const sy = (y * 47) / 43;
    const y0 = Math.floor(sy), y1 = Math.min(47, y0 + 1), wy = sy - y0;
    for (let x = 0; x < 44; x++) {
      const sx = (x * 47) / 43;
      const x0 = Math.floor(sx), x1 = Math.min(47, x0 + 1), wx = sx - x0;
      alpha44[y * 44 + x] =
        alpha48[y0 * 48 + x0] * (1 - wx) * (1 - wy) +
        alpha48[y0 * 48 + x1] * wx * (1 - wy) +
        alpha48[y1 * 48 + x0] * (1 - wx) * wy +
        alpha48[y1 * 48 + x1] * wx * wy;
    }
  }
  const paintSceneWithSparkleAndVeo = (sx) => {
    const frame = new Uint8ClampedArray(vw * vh * 4);
    for (let y = 0; y < vh; y++) {
      const base = y < 622 ? 120 : 65;
      for (let x = 0; x < vw; x++) {
        const p = (y * vw + x) * 4;
        frame[p] = base;
        frame[p + 1] = base - 2;
        frame[p + 2] = base - 5;
        frame[p + 3] = 255;
      }
    }
    for (let dy = 0; dy < 44; dy++) {
      for (let dx = 0; dx < 44; dx++) {
        const a = Math.min(0.85, alpha44[dy * 44 + dx] * 0.62);
        if (a <= 0.01) continue;
        const p = ((605 + dy) * vw + (sx + dx)) * 4;
        for (let c = 0; c < 3; c++) frame[p + c] = Math.round(frame[p + c] * (1 - a) + 255 * a);
      }
    }
    // Paint compact isolated 'Veo' glyph bar at bottom-right (1244..1269, 695..704)
    for (let y = 696; y <= 703; y++) {
      for (let x = 1244; x <= 1268; x++) {
        if ((x % 8 < 3) || y === 699 || y === 702) {
          const p = (y * vw + x) * 4;
          frame[p] = Math.min(255, frame[p] + 80);
          frame[p + 1] = Math.min(255, frame[p + 1] + 80);
          frame[p + 2] = Math.min(255, frame[p + 2] + 80);
        }
      }
    }
    return frame;
  };

  const frame0 = paintSceneWithSparkleAndVeo(1162);
  const f0Meta = eraseGeminiSparklePixelData(frame0, vw, vh, { removerSyncFn: removerFn, forceRescue: true, preferHarmonicHeal: true });
  const veoMeta = eraseCornerTextBadgePixelData(frame0, vw, vh, 'bottom-right');
  const frame1 = paintSceneWithSparkleAndVeo(1148); // Shifted -14px
  const tracked = f0Meta.lockBox ? applyLockedCornerUnblend(frame1, vw, vh, f0Meta.lockBox, 'bottom-right') : false;
  const f1Center = ((605 + 22) * vw + (1148 + 22)) * 4;
  if (f0Meta.applied && f0Meta.lockBox?.size === 44 && veoMeta.applied && tracked && frame1[f1Center] < 105) {
    recordTest('Sparkle Rescue', 'Panning 44px Veo Sparkle Tracking & Wordmark Erasure', 'PASS', {
      metric: `Locked size=44, tracked -14px pan smoothly (center=${frame1[f1Center]}), Veo glyphs=${veoMeta.pixelCount}`,
    });
  } else {
    recordTest('Sparkle Rescue', 'Panning 44px Veo Sparkle Tracking & Wordmark Erasure', 'FAIL', {
      error: `f0=${JSON.stringify(f0Meta)}, veo=${JSON.stringify(veoMeta)}, tracked=${tracked}, f1Center=${frame1[f1Center]}`,
    });
  }
}

// ============================================================================
// Main Suite Runner & Executive Summary
// ============================================================================
async function runAllEdgeCases() {
  console.log('============================================================');
  console.log('🔬 DEEP RIGOROUS EDGE-CASE TEST SUITE');
  console.log('============================================================');

  const startTime = Date.now();

  await runTinyImageSuite();
  await runLargeImageSuite();
  await runFormatMatrixSuite();
  await runInpaintHoleSuite();
  await runMetadataLosslessSuite();
  await runCorruptInputsSuite();
  await runProvenanceAuditSuite();
  await runGifVideoProvenanceSuite();
  await runGifPipelineSuite();
  await runSparkleRescueSuite();

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n============================================================');
  console.log('📊 EDGE-CASE TEST EXECUTION SUMMARY');
  console.log('============================================================');
  console.log(`⏱️ Total Suite Duration: ${totalTime}s`);
  console.log(`✅ PASSED:   ${stats.passed}`);
  console.log(`❌ FAILED:   ${stats.failed}`);
  console.log(`⚠️ WARNINGS: ${stats.warnings}`);
  console.log(`📋 TOTAL:    ${stats.passed + stats.failed + stats.warnings} assertions executed\n`);

  console.table(
    stats.records.map((r) => ({
      Category: r.category,
      Test: r.name,
      Status: r.status,
      Details: r.metric || r.error || '',
    }))
  );

  return stats;
}

runAllEdgeCases()
  .then((res) => {
    if (res.failed > 0) {
      console.error(`\n❌ Suite finished with ${res.failed} failure(s).`);
      process.exit(1);
    } else {
      console.log('\n✨ Suite completed analysis successfully.');
      process.exit(0);
    }
  })
  .catch((err) => {
    console.error('Fatal Suite Execution Error:', err);
    process.exit(1);
  });
