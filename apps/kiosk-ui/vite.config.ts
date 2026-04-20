import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

function toLoopbackUrl(port: string): string {
  return `http://127.0.0.1:${port}`
}

function resolveViteHost(value: string | undefined): true | string {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return '127.0.0.1'
  if (raw === 'true' || raw === 'all' || raw === '0.0.0.0') return true
  return String(value || '').trim()
}

const viteConfigDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(viteConfigDir, '../..')
const devRuntimeDir = path.join(repoRoot, 'data', 'dev-runtime')
const corePortFile = path.join(devRuntimeDir, 'core-port.txt')
const aiPortFile = path.join(devRuntimeDir, 'ai-port.txt')

function readRuntimePort(portFile: string): string | null {
  try {
    const raw = fs.readFileSync(portFile, 'utf8').trim()
    return raw || null
  } catch {
    return null
  }
}

function isLoopbackPortListening(port: string): boolean {
  const safePort = String(port || '').trim()
  if (!safePort) return false
  try {
    const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const pattern = new RegExp(`^\\s*TCP\\s+127\\.0\\.0\\.1:${safePort}\\s+\\S+\\s+LISTENING\\s+\\d+\\s*$`, 'm')
    return pattern.test(output)
  } catch {
    return false
  }
}

function toProxyTarget(portFile: string, configuredPort: string, fallbackPorts: string[]): string {
  const runtimePort = readRuntimePort(portFile)
  if (runtimePort && isLoopbackPortListening(runtimePort)) {
    return toLoopbackUrl(runtimePort)
  }
  if (isLoopbackPortListening(configuredPort)) {
    return toLoopbackUrl(configuredPort)
  }
  for (const fallbackPort of fallbackPorts) {
    if (isLoopbackPortListening(fallbackPort)) {
      return toLoopbackUrl(fallbackPort)
    }
  }
  return toLoopbackUrl(configuredPort || fallbackPorts[0] || '8011')
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, path.resolve(viteConfigDir, '../..'), '')
  const configuredCorePort = String(rootEnv.CORE_BACKEND_PORT || process.env.CORE_BACKEND_PORT || '8011').trim() || '8011'
  const configuredAiPort = String(rootEnv.AI_BACKEND_PORT || process.env.AI_BACKEND_PORT || '8012').trim() || '8012'
  const coreFallbackPorts = ['18011', '18013', '18014', '18015', '18016']
  const aiFallbackPorts = ['18012', '18013', '18014', '18015', '18016']
  const viteHost = rootEnv.VITE_DEV_HOST || rootEnv.DEV_BIND_HOST || process.env.VITE_DEV_HOST || process.env.DEV_BIND_HOST
  const allowedHosts = ['frontend', 'orderrobot-ui', 'localhost', 'cnxvn.ddns.net']

  return {
    // Read env from monorepo root so Admin fallback uses the same .env as backends.
    envDir: '../..',      
    plugins: [react()],
    server: {
      host: resolveViteHost(viteHost),
      allowedHosts,
      proxy: {
        '/api/core': {
          target: toProxyTarget(corePortFile, configuredCorePort, coreFallbackPorts),
          changeOrigin: true,
          ws: true,
          rewrite: (requestPath) => requestPath.replace(/^\/api\/core/, ''),
          router: () => toProxyTarget(corePortFile, configuredCorePort, coreFallbackPorts),
        },
        '/api/ai': {
          target: toProxyTarget(aiPortFile, configuredAiPort, aiFallbackPorts),
          changeOrigin: true,
          ws: true,
          rewrite: (requestPath) => requestPath.replace(/^\/api\/ai/, ''),
          router: () => toProxyTarget(aiPortFile, configuredAiPort, aiFallbackPorts),
        },
        '/menu': {
          target: toProxyTarget(corePortFile, configuredCorePort, coreFallbackPorts),
          changeOrigin: true,
          router: () => toProxyTarget(corePortFile, configuredCorePort, coreFallbackPorts),
        },
        '/orders': {
          target: toProxyTarget(corePortFile, configuredCorePort, coreFallbackPorts),
          changeOrigin: true,
          router: () => toProxyTarget(corePortFile, configuredCorePort, coreFallbackPorts),
        },
        '/health': {
          target: toProxyTarget(corePortFile, configuredCorePort, coreFallbackPorts),
          changeOrigin: true,
          router: () => toProxyTarget(corePortFile, configuredCorePort, coreFallbackPorts),
        },
        '/api/pos': {
          target: 'http://cnxvn.ddns.net:8080',
          changeOrigin: true,
          rewrite: (requestPath) => requestPath.replace(/^\/api\/pos/, '/api/v1'),
        },
      },
    },
    preview: {
      host: resolveViteHost(viteHost),
      allowedHosts,
    },
  }
})
