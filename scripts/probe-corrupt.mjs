import sharp from 'sharp';
import {
  processImagePipeline,
  stripMetadata,
  disruptEmbeddedSignals,
  applyInpaintMask,
  scanBufferProvenance,
} from '../lib/imageProcessor.ts';
// Extract scanBase64Provenance logic directly to test client scanner
function scanBase64Provenance(base64Data) {
  const binaryString = Buffer.from(base64Data.split(',')[1] || '', 'base64').toString('binary');
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  let c2pa = false;
  let exif = false;
  let xmp = false;
  let icc = false;
  let iptc = false;
  let format = 'unknown';

  // PNG
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    format = 'PNG';
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const chunkLen = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
      const chunkType = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);

      if (chunkType === 'caBX') c2pa = true;
      if (chunkType === 'eXIf') exif = true;
      if (chunkType === 'iCCP') icc = true;
      if (chunkType === 'iTXt' || chunkType === 'tEXt' || chunkType === 'zTXt') {
        let chunkText = '';
        const maxText = Math.min(bytes.length, offset + 8 + Math.min(chunkLen, 120));
        for (let j = offset + 8; j < maxText; j++) {
          chunkText += String.fromCharCode(bytes[j]);
        }
        if (/c2pa|contentcredentials/i.test(chunkText)) c2pa = true;
        if (/xmp|ns\.adobe/i.test(chunkText)) xmp = true;
        if (/exif/i.test(chunkText)) exif = true;
        if (/iptc/i.test(chunkText)) iptc = true;
      }
      offset += 12 + chunkLen;
    }
  }
  // JPEG
  else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    format = 'JPEG';
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const markerLen = (bytes[offset + 2] << 8) | bytes[offset + 3];

      if (marker === 0xe1) {
        let payload = '';
        const maxP = Math.min(bytes.length, offset + 4 + Math.min(markerLen - 2, 40));
        for (let j = offset + 4; j < maxP; j++) {
          payload += String.fromCharCode(bytes[j]);
        }
        if (payload.startsWith('Exif')) exif = true;
        if (payload.includes('ns.adobe.com') || payload.includes('XMP')) xmp = true;
      }
      if (marker === 0xe2) icc = true;
      if (marker === 0xed) iptc = true;
      if (marker === 0xeb) c2pa = true;

      offset += 2 + markerLen;
    }
  }
  // WebP
  else if (bytes.length >= 12 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF') {
    format = 'WEBP';
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunkId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      const chunkLen = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);

      if (chunkId === 'EXIF') exif = true;
      if (chunkId === 'XMP ') xmp = true;
      if (chunkId === 'ICCP') icc = true;

      offset += 8 + chunkLen + (chunkLen % 2);
    }
  }

  return {
    c2paFound: c2pa,
    exifFound: exif,
    xmpFound: xmp,
    iccFound: icc,
    iptcFound: iptc,
    clean: !c2pa && !exif && !xmp && !icc && !iptc,
    bytesScanned: bytes.length,
    formatDetected: format,
  };
}

async function probeCorrupt() {
  console.log('--- TEST 5: CORRUPT & INVALID INPUTS ---');

  // Valid base JPEG for creating truncated payloads
  const validJpeg = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).jpeg().toBuffer();

  const validPng = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer();

  const cases = [
    { name: 'Empty Buffer (0 bytes)', buf: Buffer.alloc(0) },
    { name: 'Non-image ASCII payload', buf: Buffer.from('<html><body>Hello World</body></html>') },
    { name: 'Random garbage binary (256 bytes)', buf: Buffer.alloc(256, 0x42) },
    { name: 'Truncated JPEG (first 20 bytes only)', buf: validJpeg.subarray(0, 20) },
    { name: 'Truncated PNG (first 16 bytes only)', buf: validPng.subarray(0, 16) },
    { name: 'Corrupt JPEG SOI with invalid marker bytes', buf: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0x00]), Buffer.alloc(20)]) },
    { name: 'Corrupt PNG header with fake chunk of huge size', buf: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xca, 0x42, 0x58, 0x20])]) },
    { name: 'Corrupt WebP with broken header', buf: Buffer.from('RIFF\x10\x00\x00\x00WEBPEXIF\xff\xff\xff\xff') },
  ];

  for (const c of cases) {
    console.log(`\nTesting case: ${c.name}`);

    // 1. scanBufferProvenance
    try {
      const audit = scanBufferProvenance(c.buf);
      console.log(`  scanBufferProvenance: handled safely -> format: ${audit.formatDetected}, clean: ${audit.clean}`);
    } catch (e) {
      console.error(`  ❌ scanBufferProvenance CRASHED:`, e.message);
    }

    // 2. scanBase64Provenance
    try {
      const b64 = `data:image/png;base64,${c.buf.toString('base64')}`;
      const audit64 = scanBase64Provenance(b64);
      console.log(`  scanBase64Provenance: handled safely -> format: ${audit64.formatDetected}`);
    } catch (e) {
      console.error(`  ❌ scanBase64Provenance CRASHED:`, e.message);
    }

    // 3. processImagePipeline (Should reject gracefully without crashing Node)
    try {
      await processImagePipeline(c.buf);
      console.log(`  processImagePipeline: unexpectedly succeeded`);
    } catch (e) {
      console.log(`  processImagePipeline: safely rejected with Error (${e.message.slice(0, 60)}...)`);
    }
  }
}

probeCorrupt().catch(console.error);
