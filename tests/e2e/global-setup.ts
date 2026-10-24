// Warm-up before any spec: load the laptop and phone pages once so Vite transforms every module
// and finishes dependency pre-bundling (a cold cache can otherwise full-reload a page mid-test).
import { chromium, type FullConfig } from '@playwright/test';

export default async function globalSetup(config: FullConfig) {
  const use = config.projects[0]!.use;
  const browser = await chromium.launch(use.launchOptions);
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true, baseURL: use.baseURL });
    await page.goto('/', { waitUntil: 'networkidle', timeout: 120_000 });
    await page.waitForFunction(() => 'previz' in window || '__previz' in window, null, {
      timeout: 60_000,
    });
    await page.goto('/phone.html?3d=0', { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForFunction(() => '__phone' in window, null, { timeout: 60_000 });
    // the phone's 3D view is a dynamic import; pull it (and three/spark) through Vite as well
    await page.evaluate((src) => import(src), '/src/phone/view.ts');
  } finally {
    await browser.close();
  }
}
