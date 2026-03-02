const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3331;
const DATA_DIR = path.join(process.cwd(), 'data_playwright_room_ui');
const BASE_URL = `http://127.0.0.1:${PORT}`;

function startServer() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server start timeout')), 15000);
    const onData = (buf) => {
      const text = buf.toString();
      if (text.includes('server.started') || text.includes('Secret Hitler Online')) {
        clearTimeout(timer);
        resolve(server);
      }
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
  });
}

function stopServer(server) {
  server.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    await page.fill('#auth-username', 'admin');
    await page.fill('#auth-password', 'admin123');
    await page.click('button:has-text("Zaloguj się")');

    await page.waitForSelector('button:has-text("+ Utwórz pokój")');
    await page.evaluate(() => App.showCreateRoom());
    await page.waitForSelector('#room-name-input');
    await page.fill('#room-name-input', 'Playwright Room');
    await page.evaluate(() => App.createRoom());

    await page.waitForFunction(() => typeof App !== 'undefined' && App.currentRoomId && document.querySelector('#room-bot-difficulty'));
    await page.selectOption('#room-bot-difficulty', 'hard');
    await page.waitForFunction(() => document.querySelector('#room-bot-difficulty')?.value === 'hard');

    await page.click('#room-add-bot-btn');
    await page.waitForFunction(() => {
      const el = document.querySelector('#bot-count-display');
      return el && Number(el.textContent) >= 1;
    });

    console.log('PLAYWRIGHT_ROOM_BOT_DIFFICULTY_SMOKE_OK');
  } finally {
    await browser.close();
    stopServer(server);
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
