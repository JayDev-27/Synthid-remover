import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotsDir = path.join(__dirname, '..', 'public', 'screenshots');
fs.mkdirSync(screenshotsDir, { recursive: true });

const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function capture() {
  console.log('[1/5] Launching headless browser...');
  const browser = await chromium.launch({
    ...(fs.existsSync(macChrome) ? { executablePath: macChrome } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1024 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    console.log('[2/5] Navigating to http://localhost:3000...');
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    console.log('[3/5] Capturing Hero section (hero.png)...');
    const heroEl = page.locator('section').first();
    const heroBox = await heroEl.boundingBox();
    if (heroBox) {
      await page.screenshot({
        path: path.join(screenshotsDir, 'hero.png'),
        clip: {
          x: heroBox.x,
          y: heroBox.y,
          width: heroBox.width,
          height: Math.min(heroBox.height, 900),
        },
      });
      console.log('  ✅ Saved public/screenshots/hero.png');
    }

    console.log('[4/5] Capturing Workspace section (workspace.png)...');
    await page.evaluate(() => {
      const header = document.querySelector('header');
      if (header) header.style.position = 'relative';
    });
    const wsEl = page.locator('#workspace');
    await wsEl.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const wsBox = await wsEl.boundingBox();
    if (wsBox) {
      await page.screenshot({
        path: path.join(screenshotsDir, 'workspace.png'),
        clip: {
          x: wsBox.x,
          y: wsBox.y,
          width: wsBox.width,
          height: Math.min(wsBox.height, 1050),
        },
      });
      console.log('  ✅ Saved public/screenshots/workspace.png');
    }

    console.log('[5/5] Capturing How It Works (how-it-works.png) and FAQ (faq.png)...');
    const howEl = page.locator('#how-it-works');
    await howEl.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await howEl.screenshot({ path: path.join(screenshotsDir, 'how-it-works.png') });
    console.log('  ✅ Saved public/screenshots/how-it-works.png');

    const faqEl = page.locator('#faq');
    await faqEl.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const faqBox = await faqEl.boundingBox();
    if (faqBox) {
      await page.screenshot({
        path: path.join(screenshotsDir, 'faq.png'),
        clip: {
          x: faqBox.x,
          y: faqBox.y,
          width: faqBox.width,
          height: Math.min(faqBox.height, 900),
        },
      });
      console.log('  ✅ Saved public/screenshots/faq.png');
    }

    console.log('🎉 All screenshots updated successfully with the latest UI!');
  } finally {
    await browser.close();
  }
}

capture().catch((e) => {
  console.error('Capture failed:', e);
  process.exit(1);
});
