import sharp from 'sharp';
import { processImagePipeline, scanBufferProvenance } from '../lib/imageProcessor.ts';

async function probeFormats() {
  console.log('--- TEST 7: FORMAT MATRIX CONVERSION & CONTAINER INTEGRITY ---');

  const baseBuf = await sharp({
    create: { width: 120, height: 120, channels: 4, background: { r: 80, g: 160, b: 240, alpha: 1 } },
  }).png().toBuffer();

  const formats = ['png', 'jpeg', 'webp'];
  const signatures = {
    png: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
    jpeg: (b) => b.length >= 2 && b[0] === 0xff && b[1] === 0xd8,
    webp: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  };

  for (const srcFmt of formats) {
    const srcBuf = srcFmt === 'png' ? baseBuf :
      srcFmt === 'jpeg' ? await sharp(baseBuf).jpeg().toBuffer() :
      await sharp(baseBuf).webp().toBuffer();

    for (const tgtFmt of formats) {
      console.log(`Converting ${srcFmt.toUpperCase()} -> ${tgtFmt.toUpperCase()}...`);
      const res = await processImagePipeline(srcBuf, {
        targetFormat: tgtFmt,
        stripMetadata: true,
        disruptSignals: true,
        disruptionMode: 'balanced',
      });

      const audit = res.telemetry.provenanceAudit;
      const sigOk = signatures[tgtFmt](res.buffer);
      const detectedFmt = audit.formatDetected.toLowerCase();

      if (!sigOk) {
        console.error(`  ❌ Invalid byte signature for ${tgtFmt}!`);
      } else if (detectedFmt !== tgtFmt) {
        console.error(`  ❌ Scanner detected '${detectedFmt}', expected '${tgtFmt}'`);
      } else if (!audit.clean) {
        console.error(`  ❌ Byte audit dirty: C2PA=${audit.c2paFound}, EXIF=${audit.exifFound}, ICC=${audit.iccFound}`);
      } else {
        console.log(`  ✅ Clean ${tgtFmt.toUpperCase()} container (${(res.buffer.length / 1024).toFixed(1)} KB, detected: ${detectedFmt})`);
      }
    }
  }
}

probeFormats().catch(console.error);
