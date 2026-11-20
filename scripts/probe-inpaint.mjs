import sharp from 'sharp';
import { applyInpaintMask } from '../lib/imageProcessor.ts';

async function probeInpaint() {
  console.log('--- TEST 3: INPAINT MASK EDGE CASES (SERVER & CLIENT) ---');

  const width = 200;
  const height = 200;
  const centerX = 100;
  const centerY = 100;

  // Test both small mask (r=5) and large mask (r=25)
  for (const radius of [5, 25]) {
    console.log(`\nTesting Mask with Radius = ${radius}px`);

    // Create base image: Solid blue background (0, 0, 255) with a RED circle (255, 0, 0) in center
    // We want to remove the RED circle. The surrounding is BLUE.
    const baseSvg = `
      <svg width="${width}" height="${height}">
        <rect width="${width}" height="${height}" fill="rgb(0, 0, 255)" />
        <circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="rgb(255, 0, 0)" />
      </svg>
    `;
    const imageBuf = await sharp(Buffer.from(baseSvg)).png().toBuffer();

    // Create mask: White circle (255, 255, 255) covering the red circle, black background (0,0,0)
    const maskSvg = `
      <svg width="${width}" height="${height}">
        <rect width="${width}" height="${height}" fill="black" />
        <circle cx="${centerX}" cy="${centerY}" r="${radius + 2}" fill="white" />
      </svg>
    `;
    const maskBuf = await sharp(Buffer.from(maskSvg)).png().toBuffer();

    // 1. SERVER INPAINTING (applyInpaintMask)
    const serverOut = await applyInpaintMask(imageBuf, maskBuf);
    const { data: serverRaw } = await sharp(serverOut).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    // Check pixel at center (100, 100)
    const centerIdx = (centerY * width + centerX) * 4;
    const sR = serverRaw[centerIdx];
    const sG = serverRaw[centerIdx + 1];
    const sB = serverRaw[centerIdx + 2];
    console.log(`  [Server Inpaint] Center pixel (R,G,B): (${sR}, ${sG}, ${sB})`);
    // Ideally, center pixel should be blue (R ≈ 0, B ≈ 255).
    // If R > 50 or R >> B, the red circle was NOT replaced!
    if (sR > sB) {
      console.log(`  ⚠️ [Server Warning/Bug] Center pixel is still predominantly RED (${sR} vs ${sB})! Untouched/blurred hole remains!`);
    } else {
      console.log(`  ✅ [Server] Replaced center with background colors.`);
    }

    // 2. CLIENT INPAINTING ALGORITHM SIMULATION
    // Let's run the exact client inpainting diffusion loop from lib/clientImageProcessor.ts
    const { data: clientImg } = await sharp(imageBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { data: clientMask } = await sharp(maskBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    const src = new Uint8ClampedArray(clientImg);
    const mask = new Uint8ClampedArray(clientMask);

    // Run client algorithm lines 640-695 from clientImageProcessor.ts
    let minX = width, maxX = 0, minY = height, maxY = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        if (mask[idx + 3] > 20 || mask[idx] > 20) {
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

    const passes = 4;
    for (let pass = 0; pass < passes; pass++) {
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const idx = (y * width + x) * 4;
          const maskAlpha = mask[idx + 3];
          const maskLum = mask[idx];

          if (maskAlpha > 30 || maskLum > 30) {
            let rSum = 0, gSum = 0, bSum = 0, count = 0;
            const r_rad = 3;
            for (let dy = -r_rad; dy <= r_rad; dy++) {
              const ny = y + dy;
              if (ny < 0 || ny >= height) continue;
              for (let dx = -r_rad; dx <= r_rad; dx++) {
                const nx = x + dx;
                if (nx < 0 || nx >= width) continue;
                const nidx = (ny * width + nx) * 4;
                if (mask[nidx + 3] <= 30 && mask[nidx] <= 30) {
                  const weight = 1 / (1 + Math.hypot(dx, dy));
                  rSum += src[nidx] * weight;
                  gSum += src[nidx + 1] * weight;
                  bSum += src[nidx + 2] * weight;
                  count += weight;
                }
              }
            }
            if (count > 0) {
              src[idx] = Math.round(rSum / count);
              src[idx + 1] = Math.round(gSum / count);
              src[idx + 2] = Math.round(bSum / count);
            }
          }
        }
      }
    }

    const cR = src[centerIdx];
    const cG = src[centerIdx + 1];
    const cB = src[centerIdx + 2];
    console.log(`  [Client Inpaint] Center pixel (R,G,B): (${cR}, ${cG}, ${cB})`);
    if (cR === 255 && cB === 0) {
      console.log(`  ❌ [Client Failure] Center pixel was 100% UNTOUCHED (R=${cR}, B=${cB})! Large mask leaves complete untouched hole!`);
    } else if (cR > cB) {
      console.log(`  ⚠️ [Client Warning] Center pixel is still mostly RED (${cR} vs ${cB})`);
    } else {
      console.log(`  ✅ [Client] Inpainted center.`);
    }

    // Let's also count how many pixels inside the mask remained 100% untouched red (255, 0, 0)
    let untouchedCount = 0;
    let totalMaskedPixels = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dist = Math.hypot(x - centerX, y - centerY);
        if (dist <= radius) {
          totalMaskedPixels++;
          const idx = (y * width + x) * 4;
          if (src[idx] === 255 && src[idx + 1] === 0 && src[idx + 2] === 0) {
            untouchedCount++;
          }
        }
      }
    }
    console.log(`  [Client Stats] Total masked object pixels: ${totalMaskedPixels}, completely untouched holes: ${untouchedCount} (${((untouchedCount / totalMaskedPixels) * 100).toFixed(1)}%)`);
  }
}

probeInpaint().catch(console.error);
