import { chromium } from 'playwright-core';
import path from 'path';

const executablePath = '/Users/jatin/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

async function run(fileToTest = 'test_user_image.png') {
  console.log(`\n=== Testing file: ${fileToTest} ===`);
  const browser = await chromium.launch({
    executablePath,
    headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars'
    ]
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });
  const page = await context.newPage();

  page.on('request', req => {
    const u = req.url();
    if (!u.includes('.js') && !u.includes('.css') && !u.includes('.woff') && !u.includes('.svg')) {
      console.log(`[REQ] ${req.method()} ${u}`);
      if (req.postData()) {
        console.log(`[REQ DATA] ${req.postData().slice(0, 300)}`);
      }
    }
  });

  page.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('.js') && !u.includes('.css') && !u.includes('.woff') && !u.includes('.svg')) {
      console.log(`[RESP] ${resp.status()} ${u}`);
      try {
        const text = await resp.text();
        if (text.includes('synthid') || text.includes('SynthID') || text.includes('provenance') || text.includes('result') || text.includes('credentials')) {
          console.log(`[RESP MATCH] ${text.slice(0, 500)}`);
        }
      } catch (e) {}
    }
  });

  await page.goto('https://openai.com/research/verify/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // Click accept all cookies if present
  try {
    const cookieBtn = await page.$('button:has-text("Accept all"), button:has-text("Reject non-essential")');
    if (cookieBtn) {
      console.log('Dismissing cookie banner...');
      await cookieBtn.click();
      await page.waitForTimeout(500);
    }
  } catch (e) {}

  const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 10000 });
  const absPath = path.resolve(fileToTest);
  console.log(`Uploading file ${absPath}...`);
  await fileInput.setInputFiles(absPath);

  // Wait for result UI to appear
  console.log('Waiting for verification...');
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const body = await page.innerText('body');
    if (body.includes('Generated with OpenAI') || body.includes('No supported signals') || body.includes('not detected')) {
      console.log(`Result detected after ${i + 1}s!`);
      break;
    }
  }

  // Click "Show details" if present
  try {
    const showDetails = await page.$('button:has-text("Show details"), button:has-text("details")');
    if (showDetails) {
      await showDetails.click();
      await page.waitForTimeout(1000);
    }
  } catch (e) {}

  await page.screenshot({ path: `scripts/result_${path.basename(fileToTest, path.extname(fileToTest))}.png` });

  const finalBody = await page.innerText('body');
  console.log('\n--- VERIFICATION RESULT ---');
  console.log('Generated with OpenAI tools:', finalBody.includes('Generated with OpenAI tools'));
  console.log('SynthID detected:', finalBody.includes('SynthID detected'));
  console.log('Content Credentials detected:', finalBody.includes('Content Credentials detected') && !finalBody.includes('Content Credentials not detected'));
  console.log('No supported signals found:', finalBody.includes('No supported signals found'));
  console.log('---------------------------\n');

  await browser.close();
}

const file = process.argv[2] || 'test_user_image.png';
run(file).catch(console.error);
