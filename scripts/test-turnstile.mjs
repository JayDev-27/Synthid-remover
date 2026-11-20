import { chromium } from 'playwright-core';
import path from 'path';

async function testTurnstile() {
  const browser = await chromium.launchPersistentContext('/tmp/test-chrome-profile', {
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    viewport: { width: 1280, height: 800 }
  });

  const page = browser.pages()[0] || await browser.newPage();

  page.on('request', r => {
    const u = r.url();
    if (!u.includes('.js') && !u.includes('.css') && !u.includes('.woff')) {
      console.log(`[REQ] ${r.method()} ${u}`);
    }
  });

  page.on('response', async resp => {
    const u = resp.url();
    if (!u.includes('.js') && !u.includes('.css') && !u.includes('.woff')) {
      console.log(`[RESP] ${resp.status()} ${u}`);
      try {
        const text = await resp.text();
        if (text.includes('synthid') || text.includes('SynthID') || text.includes('provenance') || text.includes('credentials') || text.includes('result')) {
          console.log(`[API RESPONSE BODY]: ${text.slice(0, 500)}`);
        }
      } catch (e) {}
    }
  });

  console.log('Navigating...');
  await page.goto('https://openai.com/research/verify/');
  await page.waitForTimeout(2000);

  // Accept cookies
  try {
    const acceptBtn = await page.$('button:has-text("Accept all"), button:has-text("Reject non-essential")');
    if (acceptBtn) {
      await acceptBtn.click();
      await page.waitForTimeout(500);
    }
  } catch (e) {}

  // Move mouse around to trigger Turnstile activity
  console.log('Moving mouse...');
  for (let x = 100; x < 600; x += 100) {
    await page.mouse.move(x, x * 0.8);
    await page.waitForTimeout(100);
  }

  // Wait for Turnstile token to appear in DOM
  console.log('Waiting for Turnstile token...');
  let turnstileToken = '';
  for (let i = 0; i < 20; i++) {
    turnstileToken = await page.evaluate(() => {
      const el = document.querySelector('[name="cf-turnstile-response"]');
      return el ? el.value : '';
    });
    if (turnstileToken) {
      console.log(`Turnstile solved after ${i+1}s! Token length: ${turnstileToken.length}`);
      break;
    }
    await page.waitForTimeout(500);
  }

  if (!turnstileToken) {
    console.log('Turnstile not solved automatically, clicking around...');
    await page.mouse.click(500, 450);
    await page.waitForTimeout(2000);
    turnstileToken = await page.evaluate(() => {
      const el = document.querySelector('[name="cf-turnstile-response"]');
      return el ? el.value : '';
    });
    console.log('Turnstile token after click:', turnstileToken ? 'GOT TOKEN' : 'STILL EMPTY');
  }

  const fileInput = await page.waitForSelector('input[type="file"]');
  console.log('Setting file test_user_image.png...');
  await fileInput.setInputFiles(path.resolve('test_user_image.png'));

  console.log('Waiting for results...');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    const body = await page.innerText('body');
    if (body.includes('Generated with OpenAI tools') || body.includes('No supported signals') || body.includes('not detected')) {
      console.log(`RESULT DETECTED at ${i+1}s!`);
      console.log('Generated with OpenAI:', body.includes('Generated with OpenAI tools'));
      console.log('SynthID detected:', body.includes('SynthID detected'));
      console.log('Content credentials:', body.includes('Content Credentials detected'));
      break;
    }
  }

  await page.screenshot({ path: 'scripts/turnstile-test-result.png' });
  await browser.close();
}

testTurnstile().catch(console.error);
