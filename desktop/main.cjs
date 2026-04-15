const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const electron = require('electron');

const { app, dialog } = electron;
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
} catch {}

writeBootstrapLog('info', 'main-cjs-entry');

(async () => {
  try {
    const entryUrl = pathToFileURL(path.join(__dirname, 'main.mjs')).href;
    writeBootstrapLog('info', 'main-cjs-importing', entryUrl);
    await import(entryUrl);
    writeBootstrapLog('info', 'main-cjs-imported');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeBootstrapLog('error', 'main-cjs-import-failed', {
      message,
      stack: error instanceof Error ? error.stack || '' : '',
    });
    try {
      dialog.showErrorBox('OrderRobot gap loi khoi dong', message);
    } catch {}
    app.exit(1);
  }
})();
