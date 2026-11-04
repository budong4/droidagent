// Regenerates the PNG icons from brand/icon.svg (needs Playwright + Chromium):
//   node brand/render-icons.js
// The Android launcher icon itself is the adaptive vector in apk/res; these PNGs are the
// pre-Android-8 fallback and the web app's icons.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
const targets = [
  ['apk/res/mipmap-mdpi/ic_launcher.png', 48], ['apk/res/mipmap-hdpi/ic_launcher.png', 72],
  ['apk/res/mipmap-xhdpi/ic_launcher.png', 96], ['apk/res/mipmap-xxhdpi/ic_launcher.png', 144],
  ['apk/res/mipmap-xxxhdpi/ic_launcher.png', 192],
  ['app/web/icon-192.png', 192], ['app/web/icon-512.png', 512],
  ['app/web/icon-maskable.png', 512, true],
];
(async () => {
  const browser = await chromium.launch();
  for (const [out, size, fullBleed] of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    // Maskable icons get cropped by the platform, so they fill the whole square.
    const src = fullBleed ? svg.replace('rx="24"', 'rx="0"') : svg;
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${src}`);
    await page.screenshot({ path: path.join(root, out), omitBackground: true });
    await page.close();
    console.log(out, size);
  }
  await browser.close();
})();
