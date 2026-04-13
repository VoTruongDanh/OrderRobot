import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const targetPath = path.join(
  repoRoot,
  'node_modules',
  'app-builder-lib',
  'out',
  'targets',
  'nsis',
  'NsisTarget.js',
);

if (!fs.existsSync(targetPath)) {
  console.error(`[patch-electron-builder-nsis] Target not found: ${targetPath}`);
  process.exit(1);
}

const source = fs.readFileSync(targetPath, 'utf8');
const needle = `        else {\n            await (0, wine_1.execWine)(installerPath, null, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } });\n        }\n`;
const replacement = `        else {\n            try {\n                await nsisUtil_1.UninstallerReader.exec(installerPath, uninstallerPath);\n            }\n            catch (error) {\n                builder_util_1.log.warn(\`fallback to execWine for uninstaller extraction: \${error.message}\`);\n                await (0, wine_1.execWine)(installerPath, null, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } });\n            }\n        }\n`;

if (source.includes(replacement)) {
  console.log('[patch-electron-builder-nsis] Patch already applied.');
  process.exit(0);
}

if (!source.includes(needle)) {
  console.error('[patch-electron-builder-nsis] Expected code block not found. electron-builder version may have changed.');
  process.exit(1);
}

fs.writeFileSync(targetPath, source.replace(needle, replacement), 'utf8');
console.log('[patch-electron-builder-nsis] Patch applied successfully.');
