export interface ProvenanceAuditResult {
  c2paFound: boolean;
  exifFound: boolean;
  xmpFound: boolean;
  iccFound: boolean;
  iptcFound: boolean;
  clean: boolean;
  bytesScanned: number;
  formatDetected: string;
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] << 24) >>> 0) +
      (bytes[offset + 1] << 16) +
      (bytes[offset + 2] << 8) +
      bytes[offset + 3]) >>>
    0
  );
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      ((bytes[offset + 3] << 24) >>> 0)) >>>
    0
  );
}

function readUInt16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readAsciiSlice(bytes: Uint8Array, start: number, maxLen: number): string {
  const end = Math.min(bytes.length, start + maxLen);
  let out = '';
  for (let i = start; i < end; i++) {
    const c = bytes[i];
    out += c >= 9 && c <= 126 ? String.fromCharCode(c) : ' ';
  }
  return out;
}

/**
 * Checks whether bytes at offset contain a known C2PA / XMP / EXIF / IPTC signature.
 */
function scanTextSignatures(
  text: string,
  flags: { c2pa: boolean; exif: boolean; xmp: boolean; icc: boolean; iptc: boolean }
): void {
  if (/c2pa|contentcredentials|jumb/i.test(text)) flags.c2pa = true;
  if (/xmp|ns\.adobe/i.test(text)) flags.xmp = true;
  if (/exif/i.test(text)) flags.exif = true;
  if (/iptc/i.test(text)) flags.iptc = true;
}

/**
 * Forensic byte-level provenance chunk scanner across PNG, JPEG, WebP, GIF, MP4/MOV, and WebM.
 * Verifies whether any C2PA manifests, EXIF headers, XMP schemas, ICC profiles, or IPTC blocks exist.
 */
export function scanUint8ArrayProvenance(bytes: Uint8Array): ProvenanceAuditResult {
  const flags = {
    c2pa: false,
    exif: false,
    xmp: false,
    icc: false,
    iptc: false,
  };
  let format = 'unknown';

  // 1. PNG: 89 50 4E 47
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    format = 'PNG';
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const length = readUInt32BE(bytes, offset);
      const type = String.fromCharCode(
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7]
      );

      if (type === 'caBX') flags.c2pa = true;
      if (type === 'eXIf') flags.exif = true;
      if (type === 'iCCP') flags.icc = true;
      if (type === 'iTXt' || type === 'tEXt' || type === 'zTXt') {
        const text = readAsciiSlice(bytes, offset + 8, Math.min(length, 160));
        scanTextSignatures(text, flags);
      }

      if (offset + 12 + length <= offset) break;
      offset += 12 + length;
    }
  }
  // 2. JPEG: FF D8
  else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    format = 'JPEG';
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const len = readUInt16BE(bytes, offset + 2);
      if (len < 2) break;

      if (marker === 0xe1) {
        const payload = readAsciiSlice(bytes, offset + 4, Math.min(len - 2, 48));
        if (payload.startsWith('Exif')) flags.exif = true;
        if (payload.includes('ns.adobe.com') || payload.includes('XMP')) flags.xmp = true;
      }
      if (marker === 0xe2) flags.icc = true;
      if (marker === 0xed) flags.iptc = true;
      if (marker === 0xeb) flags.c2pa = true;

      offset += 2 + len;
    }
  }
  // 3. WebP: RIFF....WEBP
  else if (
    bytes.length >= 12 &&
    readAsciiSlice(bytes, 0, 4) === 'RIFF' &&
    readAsciiSlice(bytes, 8, 4) === 'WEBP'
  ) {
    format = 'WEBP';
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunkId = String.fromCharCode(
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3]
      );
      const chunkLen = readUInt32LE(bytes, offset + 4);

      if (chunkId === 'EXIF') flags.exif = true;
      if (chunkId === 'XMP ') flags.xmp = true;
      if (chunkId === 'ICCP') flags.icc = true;

      offset += 8 + chunkLen + (chunkLen % 2);
    }
  }
  // 4. GIF: GIF87a / GIF89a
  else if (
    bytes.length >= 13 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    format = 'GIF';
    const packed = bytes[10];
    let offset = 13;
    if (packed & 0x80) {
      const gctSize = 3 * (1 << ((packed & 0x07) + 1));
      offset += gctSize;
    }

    while (offset < bytes.length) {
      const blockId = bytes[offset++];
      if (blockId === 0x3b) break; // Trailer
      if (blockId === 0x2c) {
        // Image Descriptor
        if (offset + 9 > bytes.length) break;
        const lctPacked = bytes[offset + 8];
        offset += 9;
        if (lctPacked & 0x80) {
          offset += 3 * (1 << ((lctPacked & 0x07) + 1));
        }
        if (offset >= bytes.length) break;
        offset++; // LZW min code size
        while (offset < bytes.length) {
          const subLen = bytes[offset++];
          if (subLen === 0) break;
          offset += subLen;
        }
      } else if (blockId === 0x21) {
        if (offset >= bytes.length) break;
        const extLabel = bytes[offset++];
        if (extLabel === 0xfe) {
          // Comment extension (stripped on clean export)
          let commentText = '';
          while (offset < bytes.length) {
            const subLen = bytes[offset++];
            if (subLen === 0) break;
            commentText += readAsciiSlice(bytes, offset, Math.min(subLen, 200));
            offset += subLen;
          }
          if (commentText.trim().length > 0) {
            flags.exif = true;
            scanTextSignatures(commentText, flags);
          }
        } else if (extLabel === 0xff) {
          // Application extension
          if (offset >= bytes.length) break;
          const appBlockLen = bytes[offset++];
          const appId = readAsciiSlice(bytes, offset, appBlockLen);
          offset += appBlockLen;

          let appPayload = '';
          while (offset < bytes.length) {
            const subLen = bytes[offset++];
            if (subLen === 0) break;
            if (appPayload.length < 512) {
              appPayload += readAsciiSlice(bytes, offset, Math.min(subLen, 256));
            }
            offset += subLen;
          }

          const combined = `${appId} ${appPayload}`;
          if (!/^NETSCAPE2\.0|^ANIMEXTS1\.0/i.test(appId)) {
            if (/xmp dataxmp|ns\.adobe/i.test(combined)) flags.xmp = true;
            if (/c2pa|contentcredentials|jumb/i.test(combined)) flags.c2pa = true;
            if (/icc/i.test(combined)) flags.icc = true;
            if (/exif/i.test(combined)) flags.exif = true;
          }
        } else {
          // Graphic Control / Plain Text / other extension subblocks
          while (offset < bytes.length) {
            const subLen = bytes[offset++];
            if (subLen === 0) break;
            offset += subLen;
          }
        }
      } else {
        break;
      }
    }
  }
  // 5. MP4 / MOV ISO BMFF container (box 'ftyp' at byte 4)
  else if (bytes.length >= 12 && readAsciiSlice(bytes, 4, 4) === 'ftyp') {
    const brand = readAsciiSlice(bytes, 8, 4).toLowerCase();
    format = brand.startsWith('qt') ? 'MOV' : 'MP4';

    const scanIsoBoxes = (start: number, end: number, depth: number) => {
      if (depth > 4) return;
      let offset = start;
      while (offset + 8 <= end) {
        let size = readUInt32BE(bytes, offset);
        const type = String.fromCharCode(
          bytes[offset + 4],
          bytes[offset + 5],
          bytes[offset + 6],
          bytes[offset + 7]
        );
        let headerSize = 8;
        if (size === 1) {
          if (offset + 16 > end) break;
          const hi = readUInt32BE(bytes, offset + 8);
          const lo = readUInt32BE(bytes, offset + 12);
          size = hi * 4294967296 + lo;
          headerSize = 16;
        } else if (size === 0) {
          size = end - offset;
        }
        if (size < headerSize || offset + size > end) break;

        if (type === 'jumb' || type === 'c2pa') {
          flags.c2pa = true;
        } else if (type === 'uuid' && size >= 24) {
          // Check C2PA JUMBF UUID (d8fec3d6-1b0e-483c-9297-5828877ec481) or XMP UUID
          const u0 = readUInt32BE(bytes, offset + 8);
          const u1 = readUInt32BE(bytes, offset + 12);
          if (u0 === 0xd8fec3d6 && u1 === 0x1b0e483c) {
            flags.c2pa = true;
          } else if (u0 === 0xbe7acfcb && u1 === 0x97a942e8) {
            flags.xmp = true;
          } else {
            scanTextSignatures(readAsciiSlice(bytes, offset + 8, Math.min(size - 8, 512)), flags);
          }
        } else if (type === 'XMP_' || type === 'xmp ') {
          flags.xmp = true;
        } else if (type === 'Exif' || type === 'exif') {
          flags.exif = true;
        } else if (type === 'udta' || type === 'meta') {
          const innerStart = type === 'meta' ? offset + 12 : offset + headerSize;
          const ascii = readAsciiSlice(bytes, offset + headerSize, Math.min(size - headerSize, 2048));
          scanTextSignatures(ascii, flags);
          if (/©swr|©too|©mak|©mod|com\.apple|google/i.test(ascii)) {
            flags.exif = true;
          }
          if (innerStart < offset + size) {
            scanIsoBoxes(innerStart, offset + size, depth + 1);
          }
        } else if (type === 'moov') {
          scanIsoBoxes(offset + headerSize, offset + size, depth + 1);
        }

        offset += size;
      }
    };

    scanIsoBoxes(0, bytes.length, 0);
  }
  // 6. WebM / Matroska EBML header (1A 45 DF A3)
  else if (
    bytes.length >= 16 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    format = 'WEBM';
    // Inspect non-cluster header/trailer ranges safely without scanning bulk video payloads
    const headSlice = readAsciiSlice(bytes, 0, Math.min(bytes.length, 4096));
    const tailStart = Math.max(0, bytes.length - 8192);
    const tailSlice = bytes.length > 4096 ? readAsciiSlice(bytes, tailStart, bytes.length - tailStart) : '';
    const combined = `${headSlice} ${tailSlice}`;
    scanTextSignatures(combined, flags);
  }

  return {
    c2paFound: flags.c2pa,
    exifFound: flags.exif,
    xmpFound: flags.xmp,
    iccFound: flags.icc,
    iptcFound: flags.iptc,
    clean: !flags.c2pa && !flags.exif && !flags.xmp && !flags.icc && !flags.iptc,
    bytesScanned: bytes.length,
    formatDetected: format,
  };
}

/**
 * Decodes a data: URL / base64 string into a Uint8Array and runs forensic provenance audit.
 */
export function scanBase64Provenance(base64Data: string): ProvenanceAuditResult {
  const payload = base64Data.includes(',') ? base64Data.split(',')[1] || '' : base64Data;
  const binaryString = atob(payload);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return scanUint8ArrayProvenance(bytes);
}
