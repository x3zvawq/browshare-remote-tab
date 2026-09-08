import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('./compatibility.json', import.meta.url), 'utf8'))
const failures = []

if (manifest.schemaVersion !== 1) failures.push('schemaVersion must be 1')

const dockerfile = await readFile(new URL('docker/Dockerfile', import.meta.url), 'utf8')
if (!dockerfile.includes(manifest.node.baseImage)) {
  failures.push(`docker/Dockerfile does not pin Node base image ${manifest.node.baseImage}`)
}

const chromeEntrypoint = await readFile(
  new URL('docker/chrome-node-entrypoint.sh', import.meta.url),
  'utf8',
)
if (chromeEntrypoint.includes('--no-sandbox')) {
  failures.push('Chrome node must not disable the Google Chrome sandbox')
}
if (!chromeEntrypoint.includes('--enable-extensions')) {
  failures.push('Chrome node must explicitly enable the policy-installed Extension')
}

const seccompBytes = await readFile(new URL('../' + manifest.container.seccompProfile, import.meta.url))
const seccompHash = createHash('sha256').update(seccompBytes).digest('hex')
if (seccompHash !== manifest.container.seccompProfileSha256) {
  failures.push(
    `Chrome seccomp profile SHA-256 is ${seccompHash}, expected ${manifest.container.seccompProfileSha256}`,
  )
}
const seccomp = JSON.parse(seccompBytes.toString('utf8'))
if (seccomp.defaultAction !== 'SCMP_ACT_ERRNO') {
  failures.push('Chrome seccomp profile must remain deny-by-default')
}
for (const syscall of manifest.container.chromeNamespaceSyscalls) {
  const matchingRules = seccomp.syscalls.filter((rule) => rule.names.includes(syscall))
  if (
    matchingRules.length !== 1 ||
    matchingRules[0].action !== 'SCMP_ACT_ALLOW' ||
    matchingRules[0].args !== undefined ||
    matchingRules[0].includes !== undefined ||
    matchingRules[0].excludes !== undefined
  ) {
    failures.push(`Chrome namespace syscall ${syscall} must have one unconditional allow rule`)
  }
}

const chromeSources = [
  'docker/Dockerfile',
  'compose/compose.all-in-one.yml',
  'compose/compose.chrome-node.yml',
]
for (const relativePath of chromeSources) {
  const source = relativePath === 'docker/Dockerfile'
    ? dockerfile
    : await readFile(new URL(relativePath, import.meta.url), 'utf8')
  for (const [name, value] of [
    ['Chrome package version', manifest.chrome.packageVersion],
    ['Chrome .deb URL', manifest.chrome.debUrl],
    ['Chrome .deb SHA-256', manifest.chrome.debSha256],
  ]) {
    if (!source.includes(value)) failures.push(`${relativePath} does not pin ${name} ${value}`)
  }
  if (relativePath.startsWith('compose/') && !source.includes('seccomp=')) {
    failures.push(`${relativePath} does not load the Chrome seccomp profile`)
  }
}

const extensionManifest = JSON.parse(
  await readFile(new URL('../packages/extension/extension/manifest.json', import.meta.url), 'utf8'),
)
if (extensionManifest.version !== manifest.extension.version) {
  failures.push(
    `Extension manifest is ${extensionManifest.version}, expected ${manifest.extension.version}`,
  )
}

const protocolSource = await readFile(
  new URL('../packages/protocol/src/version.ts', import.meta.url),
  'utf8',
)
const protocolPattern = new RegExp(
  `PROTOCOL_VERSION\\s*=\\s*Object\\.freeze\\(\\{\\s*major:\\s*${manifest.protocol.major},\\s*minor:\\s*${manifest.protocol.minor}\\s*\\}\\)`,
  'u',
)
if (!protocolPattern.test(protocolSource)) {
  failures.push(
    `Protocol source does not declare ${manifest.protocol.major}.${manifest.protocol.minor}`,
  )
}

const coordinatedPackages = [
  '../package.json',
  '../apps/signaling/package.json',
  '../apps/standalone/package.json',
  '../examples/embed/package.json',
  '../packages/core/package.json',
  '../packages/extension/package.json',
  '../packages/headless-client/package.json',
  '../packages/protocol/package.json',
  '../packages/viewer/package.json',
  '../tools/extension-signing/package.json',
]
for (const relativePath of coordinatedPackages) {
  const packageJson = JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'))
  if (packageJson.version !== manifest.releaseVersion) {
    failures.push(
      `${packageJson.name ?? relativePath} is ${packageJson.version}, expected ${manifest.releaseVersion}`,
    )
  }
}

const coordinatedVersionSources = [
  ['Core', '../packages/core/src/version.ts', 'REMOTE_TAB_CORE_VERSION'],
  ['Standalone', '../apps/standalone/src/version.ts', 'REMOTE_TAB_STANDALONE_VERSION'],
  ['Headless Client', '../packages/headless-client/src/remote-tab-client.ts', 'CLIENT_VERSION'],
]
for (const [name, relativePath, identifier] of coordinatedVersionSources) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8')
  const pattern = new RegExp(
    `${identifier}\\s*=\\s*['\"]${escapeRegExp(manifest.releaseVersion)}['\"]`,
    'u',
  )
  if (!pattern.test(source)) {
    failures.push(`${name} source does not embed release version ${manifest.releaseVersion}`)
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
        node: manifest.node.runtimeVersion,
        chrome: manifest.chrome.product,
        extension: manifest.extension.version,
        seccompProfile: manifest.container.seccompProfile,
        protocol: manifest.protocol,
        coordinatedPackages: coordinatedPackages.length,
        coordinatedVersionSources: coordinatedVersionSources.length,
      },
      null,
      2,
    )}\n`,
  )
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
