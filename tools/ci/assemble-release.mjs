import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'

const workspace = resolve(fileOption('--workspace') ?? process.cwd())
const source = resolve(workspace, fileOption('--source') ?? 'tmp/ci-artifacts')
const extension = resolve(workspace, fileOption('--extension') ?? 'tmp/extension-release')
const output = resolve(workspace, fileOption('--out') ?? 'tmp/release-assets')
assertTemporaryChild(source, 'Source artifact input')
assertTemporaryChild(extension, 'Extension release input')
assertTemporaryChild(output, 'Release output')

await verifyChecksums(source, 'SHA256SUMS')
await verifyChecksums(extension, 'extension-SHA256SUMS')

const compatibility = JSON.parse(await readFile(resolve(source, 'compatibility.json'), 'utf8'))
const extensionMetadata = JSON.parse(await readFile(resolve(extension, 'extension-release.json'), 'utf8'))
if (extensionMetadata.releaseVersion !== compatibility.releaseVersion) {
  throw new Error('Extension release version does not match the source compatibility manifest')
}
if (extensionMetadata.extensionVersion !== compatibility.extension.version) {
  throw new Error('Extension artifact version does not match the source compatibility manifest')
}

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })

const sourceAssets = [
  'artifact-index.json',
  'build-record.intoto.json',
  'compatibility.json',
  'dependency-licenses.json',
  'LICENSE',
  'sbom-source.cdx.json',
  'sbom-source.spdx.json',
  'THIRD_PARTY_NOTICES.md',
]
for (const name of sourceAssets) await copyFile(resolve(source, name), name)

const npmDirectory = resolve(source, 'npm')
const npmTarballs = (await readdir(npmDirectory))
  .filter((name) => name.endsWith('.tgz'))
  .sort((left, right) => left.localeCompare(right))
if (npmTarballs.length !== 6) {
  throw new Error(`Expected 6 public npm tarballs, found ${npmTarballs.length}`)
}
for (const name of npmTarballs) await copyFile(resolve(npmDirectory, name), name)

const extensionAssets = (await readdir(extension))
  .filter((name) => name !== 'extension-SHA256SUMS')
  .sort((left, right) => left.localeCompare(right))
for (const name of extensionAssets) await copyFile(resolve(extension, name), name)

await copyFile(resolve(workspace, 'CHANGELOG.md'), 'CHANGELOG.md')
await copyFile(
  resolve(workspace, 'docs/design/08-testing.md'),
  'testing-and-compatibility.md',
)
await copyFile(
  resolve(workspace, 'docs/design/21-release-candidate-security-review.md'),
  'release-candidate-security-review.md',
)

const files = await collectOutputFiles()
const releaseManifest = {
  schemaVersion: 1,
  releaseVersion: compatibility.releaseVersion,
  compatibility,
  extensionId: extensionMetadata.extensionId,
  files,
}
await writeFile(resolve(output, 'release-manifest.json'), `${JSON.stringify(releaseManifest, null, 2)}\n`)

const checksumFiles = [...files.map((file) => file.name), 'release-manifest.json']
  .sort((left, right) => left.localeCompare(right))
const checksumLines = []
for (const name of checksumFiles) {
  checksumLines.push(`${digest(await readFile(resolve(output, name)))}  ${name}`)
}
await writeFile(resolve(output, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`)
await verifyChecksums(output, 'SHA256SUMS')

process.stdout.write(
  `${JSON.stringify(
    {
      status: 'passed',
      output,
      releaseVersion: compatibility.releaseVersion,
      extensionId: extensionMetadata.extensionId,
      assets: checksumFiles.length,
      npmTarballs: npmTarballs.length,
    },
    null,
    2,
  )}\n`,
)

async function copyFile(sourcePath, destinationName) {
  const metadata = await stat(sourcePath)
  if (!metadata.isFile()) throw new TypeError(`Release input is not a file: ${sourcePath}`)
  if (basename(destinationName) !== destinationName) {
    throw new TypeError(`Release destination must be a basename: ${destinationName}`)
  }
  await cp(sourcePath, resolve(output, destinationName))
}

async function collectOutputFiles() {
  const names = (await readdir(output)).sort((left, right) => left.localeCompare(right))
  const files = []
  for (const name of names) {
    const path = resolve(output, name)
    const metadata = await stat(path)
    if (!metadata.isFile()) throw new TypeError(`Release output contains a non-file: ${name}`)
    const bytes = await readFile(path)
    files.push({ name, bytes: metadata.size, sha256: digest(bytes) })
  }
  return files
}

async function verifyChecksums(directory, checksumName) {
  const lines = (await readFile(resolve(directory, checksumName), 'utf8')).trim().split('\n')
  if (lines.length === 0) throw new TypeError(`${checksumName} is empty`)
  const seen = new Set()
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^/]+(?:\/[^/]+)*)$/u.exec(line)
    if (!match) throw new TypeError(`Invalid ${checksumName} line: ${line}`)
    const [, expected, name] = match
    if (seen.has(name)) throw new TypeError(`Duplicate checksum path: ${name}`)
    seen.add(name)
    const path = resolve(directory, name)
    const pathRelative = relative(directory, path)
    if (pathRelative.startsWith('..') || isAbsolute(pathRelative)) {
      throw new TypeError(`Checksum path escapes its directory: ${name}`)
    }
    const actual = digest(await readFile(path))
    if (actual !== expected) throw new Error(`Checksum mismatch for ${name}`)
  }
}

function assertTemporaryChild(path, label) {
  const temporaryRoot = resolve(workspace, 'tmp')
  const pathRelative = relative(temporaryRoot, path)
  if (pathRelative === '' || pathRelative.startsWith('..') || isAbsolute(pathRelative)) {
    throw new TypeError(`${label} must be a child of the workspace tmp directory`)
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
