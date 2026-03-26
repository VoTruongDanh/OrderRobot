import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { URL } from 'node:url';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Anti-bot detection
puppeteer.use(StealthPlugin());

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.env.BRIDGE_GATEWAY_PORT || 1122);
const PREFERRED_BROWSER = process.env.BRIDGE_PREFERRED_BROWSER || 'chrome';
const CHAT_URL = 'https://chatgpt.com/?temporary-chat=true';
const PROFILE_DIR = path.resolve(process.cwd(), '.bridge-chrome-profile');

let browser = null;
let chatPage = null;
let isShuttingDown = false;
let isBusy = false;

// --- Find Chrome/Edge executable ---
function getExecutable() {
  if (os.platform() !== 'win32') return null;
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const la = process.env['LocalAppData'] || path.join(os.homedir(), 'AppData', 'Local');

  const paths = PREFERRED_BROWSER === 'chrome'
    ? [`${pf}\\Google\\Chrome\\Application\\chrome.exe`,
       `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
       `${la}\\Google\\Chrome\\Application\\chrome.exe`]
    : [`${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
       `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
       `${la}\\Microsoft\\Edge\\Application\\msedge.exe`];

  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// =============================================================
// Architecture: Direct Puppeteer DOM interaction (NO extension, 
// NO script injection, NO WebSocket from page, NO CSP bypass)
//
// Flow: HTTP request → Puppeteer types in ChatGPT → reads response → HTTP response
// This looks identical to a real user to ChatGPT's bot detection.
// =============================================================

async function launchBrowser() {
  const executable = getExecutable();
  if (!executable) {
    console.warn(`[Bridge] ❌ ${PREFERRED_BROWSER} not found.`);
    return false;
  }

  await closeBrowser();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log(`[Bridge] 🚀 Launching ${PREFERRED_BROWSER}...`);

  try {
    browser = await puppeteer.launch({
      executablePath: executable,
      headless: false,
      defaultViewport: null,
      userDataDir: PROFILE_DIR, // Persistent profile for login session
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const pages = await browser.pages();
    chatPage = pages[0] || await browser.newPage();

    console.log(`[Bridge] 🌐 Navigating to ChatGPT...`);
    await chatPage.goto(CHAT_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    const pid = browser.process()?.pid;
    console.log(`[Bridge] ✅ Browser ready! PID: ${pid}`);

    browser.on('disconnected', () => {
      console.log(`[Bridge] ⚠️  Browser closed.`);
      browser = null;
      chatPage = null;
      if (!isShuttingDown) {
        console.log(`[Bridge] 🔄 Relaunching in 3s...`);
        setTimeout(() => { if (!isShuttingDown) launchBrowser(); }, 3000);
      }
    });

    return true;
  } catch (err) {
    console.error(`[Bridge] ❌ Launch failed:`, err.message);
    browser = null;
    chatPage = null;
    if (!isShuttingDown) {
      setTimeout(() => { if (!isShuttingDown) launchBrowser(); }, 5000);
    }
    return false;
  }
}

async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
    chatPage = null;
  }
}

// --- ChatGPT Interaction via Puppeteer (like a real user) ---

async function findInput(page, timeoutMs = 15000) {
  const selectors = [
    '#prompt-textarea',
    'div[contenteditable="true"][id="prompt-textarea"]',
    'textarea[id="prompt-textarea"]',
    'div[contenteditable="true"]',
  ];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) return { el, sel };
      } catch {}
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

async function waitForGenerationDone(page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const generating = await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label*="Stop"], button[data-testid="stop-button"], button[data-testid="fruitjuice-stop-button"]');
      return !!(btn && !btn.disabled);
    });
    if (!generating) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function readLatestAssistant(page) {
  return page.evaluate(() => {
    const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (!nodes.length) return '';
    const last = nodes[nodes.length - 1];
    const md = last.querySelector('.markdown, [data-message-content="true"], [class*="markdown"]');
    const target = md || last;
    return (target.innerText || target.textContent || '').trim();
  });
}

async function isGenerating(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('button[aria-label*="Stop"], button[data-testid="stop-button"], button[data-testid="fruitjuice-stop-button"]');
    return !!(btn && !btn.disabled);
  });
}

async function sendPromptAndWaitResponse(prompt, maxTimeoutMs = 120000) {
  if (!chatPage || !browser) throw new Error('Browser not ready');
  if (isBusy) throw new Error('Already processing a task');
  
  isBusy = true;
  try {
    // 1. Wait for any previous generation to finish
    await waitForGenerationDone(chatPage, 12000);
    
    // 2. Count existing assistant messages (baseline)
    const baselineCount = await chatPage.evaluate(() => 
      document.querySelectorAll('[data-message-author-role="assistant"]').length
    );

    // 3. Find input
    const input = await findInput(chatPage);
    if (!input) throw new Error('Cannot find ChatGPT input field');

    // 4. Clear and type prompt
    await chatPage.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.focus();
        if (el.contentEditable === 'true') {
          el.textContent = '';
        } else {
          el.value = '';
        }
      }
    }, input.sel);

    // Type with slight delay to look human
    if (input.sel.includes('contenteditable') || input.sel === '#prompt-textarea') {
      await chatPage.evaluate((sel, text) => {
        const el = document.querySelector(sel);
        if (el) {
          el.focus();
          if (el.contentEditable === 'true') {
            el.textContent = text;
          } else {
            el.value = text;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, input.sel, prompt);
    }

    await new Promise(r => setTimeout(r, 300));

    // 5. Click send button
    const sent = await chatPage.evaluate(() => {
      const selectors = [
        'button[data-testid="send-button"]',
        'button[data-testid="fruitjuice-send-button"]',
        'button[aria-label*="Send"]',
        'button[type="submit"]',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!sent) {
      // Try Enter key
      await chatPage.keyboard.press('Enter');
    }

    console.log(`[Bridge] 📤 Prompt sent, waiting for response...`);

    // 6. Wait for response
    const startTime = Date.now();
    let lastText = '';
    let stableCount = 0;
    let hasNewMessage = false;

    while (Date.now() - startTime < maxTimeoutMs) {
      await new Promise(r => setTimeout(r, 1000));

      const currentCount = await chatPage.evaluate(() =>
        document.querySelectorAll('[data-message-author-role="assistant"]').length
      );

      if (currentCount > baselineCount) {
        hasNewMessage = true;
      }

      if (!hasNewMessage) continue;

      const generating = await isGenerating(chatPage);
      const text = await readLatestAssistant(chatPage);

      if (!generating && text && text.length > 0) {
        if (text === lastText) {
          stableCount++;
          if (stableCount >= 3) {
            console.log(`[Bridge] 📥 Response received (${text.length} chars)`);
            return text;
          }
        } else {
          stableCount = 0;
        }
      } else {
        stableCount = 0;
      }
      lastText = text;
    }

    if (lastText) return lastText;
    throw new Error('Timeout waiting for ChatGPT response');

  } finally {
    isBusy = false;
  }
}

// --- Cleanup ---
process.on('SIGINT', async () => { isShuttingDown = true; await closeBrowser(); process.exit(); });
process.on('SIGTERM', async () => { isShuttingDown = true; await closeBrowser(); process.exit(); });
process.on('exit', () => {
  isShuttingDown = true;
  if (browser) {
    try { process.kill(browser.process()?.pid, 'SIGTERM'); } catch {}
  }
});

// --- HTTP Server ---
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  function json(code, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(200, {
      status: 'ok',
      mode: 'puppeteer-direct',
      port: PORT,
      browserReady: !!browser && !!chatPage,
      busy: isBusy,
    });
  }

  if (req.method === 'POST' && (url.pathname === '/internal/bridge/chat' || url.pathname === '/v1/chat/completions')) {
    try {
      const body = await readJsonBody(req);
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      
      // Build prompt from messages
      let prompt = '';
      if (messages.length > 0) {
        const last = messages[messages.length - 1];
        prompt = typeof last === 'string' ? last : (last?.content || JSON.stringify(messages));
      } else {
        prompt = JSON.stringify(body);
      }

      console.log(`[Bridge] Received chat request (${prompt.length} chars)`);

      const startTime = Date.now();
      const content = await sendPromptAndWaitResponse(prompt);
      const latencyMs = Date.now() - startTime;

      console.log(`[Bridge] Chat fulfilled in ${latencyMs}ms`);

      if (url.pathname === '/v1/chat/completions') {
        return json(200, {
          id: `chatcmpl-${uuidv4()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'chatgpt-bridge',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
        });
      }
      return json(200, { reply_text: content, source: 'puppeteer-direct', latency_ms: latencyMs });
    } catch (err) {
      console.error('[Bridge] API Error:', err.message);
      return json(500, { error: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/internal/bridge/reset-temp-chat') {
    return json(200, { ok: true });
  }

  return json(404, { error: 'Not Found' });
});

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 2_000_000) { reject(new Error('Payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// --- Start ---
httpServer.listen(PORT, HOST, () => {
  console.log(`\n======================================================`);
  console.log(`🔥 Bridge Server on port ${PORT} (Puppeteer Direct Mode)`);
  console.log(`🚫 NO extension, NO injection, NO WebSocket from page`);
  console.log(`🛡️ Stealth plugin active — undetectable by ChatGPT`);
  console.log(`======================================================\n`);

  setTimeout(async () => {
    await launchBrowser();
  }, 1000);
});
