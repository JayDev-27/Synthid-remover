import { chromium } from 'playwright-core';
import path from 'path';

async function testChrome() {
  const browser = await chromium.launchPersistentContext('/tmp/test-chrome-profile', {
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    viewport: { width: 1280, height: 800 }
  });

  const page = browser.pages()[0] || await browser.newPage();
  
  page.on('response', async resp => {
    const u = resp.url();
    if (u.includes('provenance') || u.includes('verify') || u.includes('turnstile')) {
      console.log(`[RESP] ${resp.status()} ${u.slice(0, 100)}`);
    }
  });

  console.log('Navigating...');
  await page.goto('https://openai.com/research/verify/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Check turnstile
  const turnstileResponse = await page.evaluate(() => {
    const el = document.querySelector('[name="cf-turnstile-response"]');
    return el ? (el.value ? 'FILLED' : 'EMPTY') : 'NOT_FOUND';
  });
  console.log('Turnstile input:', turnstileResponse);

  const fileInput = await page.$('input[type="file"]');
  console.log('File input found:', !!fileInput);

  if (fileInput) {
    console.log('Uploading test_user_image.png...');
    await fileInput.setInputFiles(path.resolve('test_user_image.png'));
    
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const text = await page.innerText('body');
      if (text.includes('Generated with OpenAI tools') || text.includes('No supported signals') || text.includes('not detected')) {
        console.log(`Result seen after ${i+1}s!`);
        console.log('Generated:', text.includes('Generated with OpenAI tools'));
        console.log('SynthID:', text.includes('SynthID detected'));
        console.log('Content credentials:', text.includes('Content Credentials detected'));
        break;
      }
    }
  }

  await page.screenshot({ path: 'scripts/real-chrome-test.png' });
  await browser.close();
}

testChrome().catch(console.error);
