import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const modelsDir = path.join(rootDir, 'public', 'robot-models')
const manifestPath = path.join(modelsDir, 'manifest.json')
const blenderConvertScriptPath = path.join(rootDir, 'scripts', 'blender-convert-to-glb.py')
const CONVERTIBLE_EXTENSIONS = new Set(['.blend', '.fbx', '.obj'])

function toTitle(input) {
  return input
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase())
}

function normalizeId(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

function isWindows() {
  return process.platform === 'win32'
}

function getCommonBlenderPaths() {
  if (!isWindows()) return []
  const candidates = [
    process.env.BLENDER_PATH || '',
    'C:\\Program Files\\Blender Foundation\\Blender\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.1\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.0\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 3.6\\blender.exe',
  ]
  return candidates.map((item) => String(item || '').trim()).filter(Boolean)
}

function findBlenderExecutable() {
  const envPath = String(process.env.BLENDER_PATH || '').trim()
  if (envPath && fileExists(envPath)) return envPath

  for (const candidate of getCommonBlenderPaths()) {
    if (fileExists(candidate)) return candidate
  }

  const command = isWindows() ? 'where' : 'which'
  const probe = spawnSync(command, ['blender'], { encoding: 'utf8' })
  if (probe.status === 0) {
    const first = String(probe.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    if (first && fileExists(first)) return first
  }
  return ''
}

function runPowerShell(scriptText) {
  return spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', scriptText],
    { encoding: 'utf8' },
  )
}

function collectFilesByExtension(dirPath, extensions) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  const collected = []
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      collected.push(...collectFilesByExtension(fullPath, extensions))
      continue
    }
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (!extensions.has(ext)) continue
    collected.push(fullPath)
  }
  return collected
}

function extractZipArchives() {
  const zips = collectFilesByExtension(modelsDir, new Set(['.zip']))
  if (zips.length === 0) return { extracted: 0, skipped: 0, failed: 0 }

  if (!isWindows()) {
    return { extracted: 0, skipped: zips.length, failed: 0 }
  }

  let extracted = 0
  let skipped = 0
  let failed = 0

  for (const zipPath of zips) {
    const baseName = path.basename(zipPath, '.zip')
    const destination = path.join(path.dirname(zipPath), baseName)
    if (!fs.existsSync(destination)) {
      fs.mkdirSync(destination, { recursive: true })
    }
    const scriptText = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`
    const result = runPowerShell(scriptText)
    if (result.status === 0) {
      extracted += 1
    } else {
      failed += 1
      console.warn(`[robot-models] failed to extract zip: ${zipPath}`)
      if (result.stderr) {
        console.warn(String(result.stderr).trim())
      }
    }
  }

  return { extracted, skipped, failed }
}

function shouldConvertSourceToGlb(sourcePath, targetGlbPath) {
  if (!fileExists(targetGlbPath)) return true
  const sourceStat = fs.statSync(sourcePath)
  const targetStat = fs.statSync(targetGlbPath)
  return sourceStat.mtimeMs > targetStat.mtimeMs
}

function convertSourcesToGlb() {
  const blenderExe = findBlenderExecutable()
  const sources = collectFilesByExtension(modelsDir, CONVERTIBLE_EXTENSIONS)

  if (!blenderExe) {
    return {
      converted: 0,
      skipped: sources.length,
      failed: 0,
      blenderFound: false,
      blenderExe: '',
    }
  }

  let converted = 0
  let skipped = 0
  let failed = 0

  for (const sourcePath of sources) {
    const targetGlbPath = sourcePath.replace(/\.[^.]+$/i, '.glb')
    if (!shouldConvertSourceToGlb(sourcePath, targetGlbPath)) {
      skipped += 1
      continue
    }
    const result = spawnSync(
      blenderExe,
      [
        '--background',
        '--python',
        blenderConvertScriptPath,
        '--',
        sourcePath,
        targetGlbPath,
      ],
      { encoding: 'utf8' },
    )
    if (result.status === 0 && fileExists(targetGlbPath)) {
      converted += 1
    } else {
      failed += 1
      console.warn(`[robot-models] failed to convert: ${sourcePath}`)
      if (result.stderr) {
        console.warn(String(result.stderr).trim())
      }
    }
  }

  return {
    converted,
    skipped,
    failed,
    blenderFound: true,
    blenderExe,
  }
}

if (!fs.existsSync(modelsDir)) {
  fs.mkdirSync(modelsDir, { recursive: true })
}

const zipSummary = extractZipArchives()
const conversionSummary = convertSourcesToGlb()
const files = collectFilesByExtension(modelsDir, new Set(['.glb', '.gltf'])).sort((a, b) => a.localeCompare(b))

const models = files.map((fullPath) => {
  const ext = path.extname(fullPath).toLowerCase()
  const stem = path.basename(fullPath, ext)
  const relPath = path.relative(modelsDir, fullPath).replaceAll('\\', '/')
  return {
    id: normalizeId(relPath.replace(/\.(glb|gltf)$/i, '')),
    name: toTitle(stem),
    path: `/robot-models/${relPath}`,
    format: ext.slice(1),
  }
})

const output = {
  generated_at: new Date().toISOString(),
  models,
}

fs.writeFileSync(manifestPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
console.log(`robot-model manifest updated: ${manifestPath} (${models.length} model(s))`)
console.log(
  `[robot-models] zip extracted=${zipSummary.extracted} skipped=${zipSummary.skipped} failed=${zipSummary.failed}` +
    ` | converted=${conversionSummary.converted} skipped=${conversionSummary.skipped} failed=${conversionSummary.failed}` +
    ` | blender=${conversionSummary.blenderFound ? conversionSummary.blenderExe : 'not-found'}`,
)

if (!conversionSummary.blenderFound) {
  console.log('[robot-models] tip: set BLENDER_PATH to enable auto-convert for .blend/.fbx/.obj')
}
