import sharp from 'sharp';
import fs from 'fs';

const inputPath = 'cyberpunk_original.jpg';
const originalBuffer = fs.readFileSync(inputPath);
const meta = await sharp(originalBuffer).metadata();
const { width, height } = meta;

console.log(`Testing Frequency-Domain Split (DeSynth-style) on ${width}x${height}...`);

// Ensure strictly 3-channel RGB raw buffers
const origRgb = await sharp(originalBuffer).toColourspace('srgb').raw().toBuffer();

// Step 1: Create clean base using:
// 1. Anisotropic squeeze & resample (desynchronize convolutional kernel phase)
// 2. 3x3 median order-statistic filter (crushes steganographic outlier noise)
// 3. Lossy Mozjpeg DCT quantization at Q75 (zeros high-frequency DCT harmonics)
let cleanBaseJpeg = await sharp(originalBuffer)
  .resize(Math.round(width * 0.960), Math.round(height * 0.948), { kernel: sharp.kernel.cubic, fit: 'fill' })
  .median(3)
  .resize(width, height, { kernel: sharp.kernel.cubic, fit: 'fill' })
  .jpeg({ quality: 75, mozjpeg: true, chromaSubsampling: '4:2:0' })
  .toBuffer();

// Step 2: Gaussian Frequency Split with sigma = 1.95 (cliff frequency documented in DeSynth)
const sigma = 1.95;

const cleanBlurredRgb = await sharp(cleanBaseJpeg).blur(sigma).toColourspace('srgb').raw().toBuffer();
const origBlurredRgb = await sharp(originalBuffer).blur(sigma).toColourspace('srgb').raw().toBuffer();

const outRgb = new Uint8Array(width * height * 3);

// For each pixel: low band from clean + high band from original
// out = clean_low + (orig - orig_low)
for (let i = 0; i < outRgb.length; i++) {
  const low = cleanBlurredRgb[i];
  const high = origRgb[i] - origBlurredRgb[i];
  // Recombine
  outRgb[i] = Math.min(255, Math.max(0, Math.round(low + high)));
}

// Convert recombined RGB back to JPEG
let finalCandidateC = await sharp(Buffer.from(outRgb.buffer), {
  raw: { width, height, channels: 3 }
})
  .jpeg({ quality: 88, mozjpeg: true, chromaSubsampling: '4:2:0' })
  .toBuffer();

fs.writeFileSync('candidate_C_fixed.jpg', finalCandidateC);

// Compute PSNR
let mse = 0;
const finalRgb = await sharp(finalCandidateC).toColourspace('srgb').raw().toBuffer();
for (let i = 0; i < outRgb.length; i++) {
  const d = origRgb[i] - finalRgb[i];
  mse += d * d;
}
mse /= outRgb.length;
const psnr = 10 * Math.log10((255 * 255) / mse);

console.log(`Candidate C Fixed written: ${(finalCandidateC.length / 1024).toFixed(1)} KB, PSNR: ${psnr.toFixed(2)} dB`);
