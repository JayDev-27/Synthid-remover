import { chromium } from 'playwright-core';
import path from 'path';

async function testOpenAIVerify(imagePath, screenshotName) {
  console.log(`Testing ${imagePath} on OpenAI verifier...`);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await page.goto('https://openai.com/research/verify/', { waitUntil: 'networkidle', timeout: 30000 });
    console.log('Page loaded:', await page.title());

    // Locate the file input
    const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 10000 });
    await fileInput.setInputFiles(imagePath);
    console.log('File uploaded. Waiting for verification result...');

    // Wait for the result element
    await page.waitForTimeout(5000);

    // Try to see if result is present
    await page.screenshot({ path: screenshotName, fullPage: true });
    console.log(`Screenshot saved to ${screenshotName}`);

    const bodyText = await page.evaluate(() => document.body.innerText);
    const lines = bodyText.split('\n').filter(l => l.trim().length > 0);
    console.log('Result lines:');
    for (const line of lines) {
      if (/generated|synthid|watermark|credentials|signals|match|found|not detected|detected/i.test(line)) {
        console.log('  ->', line);
      }
    }
  } catch (err) {
    console.error('Error during test:', err);
  } finally {
    await browser.close();
  }
}

const testImg = path.resolve('cyberpunk_final_test.jpg');
await testOpenAIVerify(testImg, 'test_openai_result.png');
