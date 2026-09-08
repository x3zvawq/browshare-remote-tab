import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'

const workspace = resolve(fileOption('--workspace') ?? process.cwd())
const output = resolve(workspace, fileOption('--out') ?? 'tmp/extension-release')
assertTemporaryChild(output)

const signingResultPath = resolve(workspace, requiredOption('--signing-result'))
const manifestPath = resolve(workspace, fileOption('--manifest') ?? 'deploy/compatibility.json')
const expectedExtensionId = fileOption('--expected-extension-id')
const signing = JSON.parse(await readFile(signingResultPath, 'utf8'))
const compatibility = JSON.parse(await readFile(manifestPath, 'utf8'))

if (!/^[a-p]{32}$/u.test(signing.extensionId)) {
  throw new TypeError('Signing result contains an invalid Extension ID')
}
if (expectedExtensionId !== undefined && signing.extensionId !== expectedExtensionId) {
  throw new Error(`Signed Extension ID is ${signing.extensionId}, expected ${expectedExtensionId}`)
}

const inputs = [
  ['crx', signing.crxPath],
  ['updateManifest', signing.updateManifestPath],
  ['managedPolicy', signing.managedPolicyPath],
]
for (const [name, path] of inputs) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError(`Signing result has no ${name} path`)
  }
}

const crx = await readFile(signing.crxPath)
if (crx.subarray(0, 4).toString('ascii') !== 'Cr24' || crx.readUInt32LE(4) !== 3) {
  throw new TypeError('Signed Extension is not a CRX3 artifact')
}
const crxDigest = digest(crx)
if (crxDigest !== signing.sha256) throw new Error('Signing result CRX digest does not match its bytes')

const updateManifest = await readFile(signing.updateManifestPath, 'utf8')
const crxName = basename(signing.crxPath)
if (
  !updateManifest.includes(`appid="${signing.extensionId}"`) ||
  !updateManifest.includes(`version="${compatibility.extension.version}"`) ||
  !updateManifest.includes(crxName)
) {
  throw new Error('Update manifest does not bind the expected ID, version and CRX')
}

const managedPolicy = JSON.parse(await readFile(signing.managedPolicyPath, 'utf8'))
if (managedPolicy.ExtensionSettings?.[signing.extensionId]?.installation_mode !== 'force_installed') {
  throw new Error('Managed policy does not force-install the signed Extension ID')
}
if (!managedPolicy['3rdparty']?.extensions?.[signing.extensionId]) {
  throw new Error('Managed policy does not contain runtime configuration for the signed Extension ID')
}

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
for (const [, source] of inputs) await cp(source, resolve(output, basename(source)))

const assets = []
for (const [, source] of inputs) {
  const name = basename(source)
  const bytes = await readFile(resolve(output, name))
  assets.push({ name, bytes: bytes.byteLength, sha256: digest(bytes) })
}
assets.sort((left, right) => left.name.localeCompare(right.name))

const metadata = {
  schemaVersion: 1,
  releaseVersion: compatibility.releaseVersion,
  extensionVersion: compatibility.extension.version,
  extensionId: signing.extensionId,
  protocol: compatibility.protocol,
  assets,
}
await writeFile(resolve(output, 'extension-release.json'), `${JSON.stringify(metadata, null, 2)}\n`)
await writeChecksums(output, 'extension-SHA256SUMS')

process.stdout.write(
  `${JSON.stringify(
    {
      status: 'passed',
      output,
      releaseVersion: compatibility.releaseVersion,
      extensionVersion: compatibility.extension.version,
      extensionId: signing.extensionId,
      assets: assets.length + 1,
    },
    null,
    2,
  )}\n`,
)

async function writeChecksums(directory, checksumName) {
  const names = [
    ...inputs.map(([, source]) => basename(source)),
    'extension-release.json',
  ].sort((left, right) => left.localeCompare(right))
  const lines = []
  for (const name of names) {
    const path = resolve(directory, name)
    const metadata = await stat(path)
    if (!metadata.isFile()) throw new TypeError(`Extension release asset is not a file: ${name}`)
    lines.push(`${digest(await readFile(path))}  ${name}`)
  }
  await writeFile(resolve(directory, checksumName), `${lines.join('\n')}\n`)
}

function assertTemporaryChild(path) {
  const temporaryRoot = resolve(workspace, 'tmp')
  const pathRelative = relative(temporaryRoot, path)
  if (pathRelative === '' || pathRelative.startsWith('..') || isAbsolute(pathRelative)) {
    throw new TypeError('Extension release output must be a child of the workspace tmp directory')
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fileOption(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new TypeError(`Missing value for ${name}`)
  return value
}

function requiredOption(name) {
  const value = fileOption(name)
  if (value === undefined) throw new TypeError(`Missing required option ${name}`)
  return value
}

