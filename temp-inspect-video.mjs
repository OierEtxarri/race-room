import { chromium } from 'playwright';
const filePath = '/home/oecharri/Descargas/aaa.webm';
const outputScreenshot = './temp-video-playback.png';
const html = `<!doctype html>
<html>
<head>
  <style>body{margin:0;background:#000;color:#fff;font-family:system-ui, sans-serif;}video{width:100vw;height:100vh;object-fit:contain;background:#000;}</style>
</head>
<body>
  <video id="video" src="file://${filePath}" controls muted autoplay playsinline></video>
  <script>window.reportReady = false;const video=document.querySelector('video');video.onloadeddata=()=>window.reportReady=true;</script>
</body>
</html>`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 720, height: 1280 } });
const page = await context.newPage();
await page.setContent(html, { waitUntil: 'load' });
const report = await page.evaluate(async () => {
  const video = document.querySelector('video');
  const result = { readyState: video.readyState, networkState: video.networkState };
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout waiting for video event')), 10000);
      if (video.readyState >= 2) {
        clearTimeout(timeout); resolve();
      } else {
        video.addEventListener('loadeddata', () => { clearTimeout(timeout); resolve(); }, { once: true });
        video.addEventListener('error', () => { clearTimeout(timeout); reject(video.error || new Error('video error')); }, { once: true });
      }
    });
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    result.playing = !video.paused;
    result.currentTime = video.currentTime;
  } catch (error) {
    result.error = String(error);
  }
  result.readyState = video.readyState;
  result.networkState = video.networkState;
  result.paused = video.paused;
  result.videoWidth = video.videoWidth;
  result.videoHeight = video.videoHeight;
  result.duration = video.duration;
  result.seeking = video.seeking;
  result.buffered = video.buffered.length ? { start: video.buffered.start(0), end: video.buffered.end(0) } : null;
  return result;
});
await page.screenshot({ path: outputScreenshot, fullPage: true });
await browser.close();
console.log('REPORT:', JSON.stringify(report, null, 2));
console.log('SCREENSHOT:', outputScreenshot);
