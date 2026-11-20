import { chromium } from 'playwright-core';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const executablePath = '/Users/jatin/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

async function checkImage(imagePath) {
  const browser = await chromium.launch({
    executablePath,
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('response', async resp => {
    const url = resp.url();
    if (url.includes('provenance') || url.includes('verify') || url.includes('backend') || url.includes('check')) {
      console.log(`[API RESPONSE] ${resp.status()} ${url}`);
      try {
        const text = await resp.text();
        console.log(`[API BODY] ${text.slice(0, 500)}`);
      } catch (e) {}
    }
  });

  console.log('Navigating to https://openai.com/verify...');
  await page.goto('https://openai.com/verify', { waitUntil: 'domcontentloaded' });
  console.log('Waiting for file input...');
  const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 15000 });
  if (!fileInput) {
    console.error('File input not found!');
    await browser.close();
    return;
  }

  const resolvedPath = path.resolve(imagePath);
  console.log(`Uploading: ${resolvedPath}`);
  await fileInput.setInputFiles(resolvedPath);

  console.log('Waiting for verification result...');
  // Wait up to 15 seconds for result element
  try {
    await page.waitForSelector('text=Generated with OpenAI tools, text=No supported signals', { timeout: 15000 });
  } catch (e) {
    console.log('Timeout waiting for specific text, inspecting page...');
  }
  await page.waitForTimeout(3000);

  const bodyText = await page.innerText('body');
  const synthIdDetected = bodyText.includes('SynthID detected');
  const generatedOpenAI = bodyText.includes('Generated with OpenAI tools');
  const noSignals = bodyText.includes('No supported signals') || bodyText.includes('not detected');

  console.log(`RESULT for ${imagePath}:`);
  console.log(` - Generated with OpenAI: ${generatedOpenAI}`);
  console.log(` - SynthID detected: ${synthIdDetected}`);
  console.log(` - No signals / Not detected: ${noSignals}`);

  // Also print the details block if present
  const details = await page.$$eval('[class*="details"], [class*="result"], p, h2, h3', elements => 
    elements.map(el => el.innerText.trim()).filter(t => t.includes('SynthID') || t.includes('Content Credentials') || t.includes('Generated'))
  );
  console.log('Detected signals:', Array.from(new Set(details)));

  await browser.close();
}

const testImg = process.argv[2] || 'test_user_image.png';
checkImage(testImg).catch(console.error);
