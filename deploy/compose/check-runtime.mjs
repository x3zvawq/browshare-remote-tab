import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const arguments_ = process.argv.slice(2)
const manifestPath =
  option('--manifest') ?? fileURLToPath(new URL('../compatibility.json', import.meta.url))
const baseUrl = option('--base-url') ?? 'http://127.0.0.1:9230'
const apiToken = process.env.BROWSHARE_REMOTE_TAB_API_TOKEN

if (!apiToken) throw new Error('BROWSHARE_REMOTE_TAB_API_TOKEN is required')

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
validateManifest(manifest)
const headers = { authorization: `Bearer ${apiToken}` }

const readiness = await request('/health/ready')
const diagnostics = await request('/v1/diagnostics/capabilities', headers)
const sessions = await request('/v1/sessions', headers)

const failures = []
if (readiness.status !== 'ready' || diagnostics.status !== 'ready') {
  failures.push('runtime is not ready')
}
if (sessions.sessions.length !== 0) failures.push(`${sessions.sessions.length} Session(s) are still active`)
if (diagnostics.versions.chrome.product !== manifest.chrome.product) {
  failures.push(
    `Chrome is ${diagnostics.versions.chrome.product}, expected ${manifest.chrome.product}`,
  )
}
if (diagnostics.versions.extension.serviceWorkerVersion !== manifest.extension.version) {
  failures.push(
    `Extension service worker is ${diagnostics.versions.extension.serviceWorkerVersion}, expected ${manifest.extension.version}`,
  )
}
if (diagnostics.versions.extension.mediaVersion !== manifest.extension.version) {
  failures.push(
    `Extension media role is ${diagnostics.versions.extension.mediaVersion}, expected ${manifest.extension.version}`,
  )
}
if (diagnostics.versions.extension.coherent !== true) failures.push('Extension roles are not coherent')
if (
  diagnostics.versions.controlProtocol.major !== manifest.protocol.major ||
  diagnostics.versions.controlProtocol.minor !== manifest.protocol.minor
) {
  failures.push(
    `control protocol is ${JSON.stringify(diagnostics.versions.controlProtocol)}, expected ${JSON.stringify(manifest.protocol)}`,
  )
}
if (manifest.releaseVersion !== '0.0.0') {
  if (diagnostics.versions.core !== manifest.releaseVersion) {
    failures.push(`Core is ${diagnostics.versions.core}, expected ${manifest.releaseVersion}`)
  }
  if (diagnostics.versions.standalone !== manifest.releaseVersion) {
    failures.push(`Standalone is ${diagnostics.versions.standalone}, expected ${manifest.releaseVersion}`)
  }
}

if (failures.length > 0) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', failures }, null, 2)}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'passed',
        releaseVersion: manifest.releaseVersion,
        chrome: diagnostics.versions.chrome.product,
        extension: manifest.extension.version,
        protocol: diagnostics.versions.controlProtocol,
        checks: diagnostics.checks,
        activeSessions: 0,
      },
      null,
      2,
    )}\n`,
  )
}

async function request(path, requestHeaders = undefined) {
  const response = await fetch(new URL(path, baseUrl), { headers: requestHeaders })
  const body = await response.json()
  if (!response.ok) {
    throw new Error(`GET ${path} returned ${response.status}: ${JSON.stringify(body)}`)
  }
  return body
}

function option(name) {
  const index = arguments_.indexOf(name)
  if (index === -1) return undefined
  const value = arguments_[index + 1]
  if (!value || value.startsWith('--')) throw new TypeError(`Missing value for ${name}`)
  return value
}

function validateManifest(value) {
  if (
    value?.schemaVersion !== 1 ||
    typeof value.releaseVersion !== 'string' ||
    typeof value.chrome?.product !== 'string' ||
    typeof value.extension?.version !== 'string' ||
    !Number.isInteger(value.protocol?.major) ||
    !Number.isInteger(value.protocol?.minor)
  ) {
    throw new TypeError('Compatibility manifest is invalid')
  }
}
