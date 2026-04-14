import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const CORE_PORT = 8011;
const AI_PORT = 8012;
const BRIDGE_PORT = 1122;
const HOST = '127.0.0.1';

const managedChildren = [];
let mainWindow = null;
let uiServer = null;
let runtimeRootDir = '';
let runtimeLoginConfig = null;
let startupPromise = null;
let desktopLogFilePath = '';

const APP_DISPLAY_NAME = 'OrderRobot';
const bootstrapAppDataRoot = path.join(
  process.env.APPDATA || app.getPath('appData'),
  APP_DISPLAY_NAME,
);
const bootstrapLogFilePath = path.join(bootstrapAppDataRoot, 'logs', 'desktop-bootstrap.log');

function writeBootstrapLog(level, message, detail = null) {
  const line = [
    new Date().toISOString(),
    level,
    message,
    detail == null ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail),
  ]
    .filter(Boolean)
    .join(' | ');
  try {
    fs.mkdirSync(path.dirname(bootstrapLogFilePath), { recursive: true });
    fs.appendFileSync(bootstrapLogFilePath, `${line}\n`, 'utf8');
  } catch {}
}

app.setName(APP_DISPLAY_NAME);
try {
  app.setPath('userData', bootstrapAppDataRoot);
  writeBootstrapLog('info', 'bootstrap-userData-path', bootstrapAppDataRoot);
} catch (error) {
  writeBootstrapLog('error', 'bootstrap-userData-path-failed', error instanceof Error ? error.message : String(error));
}

function getAppRoot() {
  return app.isPackaged ? app.getAppPath() : REPO_ROOT;
}

function getBackendExecutable(name) {
  return path.join(process.resourcesPath, 'backends', name, `${name}.exe`);
}

function getDesktopIconPath() {
  return path.join(getAppRoot(), 'desktop', 'assets', 'orderrobot.ico');
}

function writeDesktopLog(level, message, detail = null) {
  const line = [
    new Date().toISOString(),
    level,
    message,
    detail == null ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail),
  ]
    .filter(Boolean)
    .join(' | ');

  try {
    console[level === 'error' ? 'error' : 'log'](`[desktop] ${message}`, detail ?? '');
  } catch {}

  writeBootstrapLog(level, message, detail);

  if (!desktopLogFilePath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(desktopLogFilePath), { recursive: true });
    fs.appendFileSync(desktopLogFilePath, `${line}\n`, 'utf8');
  } catch {}
}

function parseEnvText(content) {
  const values = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function readRuntimeEnv(runtimeRoot) {
  const envPath = path.join(runtimeRoot, '.env');
  try {
    const content = await fsp.readFile(envPath, 'utf8');
    return parseEnvText(content);
  } catch {
    return {};
  }
}

function resolveLoginConfig(envValues) {
  const loginUrl =
    String(envValues.POS_AUTH_LOGIN_URL || process.env.POS_AUTH_LOGIN_URL || '').trim() ||
    'http://cnxvn.ddns.net:8080/api/v1/auth/login';
  const refreshUrl =
    String(envValues.POS_AUTH_REFRESH_URL || process.env.POS_AUTH_REFRESH_URL || '').trim();
  return {
    loginUrl,
    refreshUrl,
    usernameHint: String(envValues.POS_API_USERNAME || '').trim(),
  };
}

function extractTokenPayload(payload) {
  const data =
    payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object'
      ? payload.data
      : payload;
  if (!data || typeof data !== 'object') {
    return null;
  }
  const accessToken = String(data.accessToken || '').trim().replace(/^Bearer\s+/i, '');
  const refreshToken = String(data.refreshToken || '').trim();
  if (!accessToken) {
    return null;
  }
  return {
    accessToken,
    refreshToken,
  };
}

function pickErrorMessage(payload, fallbackText) {
  if (payload && typeof payload === 'object') {
    const direct = String(payload.message || payload.error || payload.detail || '').trim();
    if (direct) {
      return direct;
    }
    if (payload.data && typeof payload.data === 'object') {
      const nested = String(payload.data.message || payload.data.error || '').trim();
      if (nested) {
        return nested;
      }
    }
  }
  return fallbackText;
}

async function authenticateLogin({ loginUrl, username, password }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(loginUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'OrderRobot-Desktop/1.0',
      },
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new Error(
        pickErrorMessage(payload, `Dang nhap that bai (HTTP ${response.status}).`),
      );
    }

    const tokenPayload = extractTokenPayload(payload);
    if (!tokenPayload) {
      throw new Error('Dang nhap thanh cong nhung khong nhan duoc accessToken.');
    }

    return tokenPayload;
  } finally {
    clearTimeout(timeoutId);
  }
}

function createLoadingHtml(statusText) {
  return `<!doctype html>
  <html lang="vi">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>OrderRobot</title>
      <style>
        :root {
          color-scheme: light;
          font-family: "Segoe UI", Tahoma, sans-serif;
        }
        body {
          margin: 0;
          min-height: 100vh;
          display: grid;
          place-items: center;
          background:
            radial-gradient(circle at top, rgba(0, 216, 255, 0.2), transparent 34%),
            radial-gradient(circle at bottom, rgba(255, 0, 153, 0.16), transparent 32%),
            linear-gradient(135deg, #edf7ff 0%, #f7fbff 52%, #eef3ff 100%);
          color: #16364a;
        }
        .shell {
          width: min(560px, calc(100vw - 48px));
          padding: 28px 30px;
          border-radius: 24px;
          background: rgba(255, 255, 255, 0.82);
          border: 1px solid rgba(98, 184, 222, 0.24);
          box-shadow: 0 24px 60px rgba(31, 77, 110, 0.18);
          backdrop-filter: blur(18px);
        }
        .eyebrow {
          margin: 0 0 10px;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: #1397bd;
        }
        h1 {
          margin: 0 0 10px;
          font-size: 34px;
          line-height: 1.05;
        }
        p {
          margin: 0;
          font-size: 16px;
          line-height: 1.6;
          color: #45647b;
        }
        .status {
          margin-top: 20px;
          padding: 16px 18px;
          border-radius: 18px;
          background: rgba(19, 151, 189, 0.08);
          border: 1px solid rgba(19, 151, 189, 0.18);
          color: #166d8b;
          font-weight: 600;
        }
      </style>
    </head>
    <body>
      <main class="shell">
        <p class="eyebrow">OrderRobot Desktop</p>
        <h1>Dang khoi dong he thong</h1>
        <p>Ung dung dang mo kiosk UI, core backend, AI backend va bridge browser an de gui tin nhan.</p>
        <div class="status" id="status">${statusText}</div>
      </main>
    </body>
  </html>`;
}

async function setLoadingStatus(statusText) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const safeText = JSON.stringify(String(statusText));
  try {
    await mainWindow.webContents.executeJavaScript(
      `(() => {
        const el = document.getElementById('status');
        if (el) el.textContent = ${safeText};
      })();`,
      true,
    );
  } catch {
    // Ignore if the loading page has already been replaced.
  }
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function copyIfMissing(sourcePath, targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return;
  } catch {
    // File does not exist yet.
  }
  await ensureDir(path.dirname(targetPath));
  await fsp.copyFile(sourcePath, targetPath);
}

async function seedRuntimeFiles(runtimeRoot) {
  const appRoot = getAppRoot();
  await ensureDir(runtimeRoot);
  await ensureDir(path.join(runtimeRoot, 'data'));
  await ensureDir(path.join(runtimeRoot, '.bridge-chrome-profile'));

  await copyIfMissing(path.join(appRoot, '.env.example'), path.join(runtimeRoot, '.env'));
  await copyIfMissing(path.join(appRoot, 'data', 'menu.csv'), path.join(runtimeRoot, 'data', 'menu.csv'));
  await copyIfMissing(path.join(appRoot, 'data', 'orders.csv'), path.join(runtimeRoot, 'data', 'orders.csv'));
}

async function loadLoginScreen() {
  if (!mainWindow) {
    return;
  }
  const loginUrl = pathToFileURL(path.join(getAppRoot(), 'desktop', 'login.html')).toString();
  writeDesktopLog('info', 'loading-login-screen', loginUrl);
  await mainWindow.loadURL(loginUrl);
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.glb': 'model/gltf-binary',
      '.gltf': 'model/gltf+json',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ico': 'image/x-icon',
    }[ext] || 'application/octet-stream'
  );
}

async function startStaticServer(distRoot) {
  return await new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url || '/', `http://${HOST}`);
        let pathname = decodeURIComponent(url.pathname);
        if (pathname === '/') {
          pathname = '/index.html';
        }
        const candidatePath = path.normalize(path.join(distRoot, pathname));
        if (!candidatePath.startsWith(path.normalize(distRoot))) {
          response.writeHead(403).end('Forbidden');
          return;
        }

        let filePath = candidatePath;
        let exists = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
        if (!exists) {
          filePath = path.join(distRoot, 'index.html');
          exists = fs.existsSync(filePath);
        }

        if (!exists) {
          response.writeHead(404).end('Not found');
          return;
        }

        response.writeHead(200, { 'Content-Type': getMimeType(filePath) });
        fs.createReadStream(filePath).pipe(response);
      } catch (error) {
        response.writeHead(500).end(String(error));
      }
    });

    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Cannot determine UI server address.'));
        return;
      }
      resolve({
        server,
        url: `http://${HOST}:${address.port}`,
      });
    });
  });
}

function startManagedProcess(name, command, args, extraOptions = {}) {
  const child = spawn(command, args, {
    cwd: extraOptions.cwd || (app.isPackaged ? process.resourcesPath : REPO_ROOT),
    env: { ...process.env, ...extraOptions.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout?.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (text) {
      writeDesktopLog('info', `${name}-stdout`, text);
    }
  });
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (text) {
      writeDesktopLog('error', `${name}-stderr`, text);
    }
  });
  child.once('exit', (code, signal) => {
    writeDesktopLog('info', `${name}-exit`, { code, signal });
  });

  managedChildren.push(child);
  return child;
}

async function waitForHealth(url, timeoutMs = 180000) {
  const startedAt = Date.now();
  let lastError = 'Unknown error';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error(`Health check failed for ${url}: ${lastError}`);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false, // Start hidden, will show manually
    autoHideMenuBar: true,
    backgroundColor: '#edf7ff',
    icon: fs.existsSync(getDesktopIconPath()) ? getDesktopIconPath() : undefined,
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      devTools: true, // Force enable devTools for debugging
      preload: path.join(getAppRoot(), 'desktop', 'preload.cjs'),
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.removeMenu();

  // Force show immediately after creation
  mainWindow.show();
  writeBootstrapLog('info', 'mainWindow-shown-immediately');

  mainWindow.once('ready-to-show', () => {
    writeDesktopLog('info', 'main-window-ready-to-show');
    mainWindow?.show();
    mainWindow?.maximize();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    writeDesktopLog('info', 'main-window-did-finish-load', mainWindow?.webContents.getURL() || '');
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    writeDesktopLog('error', 'main-window-did-fail-load', { code, description, validatedUrl });
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeDesktopLog('error', 'render-process-gone', details);
  });
  mainWindow.on('unresponsive', () => {
    writeDesktopLog('error', 'main-window-unresponsive');
  });

  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      writeDesktopLog('info', 'forcing-main-window-show-after-timeout');
      mainWindow.show();
    }
  }, 1800);

  hardenWindow(mainWindow);
}

function isAllowedNavigation(targetUrl) {
  const normalized = String(targetUrl || '').trim();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith('data:text/html')) {
    return true;
  }
  if (normalized.startsWith('file://')) {
    return normalized.includes('/desktop/login.html');
  }
  if (uiServer?.url && normalized.startsWith(uiServer.url)) {
    return true;
  }
  return false;
}

function hardenWindow(targetWindow) {
  const contents = targetWindow.webContents;

  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
    }
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
    }
  });

  if (!app.isPackaged) {
    return; // Only harden in production
  }

  contents.on('context-menu', (event) => {
    event.preventDefault();
  });

  contents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toUpperCase();
    const ctrl = Boolean(input.control);
    const shift = Boolean(input.shift);
    const alt = Boolean(input.alt);

    const blocked =
      key === 'F12' ||
      key === 'F5' ||
      (ctrl && key === 'R') ||
      (ctrl && shift && ['I', 'J', 'C'].includes(key)) ||
      (ctrl && alt && ['I', 'J', 'C'].includes(key));

    if (blocked) {
      event.preventDefault();
    }
  });

  contents.on('devtools-opened', () => {
    // Allow devTools for debugging
    // contents.closeDevTools();
  });
}

function configurePermissions() {
  app.on('web-contents-created', (_, contents) => {
    const currentSession = contents.session;
    currentSession.setPermissionCheckHandler((_wc, permission) =>
      ['media', 'microphone', 'camera'].includes(permission),
    );
    currentSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(['media', 'microphone', 'camera'].includes(permission));
    });
  });
}

async function bootstrapDesktop(authSession) {
  const appRoot = getAppRoot();
  const runtimeRoot = runtimeRootDir;
  const distRoot = path.join(appRoot, 'apps', 'kiosk-ui', 'dist');

  if (!fs.existsSync(path.join(distRoot, 'index.html'))) {
    throw new Error(
      `Khong tim thay UI production build tai ${distRoot}. Hay chay npm run build:ui truoc khi dong goi.`,
    );
  }

  await seedRuntimeFiles(runtimeRoot);
  await setLoadingStatus('Dang bat server UI noi bo...');
  uiServer = await startStaticServer(distRoot);

  const sharedEnv = {
    HOST,
    ORDERROBOT_ROOT_DIR: runtimeRoot,
    BRIDGE_BASE_URL: `http://${HOST}:${BRIDGE_PORT}`,
    CORE_BACKEND_URL: `http://${HOST}:${CORE_PORT}`,
    POS_AUTH_LOGIN_URL: String(runtimeLoginConfig?.loginUrl || ''),
    POS_AUTH_REFRESH_URL: String(runtimeLoginConfig?.refreshUrl || ''),
    POS_API_USERNAME: String(authSession?.username || ''),
    POS_API_PASSWORD: String(authSession?.password || ''),
    POS_API_TOKEN: String(authSession?.accessToken || ''),
    VITE_CORE_API_URL: `http://${HOST}:${CORE_PORT}`,
    VITE_AI_API_URL: `http://${HOST}:${AI_PORT}`,
    VITE_MENU_API_URL: `http://${HOST}:${CORE_PORT}/menu`,
    VITE_ORDERS_API_URL: `http://${HOST}:${CORE_PORT}/orders`,
  };

  await setLoadingStatus('Dang bat bridge browser an...');
  startManagedProcess(
    'bridge',
    process.execPath,
    [path.join(appRoot, 'scripts', 'bridge-server.mjs')],
    {
      env: {
        ...sharedEnv,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(BRIDGE_PORT),
        BRIDGE_HIDE_CHAT_WINDOW: 'true',
        BRIDGE_HIDE_WINDOW: 'true',
        BRIDGE_LAUNCH_MINIMIZED: 'true',
        BRIDGE_LAUNCH_OFFSCREEN: 'true',
        BRIDGE_PROFILE_DIR: path.join(runtimeRoot, '.bridge-chrome-profile'),
      },
    },
  );

  await setLoadingStatus('Dang bat core backend...');
  if (app.isPackaged) {
    if (!fs.existsSync(getBackendExecutable('OrderRobotCoreBackend'))) {
      throw new Error('Khong tim thay OrderRobotCoreBackend.exe trong goi cai dat.');
    }
    startManagedProcess('core', getBackendExecutable('OrderRobotCoreBackend'), [], {
      env: { ...sharedEnv, PORT: String(CORE_PORT) },
    });
  } else {
    startManagedProcess('core', 'python', ['services/core-backend/run_server.py'], {
      env: { ...sharedEnv, PORT: String(CORE_PORT) },
    });
  }

  await setLoadingStatus('Dang bat AI backend...');
  if (app.isPackaged) {
    if (!fs.existsSync(getBackendExecutable('OrderRobotAiBackend'))) {
      throw new Error('Khong tim thay OrderRobotAiBackend.exe trong goi cai dat.');
    }
    startManagedProcess('ai', getBackendExecutable('OrderRobotAiBackend'), [], {
      env: { ...sharedEnv, PORT: String(AI_PORT) },
    });
  } else {
    startManagedProcess('ai', 'python', ['services/ai-backend/run_server.py'], {
      env: { ...sharedEnv, PORT: String(AI_PORT) },
    });
  }

  await setLoadingStatus('Dang doi backend san sang...');
  await waitForHealth(`http://${HOST}:${CORE_PORT}/health`, 60000);
  await waitForHealth(`http://${HOST}:${AI_PORT}/health`, 180000);

  await setLoadingStatus('Dang mo giao dien kiosk...');
  await mainWindow.loadURL(uiServer.url);
}

async function shutdownAll() {
  if (uiServer?.server) {
    await new Promise((resolve) => uiServer.server.close(resolve));
    uiServer = null;
  }
  while (managedChildren.length > 0) {
    const child = managedChildren.pop();
    if (!child || child.killed) {
      continue;
    }
    try {
      child.kill();
    } catch {
      // Ignore child shutdown failures.
    }
  }
}

function registerDesktopIpc() {
  ipcMain.handle('orderrobot:get-login-config', async () => {
    return runtimeLoginConfig;
  });

  ipcMain.handle('orderrobot:login', async (_event, payload) => {
    const username = String(payload?.username || '').trim();
    const password = String(payload?.password || '');
    const loginUrl = String(runtimeLoginConfig?.loginUrl || '').trim();
    if (!loginUrl) {
      throw new Error('Chua cau hinh POS_AUTH_LOGIN_URL.');
    }
    if (!username || !password) {
      throw new Error('Vui long nhap day du tai khoan va mat khau.');
    }

    const tokenPayload = await authenticateLogin({ loginUrl, username, password });
    if (!startupPromise) {
      startupPromise = (async () => {
        try {
          await mainWindow.loadURL(
            `data:text/html;charset=utf-8,${encodeURIComponent(
              createLoadingHtml('Dang xac thuc va khoi dong kiosk...'),
            )}`,
          );
          await bootstrapDesktop({
            username,
            password,
            accessToken: tokenPayload.accessToken,
            refreshToken: tokenPayload.refreshToken,
          });
        } catch (error) {
          startupPromise = null;
          await shutdownAll();
          await loadLoginScreen();
          throw error;
        }
      })();
    }

    await startupPromise;
    return { ok: true };
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async () => {
  await shutdownAll();
});

await app.whenReady();
writeBootstrapLog('info', 'app-whenReady-completed');
desktopLogFilePath = path.join(app.getPath('userData'), 'logs', 'desktop-runtime.log');
writeDesktopLog('info', 'app-ready', { userData: app.getPath('userData'), appPath: getAppRoot() });
writeBootstrapLog('info', 'desktopLogFilePath-set', desktopLogFilePath);
configurePermissions();
writeBootstrapLog('info', 'permissions-configured');
createMainWindow();
writeBootstrapLog('info', 'mainWindow-created');
registerDesktopIpc();
writeBootstrapLog('info', 'ipc-registered');

try {
  writeBootstrapLog('info', 'starting-runtime-setup');
  runtimeRootDir = path.join(app.getPath('userData'), 'runtime');
  writeDesktopLog('info', 'runtime-root', runtimeRootDir);
  writeBootstrapLog('info', 'runtime-root-set', runtimeRootDir);
  await seedRuntimeFiles(runtimeRootDir);
  writeBootstrapLog('info', 'runtime-files-seeded');
  runtimeLoginConfig = resolveLoginConfig(await readRuntimeEnv(runtimeRootDir));
  writeDesktopLog('info', 'runtime-login-config', runtimeLoginConfig);
  writeBootstrapLog('info', 'login-config-resolved', runtimeLoginConfig);
  await loadLoginScreen();
  writeBootstrapLog('info', 'login-screen-loaded');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeDesktopLog('error', 'desktop-bootstrap-failed', {
    message,
    stack: error instanceof Error ? error.stack || '' : '',
  });
  writeBootstrapLog('error', 'desktop-bootstrap-failed', {
    message,
    stack: error instanceof Error ? error.stack || '' : '',
  });
  
  // Force show window before showing error
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
  }
  
  dialog.showErrorBox('OrderRobot khong khoi dong duoc', message);
  await shutdownAll();
  app.quit();
}

process.on('uncaughtException', (error) => {
  writeDesktopLog('error', 'uncaught-exception', {
    message: error?.message || String(error),
    stack: error?.stack || '',
  });
  try {
    dialog.showErrorBox('OrderRobot gap loi', error?.message || String(error));
  } catch {}
});

process.on('unhandledRejection', (reason) => {
  writeDesktopLog('error', 'unhandled-rejection', reason);
  try {
    dialog.showErrorBox('OrderRobot gap loi', typeof reason === 'string' ? reason : JSON.stringify(reason));
  } catch {}
});
