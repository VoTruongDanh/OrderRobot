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
const BRIDGE_HIDE_CHAT_WINDOW = isTruthyEnv(process.env.BRIDGE_HIDE_CHAT_WINDOW, true);
const BRIDGE_LAUNCH_MINIMIZED = isTruthyEnv(process.env.BRIDGE_LAUNCH_MINIMIZED, BRIDGE_HIDE_CHAT_WINDOW);
const BRIDGE_LAUNCH_OFFSCREEN = isTruthyEnv(process.env.BRIDGE_LAUNCH_OFFSCREEN, BRIDGE_HIDE_CHAT_WINDOW);
const BRIDGE_HIDE_WINDOW = isTruthyEnv(process.env.BRIDGE_HIDE_WINDOW, BRIDGE_HIDE_CHAT_WINDOW);
const BRIDGE_HIDDEN_WINDOW_X = Number(process.env.BRIDGE_HIDDEN_WINDOW_X || -50000);
const BRIDGE_HIDDEN_WINDOW_Y = Number(process.env.BRIDGE_HIDDEN_WINDOW_Y || -50000);
const CHAT_URL = 'https://chatgpt.com/?temporary-chat=true';
const PROFILE_DIR = path.resolve(
  process.env.BRIDGE_PROFILE_DIR || process.cwd(),
  process.env.BRIDGE_PROFILE_DIR ? '' : '.bridge-chrome-profile',
);

let browser = null;
let chatPage = null;
let isShuttingDown = false;
let activeRequest = null;
let activeSessionId = '';
const resetPendingSessions = new Set();

function isTruthyEnv(value, defaultValue = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return Boolean(defaultValue);
  }
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

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
        ...(!BRIDGE_LAUNCH_MINIMIZED && !BRIDGE_LAUNCH_OFFSCREEN && !BRIDGE_HIDE_WINDOW ? ['--start-maximized'] : []),
        ...(BRIDGE_LAUNCH_MINIMIZED || BRIDGE_LAUNCH_OFFSCREEN || BRIDGE_HIDE_WINDOW ? ['--window-size=900,700'] : []),
        '--disable-blink-features=AutomationControlled',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
        ...(BRIDGE_LAUNCH_MINIMIZED ? ['--start-minimized'] : []),
        ...(BRIDGE_LAUNCH_OFFSCREEN ? ['--window-position=-32000,-32000'] : []),
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const pages = await browser.pages();
    chatPage = pages[0] || await browser.newPage();
    await forceHideBrowserWindow(chatPage);

    console.log(`[Bridge] 🌐 Navigating to ChatGPT...`);
    await chatPage.goto(CHAT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await forceHideBrowserWindow(chatPage);

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

async function forceHideBrowserWindow(page) {
  if (!page || (!BRIDGE_HIDE_WINDOW && !BRIDGE_LAUNCH_OFFSCREEN && !BRIDGE_LAUNCH_MINIMIZED)) return;

  try {
    const client = await page.target().createCDPSession();
    const { windowId } = await client.send('Browser.getWindowForTarget');

    if (BRIDGE_LAUNCH_MINIMIZED || BRIDGE_HIDE_WINDOW) {
      try {
        await client.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'minimized' },
        });
      } catch {}
    }

    if (BRIDGE_LAUNCH_OFFSCREEN || BRIDGE_HIDE_WINDOW) {
      // Push browser very far away from visible desktop area.
      const safeX = Number.isFinite(BRIDGE_HIDDEN_WINDOW_X) ? BRIDGE_HIDDEN_WINDOW_X : -50000;
      const safeY = Number.isFinite(BRIDGE_HIDDEN_WINDOW_Y) ? BRIDGE_HIDDEN_WINDOW_Y : -50000;
      for (let i = 0; i < 3; i++) {
        try {
          await client.send('Browser.setWindowBounds', {
            windowId,
            bounds: {
              left: safeX,
              top: safeY,
              width: 900,
              height: 700,
              windowState: 'normal',
            },
          });
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
  } catch (err) {
    console.warn(`[Bridge] hide-window warning: ${err?.message || err}`);
  }
}

async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
    chatPage = null;
    activeSessionId = '';
    resetPendingSessions.clear();
  }
}

function createBridgeAbortError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        if (typeof item.text === 'string') return item.text.trim();
        if (typeof item.content === 'string') return item.content.trim();
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text.trim();
  }
  return '';
}

function buildPromptFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return '';
  }
  const normalized = messages
    .map((msg) => {
      if (!msg || typeof msg !== 'object') {
        return null;
      }
      const role = String(msg.role || 'user').trim().toUpperCase();
      const content = normalizeMessageContent(msg.content);
      if (!content) return null;
      if (role === 'SYSTEM' || role === 'USER' || role === 'ASSISTANT') {
        return { role, content };
      }
      return { role: 'USER', content };
    })
    .filter(Boolean);

  if (normalized.length === 0) {
    return '';
  }

  const lines = [
    'Follow SYSTEM instructions strictly.',
    'Conversation transcript:',
    ...normalized.map((entry) => `${entry.role}: ${entry.content}`),
    'Answer naturally in Vietnamese for an ordering robot assistant.',
  ];
  return lines.join('\n\n').trim();
}

function computeDeltaText(previousText, currentText) {
  const prev = String(previousText || '');
  const curr = String(currentText || '');
  if (!curr) return '';
  if (!prev) return curr;
  if (curr.startsWith(prev)) {
    return curr.slice(prev.length);
  }
  let index = 0;
  const limit = Math.min(prev.length, curr.length);
  while (index < limit && prev[index] === curr[index]) {
    index += 1;
  }
  return curr.slice(index);
}

async function stopActiveGeneration(page) {
  if (!page) return;
  try {
    await page.evaluate(() => {
      const stopButton =
        document.querySelector('button[data-testid="stop-button"]') ||
        document.querySelector('button[data-testid="fruitjuice-stop-button"]') ||
        document.querySelector('button[aria-label*="Stop"]');
      if (stopButton && !stopButton.disabled) {
        stopButton.click();
      }
    });
  } catch {}
}

async function waitForRequestIdle(timeoutMs = 2500) {
  const startedAt = Date.now();
  while (activeRequest && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return !activeRequest;
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

async function waitForGenerationDone(page, timeoutMs = 10000, requestControl = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (requestControl?.cancelled) {
      throw createBridgeAbortError(
        requestControl.reason || 'aborted_by_newer_turn',
        'Request aborted while waiting for generation to stop',
      );
    }
    const generating = await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label*="Stop"], button[data-testid="stop-button"], button[data-testid="fruitjuice-stop-button"]');
      return !!(btn && !btn.disabled);
    });
    if (!generating) return true;
    await new Promise(r => setTimeout(r, 160));
  }
  return false;
}

async function startNewTemporaryChat(page, reason = 'session') {
  if (!page) return;
  const startedAt = Date.now();
  await page.goto(CHAT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await forceHideBrowserWindow(page);
  const baselineCount = await page.evaluate(() =>
    document.querySelectorAll('[data-message-author-role="assistant"]').length
  );
  console.log(`[Bridge] temporary-chat-reset reason=${reason} assistant_count=${baselineCount} ms=${Date.now() - startedAt}`);
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

async function sendPromptAndWaitResponse(prompt, requestControl, maxTimeoutMs = 120000, onDelta = null) {
  if (!chatPage || !browser) throw new Error('Browser not ready');

  const throwIfAborted = () => {
    if (requestControl?.cancelled) {
      throw createBridgeAbortError(
        requestControl.reason || 'aborted_by_newer_turn',
        'Request aborted by newer turn',
      );
    }
  };

  throwIfAborted();

  await waitForGenerationDone(chatPage, 12000, requestControl);
  throwIfAborted();

  const baselineCount = await chatPage.evaluate(() =>
    document.querySelectorAll('[data-message-author-role="assistant"]').length
  );

  const input = await findInput(chatPage);
  if (!input) throw new Error('Cannot find ChatGPT input field');
  throwIfAborted();

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

  if (input.sel.includes('contenteditable') || input.sel === '#prompt-textarea') {
    await chatPage.evaluate((sel, textValue) => {
      const el = document.querySelector(sel);
      if (el) {
        el.focus();
        if (el.contentEditable === 'true') {
          el.textContent = textValue;
        } else {
          el.value = textValue;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, input.sel, prompt);
  }

  await new Promise((resolve) => setTimeout(resolve, 220));
  throwIfAborted();

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
    await chatPage.keyboard.press('Enter');
  }

  console.log('[Bridge] Prompt sent, waiting for response...');

  const startTime = Date.now();
  let lastText = '';
  let stableCount = 0;
  let hasNewMessage = false;
  let emittedText = '';

  while (Date.now() - startTime < maxTimeoutMs) {
    throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const currentCount = await chatPage.evaluate(() =>
      document.querySelectorAll('[data-message-author-role="assistant"]').length
    );

    if (currentCount > baselineCount) {
      hasNewMessage = true;
    }

    if (!hasNewMessage) continue;

    const generating = await isGenerating(chatPage);
    const textValue = await readLatestAssistant(chatPage);
    const delta = computeDeltaText(emittedText, textValue);
    if (delta && typeof onDelta === 'function') {
      onDelta(delta);
      emittedText = textValue;
    } else if (!emittedText && textValue) {
      emittedText = textValue;
    }

    if (!generating && textValue && textValue.length > 0) {
      if (textValue === lastText) {
        stableCount += 1;
        if (stableCount >= 1) {
          console.log(`[Bridge] Response received (${textValue.length} chars)`);
          return textValue;
        }
      } else {
        stableCount = 0;
      }
    } else {
      stableCount = 0;
    }
    lastText = textValue;
  }

  if (lastText) return lastText;
  throw new Error('Timeout waiting for ChatGPT response');
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
      busy: Boolean(activeRequest),
      active_session_id: activeRequest?.sessionId || null,
      active_turn_id: activeRequest?.turnId || null,
    });
  }

  if (req.method === 'GET' && url.pathname === '/ping') {
    return json(200, {
      ok: true,
      ts: Date.now(),
      busy: Boolean(activeRequest),
    });
  }

  if (
    req.method === 'POST'
    && (
      url.pathname === '/internal/bridge/chat'
      || url.pathname === '/v1/chat/completions'
      || url.pathname === '/internal/bridge/chat/stream'
    )
  ) {
    let requestControl = null;
    const isStreamPath = url.pathname === '/internal/bridge/chat/stream';
    const requestStartedAt = Date.now();
    let preempted = false;
    try {
      const body = await readJsonBody(req);
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const sessionId = String(body?.session_id || '').trim();
      const turnId = String(body?.turn_id || '').trim();
      const latestWins = body?.latest_wins !== false;
      const prompt = buildPromptFromMessages(messages) || JSON.stringify(body);

      console.log(`[Bridge] request_received chars=${prompt.length} session_id=${sessionId || '-'} turn_id=${turnId || '-'} stream=${isStreamPath}`);

      if (activeRequest) {
        const canPreempt =
          latestWins
          && sessionId
          && activeRequest.sessionId
          && activeRequest.sessionId === sessionId;

        if (!canPreempt) {
          return json(429, {
            error: 'Bridge is busy',
            code: 'busy',
            active_session_id: activeRequest.sessionId || null,
            active_turn_id: activeRequest.turnId || null,
          });
        }

        preempted = true;
        activeRequest.cancelled = true;
        activeRequest.reason = 'aborted_by_newer_turn';
        await stopActiveGeneration(chatPage);
        const released = await waitForRequestIdle(2500);
        if (!released) {
          return json(409, {
            error: 'Could not preempt active request in time.',
            code: 'preempt_timeout',
          });
        }
      }

      if (sessionId && (sessionId !== activeSessionId || resetPendingSessions.has(sessionId))) {
        const resetReason = sessionId !== activeSessionId ? 'session_switch' : 'manual_reset';
        await startNewTemporaryChat(chatPage, `${resetReason}:${sessionId}`);
        activeSessionId = sessionId;
        resetPendingSessions.delete(sessionId);
      }

      requestControl = {
        sessionId,
        turnId,
        cancelled: false,
        reason: '',
      };
      activeRequest = requestControl;
      console.log(`[Bridge] bridge_request_ms=${Date.now() - requestStartedAt} session_id=${sessionId || '-'} turn_id=${turnId || '-'} preempted=${preempted}`);

      if (isStreamPath) {
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Transfer-Encoding': 'chunked',
          'Access-Control-Allow-Origin': '*',
        });
        let streamedAny = false;
        const content = await sendPromptAndWaitResponse(
          prompt,
          requestControl,
          120000,
          (delta) => {
            const safeDelta = String(delta || '');
            if (!safeDelta) return;
            streamedAny = true;
            res.write(`${JSON.stringify({
              type: 'text',
              content: safeDelta,
              source: 'bridge',
              session_id: sessionId || null,
              turn_id: turnId || null,
            })}\n`);
          },
        );
        const replyMs = Date.now() - requestStartedAt;
        if (!streamedAny && content) {
          res.write(`${JSON.stringify({
            type: 'text',
            content,
            source: 'bridge',
            session_id: sessionId || null,
            turn_id: turnId || null,
          })}\n`);
        }
        res.write(`${JSON.stringify({
          type: 'text_final',
          content: String(content || ''),
          source: 'bridge',
          code: 'ok',
          reason: preempted ? 'preempted_older_turn' : null,
          latency_ms: replyMs,
          session_id: sessionId || null,
          turn_id: turnId || null,
        })}\n`);
        res.write(`${JSON.stringify({ type: 'done' })}\n`);
        console.log(`[Bridge] bridge_reply_ms=${replyMs} bridge_source=bridge session_id=${sessionId || '-'} turn_id=${turnId || '-'} preempted=${preempted}`);
        return res.end();
      }

      const content = await sendPromptAndWaitResponse(prompt, requestControl);
      const latencyMs = Date.now() - requestStartedAt;
      console.log(`[Bridge] bridge_reply_ms=${latencyMs} bridge_source=bridge session_id=${sessionId || '-'} turn_id=${turnId || '-'} preempted=${preempted}`);

      if (url.pathname === '/v1/chat/completions') {
        return json(200, {
          id: `chatcmpl-${uuidv4()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'chatgpt-bridge',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
        });
      }
      return json(200, {
        reply_text: content,
        source: 'bridge',
        code: 'ok',
        reason: preempted ? 'preempted_older_turn' : null,
        latency_ms: latencyMs,
      });
    } catch (err) {
      if (isStreamPath) {
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Transfer-Encoding': 'chunked',
            'Access-Control-Allow-Origin': '*',
          });
        }
        res.write(`${JSON.stringify({
          type: 'error',
          code: err?.code || 'bridge_error',
          message: String(err?.message || 'Bridge stream failed'),
        })}\n`);
        res.write(`${JSON.stringify({ type: 'done' })}\n`);
        return res.end();
      }
      if (err?.code === 'aborted_by_newer_turn') {
        return json(409, {
          error: 'aborted_by_newer_turn',
          code: 'aborted_by_newer_turn',
          source: 'bridge',
          reason: 'aborted_by_newer_turn',
        });
      }
      console.error('[Bridge] API Error:', err.message);
      return json(500, { error: err.message, source: 'fallback', code: 'bridge_error' });
    } finally {
      if (requestControl && activeRequest === requestControl) {
        activeRequest = null;
      }
    }
  }

  if (req.method === 'POST' && url.pathname === '/internal/bridge/reset-temp-chat') {
    try {
      const body = await readJsonBody(req);
      const sessionId = String(body?.session_id || '').trim();
      if (sessionId) {
        resetPendingSessions.add(sessionId);
      }
      if (sessionId && activeSessionId === sessionId) {
        await startNewTemporaryChat(chatPage, `api_reset:${sessionId}`);
        resetPendingSessions.delete(sessionId);
      }
      return json(200, { ok: true, source: 'bridge', detail: 'temporary chat reset queued' });
    } catch (err) {
      return json(500, {
        ok: false,
        source: 'fallback',
        detail: String(err?.message || 'reset failed'),
      });
    }
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

function splitResponseSegments(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return [];
  const bySentence = normalized
    .split(/(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (bySentence.length > 0) {
    return bySentence;
  }
  return [normalized];
}

// --- Start ---
httpServer.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[Bridge] ❌ Port ${PORT} is already in use on ${HOST}.`);
    console.error('[Bridge] Try stopping the old bridge process or run `npm run dev:bridge:dev` to force restart.');
    process.exit(1);
    return;
  }

  console.error('[Bridge] ❌ HTTP server error:', err?.message || err);
  process.exit(1);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`\n======================================================`);
  console.log(`🔥 Bridge Server on port ${PORT} (Puppeteer Direct Mode)`);
  console.log(`🚫 NO extension, NO injection, NO WebSocket from page`);
  console.log(`🛡️ Stealth plugin active — undetectable by ChatGPT`);
  console.log(`[Bridge] launch_minimized=${BRIDGE_LAUNCH_MINIMIZED} launch_offscreen=${BRIDGE_LAUNCH_OFFSCREEN}`);
  console.log(`======================================================\n`);

  setTimeout(async () => {
    await launchBrowser();
  }, 1000);
});
