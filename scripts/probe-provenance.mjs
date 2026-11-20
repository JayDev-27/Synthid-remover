import sharp from 'sharp';
import { scanBufferProvenance, stripMetadata, processImagePipeline } from '../lib/imageProcessor.ts';

// Helper to construct synthetic chunks in PNG
function createPngWithChunk(type, data = Buffer.alloc(0)) {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunkLen = Buffer.alloc(4);
  chunkLen.writeUInt32BE(data.length, 0);
  const chunkType = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); // Dummy CRC
  return Buffer.concat([pngHeader, chunkLen, chunkType, data, crc]);
}

// Helper to construct synthetic JPEG markers
function createJpegWithMarker(markerByte, payload = Buffer.alloc(0)) {
  const soi = Buffer.from([0xff, 0xd8]);
  const marker = Buffer.from([0xff, markerByte]);
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(payload.length + 2, 0);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, marker, lenBuf, payload, eoi]);
}

// Helper to construct synthetic WebP chunks
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

async function probeProvenance() {
  console.log('--- TEST 6: BYTE-LEVEL PROVENANCE AUDIT SCANNER ON SYNTHETIC CHUNKS ---');

  const syntheticCases = [
    // PNG
    { name: 'PNG caBX (C2PA chunk)', buf: createPngWithChunk('caBX', Buffer.from('c2pa test manifest')), expect: { c2pa: true, format: 'PNG' } },
    { name: 'PNG eXIf (EXIF chunk)', buf: createPngWithChunk('eXIf', Buffer.from('II*\x00exif')), expect: { exif: true, format: 'PNG' } },
    { name: 'PNG iCCP (ICC profile)', buf: createPngWithChunk('iCCP', Buffer.from('ICC Profile')), expect: { icc: true, format: 'PNG' } },
    { name: 'PNG tEXt with XMP', buf: createPngWithChunk('tEXt', Buffer.from('XML:com.adobe.xmp\x00<xmpmeta/>')), expect: { xmp: true, format: 'PNG' } },
    { name: 'PNG tEXt with c2pa', buf: createPngWithChunk('tEXt', Buffer.from('c2pa\x00manifest')), expect: { c2pa: true, format: 'PNG' } },

    // JPEG
    { name: 'JPEG APP1 Exif', buf: createJpegWithMarker(0xe1, Buffer.from('Exif\x00\x00fake-exif-data')), expect: { exif: true, format: 'JPEG' } },
    { name: 'JPEG APP1 XMP', buf: createJpegWithMarker(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\x00<xmp>')), expect: { xmp: true, format: 'JPEG' } },
    { name: 'JPEG APP2 ICC', buf: createJpegWithMarker(0xe2, Buffer.from('ICC_PROFILE\x00\x01\x01')), expect: { icc: true, format: 'JPEG' } },
    { name: 'JPEG APP13 IPTC/Photoshop', buf: createJpegWithMarker(0xed, Buffer.from('Photoshop 3.0\x008BIM')), expect: { iptc: true, format: 'JPEG' } },
    { name: 'JPEG APP11 C2PA (JUMBF)', buf: createJpegWithMarker(0xeb, Buffer.from('JP\x00\x00jumbfake')), expect: { c2pa: true, format: 'JPEG' } },

    // WebP
    { name: 'WebP EXIF', buf: createWebpWithChunk('EXIF', Buffer.from('Exif\x00\x00data')), expect: { exif: true, format: 'WEBP' } },
    { name: 'WebP XMP ', buf: createWebpWithChunk('XMP ', Buffer.from('<xmp>data</xmp>')), expect: { xmp: true, format: 'WEBP' } },
    { name: 'WebP ICCP', buf: createWebpWithChunk('ICCP', Buffer.from('ICC data profile')), expect: { icc: true, format: 'WEBP' } },
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of syntheticCases) {
    const scan = scanBufferProvenance(tc.buf);
    let ok = true;
    if (scan.formatDetected !== tc.expect.format) {
      console.log(`❌ ${tc.name}: wrong format detected (${scan.formatDetected} vs expected ${tc.expect.format})`);
      ok = false;
    }
    for (const [key, val] of Object.entries(tc.expect)) {
      if (key === 'format') continue;
      const scanKey = `${key}Found`;
      if (scan[scanKey] !== val) {
        console.log(`❌ ${tc.name}: expected ${scanKey}=${val}, got ${scan[scanKey]}`);
        ok = false;
      }
    }
    if (scan.clean !== false) {
      console.log(`❌ ${tc.name}: expected clean=false, got ${scan.clean}`);
      ok = false;
    }

    if (ok) {
      console.log(`✅ ${tc.name}: correctly flagged (Format: ${scan.formatDetected}, clean: ${scan.clean})`);
      passed++;
    } else {
      failed++;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${syntheticCases.length} tests.`);
}

probeProvenance().catch(console.error);
