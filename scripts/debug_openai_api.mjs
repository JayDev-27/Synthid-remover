import { chromium } from 'playwright-core';

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage();
  page.on('response', async res => {
    const url = res.url();
    if (!url.includes('.js') && !url.includes('.css') && !url.includes('.svg') && !url.includes('.woff')) {
      console.log('HTTP', res.status(), url);
      try {
        const text = await res.text();
        console.log('  Response:', text.slice(0, 300));
      } catch (e) {}
    }
  });
  await page.goto('https://openai.com/research/verify/', { waitUntil: 'networkidle' });
  const input = await page.$('input[type="file"]');
  console.log('Uploading cyberpunk_original.jpg...');
  await input.setInputFiles('cyberpunk_original.jpg');
  await page.waitForTimeout(6000);
  await browser.close();
}

main();
