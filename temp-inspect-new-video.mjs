import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const videoPath = '/home/oecharri/Descargas/run-route-video-2026-04-05-22415155253 (4).webm';

async function inspectVideo() {
  const server = createServer((req, res) => {
    if (req.url === '/video.webm') {
      try {
        const stats = statSync(videoPath);
        res.writeHead(200, {
          'Content-Type': 'video/webm',
          'Content-Length': stats.size,
          'Accept-Ranges': 'bytes',
        });
        const stream = readFileSync(videoPath);
        res.end(stream);
      } catch (error) {
        res.writeHead(404);
        res.end('Video not found');
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <body>
          <video id="video" controls autoplay muted>
            <source src="/video.webm" type="video/webm">
          </video>
          <script>
            const video = document.getElementById('video');
            video.addEventListener('loadedmetadata', () => {
              console.log('Video loaded:', {
                readyState: video.readyState,
                networkState: video.networkState,
                videoWidth: video.videoWidth,
                videoHeight: video.videoHeight,
                duration: video.duration,
                currentTime: video.currentTime,
                paused: video.paused,
                buffered: {
                  start: video.buffered.length > 0 ? video.buffered.start(0) : 0,
                  end: video.buffered.length > 0 ? video.buffered.end(0) : 0,
                }
              });
            });
            video.addEventListener('error', (e) => {
              console.log('Video error:', e);
            });
            setTimeout(() => {
              console.log('Timeout check:', {
                readyState: video.readyState,
                networkState: video.networkState,
                currentTime: video.currentTime,
                paused: video.paused,
              });
            }, 5000);
          </script>
        </body>
        </html>
      `);
    }
  });

  server.listen(8080, () => {
    console.log('Server running on http://localhost:8080');
  });

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto('http://localhost:8080');
    await page.waitForTimeout(6000); // Wait for video to load

    const logs = [];
    page.on('console', msg => logs.push(msg.text()));

    await page.waitForTimeout(1000);

    console.log('Page logs:', logs);

    // Take a screenshot
    await page.screenshot({ path: 'temp-video-inspection.png', fullPage: true });

    console.log('Screenshot saved as temp-video-inspection.png');

  } finally {
    await browser.close();
    server.close();
  }
}

inspectVideo().catch(console.error);