import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'

import { zipSync, type Zippable } from 'fflate'

export interface ExtensionSigningInput {
  sourceDirectory: string
  privateKeyPath: string
  outputDirectory: string
  updateBaseUrl: string
}

export interface ExtensionSigningArtifacts {
  extensionId: string
  crxPath: string
  updateManifestPath: string
  managedPolicyPath: string
  sha256: string
}

export interface ManagedPolicyTemplateInput {
  extensionId: string
  updateManifestUrl: string
  loopbackUrl: string
  runtimeSecret: string
  runtimeGeneration: string
}

export async function generateExtensionPrivateKey(path: string): Promise<void> {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, privateKey, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}

export async function signExtension(input: ExtensionSigningInput): Promise<ExtensionSigningArtifacts> {
  const sourceDirectory = resolve(input.sourceDirectory)
  const outputDirectory = resolve(input.outputDirectory)
  const manifest = parseManifest(await readFile(join(sourceDirectory, 'manifest.json'), 'utf8'))
  const files = await collectFiles(sourceDirectory)
  assertRemoteTabArtifact(files, manifest.serviceWorker)
  const privateKey = createPrivateKey(await readFile(resolve(input.privateKeyPath)))
  if (privateKey.asymmetricKeyType !== 'rsa' && privateKey.asymmetricKeyType !== 'rsa-pss') {
    throw new TypeError('Chrome Extension private key must be RSA')
  }
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const extensionIdBytes = createHash('sha256').update(publicKey).digest().subarray(0, 16)
  const extensionId = encodeExtensionId(extensionIdBytes)
  const zip = Buffer.from(zipSync(files, {
    level: 9,
    mtime: new Date('1980-01-01T00:00:00Z'),
  }))
  const signedHeaderData = encodeLengthDelimited(1, extensionIdBytes)
  const signatureInput = Buffer.concat([
    Buffer.from('CRX3 SignedData\0', 'ascii'),
    uint32(signedHeaderData.byteLength),
    signedHeaderData,
    zip,
  ])
  const signature = sign('sha256', signatureInput, privateKey)
  const proof = Buffer.concat([
    encodeLengthDelimited(1, publicKey),
    encodeLengthDelimited(2, signature),
  ])
  const header = Buffer.concat([
    encodeLengthDelimited(2, proof),
    encodeLengthDelimited(10_000, signedHeaderData),
  ])
  const crx = Buffer.concat([
    Buffer.from('Cr24'),
    uint32(3),
    uint32(header.byteLength),
    header,
    zip,
  ])

  const baseUrl = normalizeBaseUrl(input.updateBaseUrl)
  const crxName = `browshare-remote-tab-${manifest.version}.crx`
  const crxUrl = new URL(crxName, baseUrl).toString()
  const updateManifestUrl = new URL('updates.xml', baseUrl).toString()
  const crxPath = join(outputDirectory, crxName)
  const updateManifestPath = join(outputDirectory, 'updates.xml')
  const managedPolicyPath = join(outputDirectory, 'managed-policy.example.json')
  await mkdir(outputDirectory, { recursive: true })
  await Promise.all([
    writeFile(crxPath, crx),
    writeFile(
      updateManifestPath,
      `<?xml version="1.0" encoding="UTF-8"?>\n<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">\n  <app appid="${extensionId}">\n    <updatecheck codebase="${escapeXml(crxUrl)}" version="${manifest.version}" />\n  </app>\n</gupdate>\n`,
    ),
    writeFile(
      managedPolicyPath,
      `${JSON.stringify(createManagedPolicyTemplate({
        extensionId,
        updateManifestUrl,
        loopbackUrl: 'ws://127.0.0.1:9224',
        runtimeSecret: 'replace-with-runtime-secret-at-least-32-bytes',
        runtimeGeneration: 'replace-on-every-runtime-start',
      }), null, 2)}\n`,
    ),
  ])
  return {
    extensionId,
    crxPath,
    updateManifestPath,
    managedPolicyPath,
    sha256: createHash('sha256').update(crx).digest('hex'),
  }
}

export function createManagedPolicyTemplate(input: ManagedPolicyTemplateInput): Record<string, unknown> {
  if (!/^[a-p]{32}$/u.test(input.extensionId)) throw new TypeError('extensionId is invalid')
  if (new TextEncoder().encode(input.runtimeSecret).byteLength < 32) {
    throw new TypeError('runtimeSecret must contain at least 32 bytes')
  }
  return {
    ExtensionSettings: {
      [input.extensionId]: {
        installation_mode: 'force_installed',
        update_url: input.updateManifestUrl,
        override_update_url: true,
      },
    },
    '3rdparty': {
      extensions: {
        [input.extensionId]: {
          loopbackUrl: input.loopbackUrl,
          runtimeSecret: input.runtimeSecret,
          runtimeGeneration: input.runtimeGeneration,
        },
      },
    },
  }
}

async function collectFiles(root: string): Promise<Zippable> {
  const output: Zippable = {}
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new TypeError(`Extension source contains a symlink: ${relative(root, path)}`)
      }
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        output[relative(root, path).split(sep).join('/')] = new Uint8Array(await readFile(path))
      }
    }
  }
  await visit(root)
  if (!('manifest.json' in output)) {
    throw new TypeError(`Extension source ${basename(root)} has no manifest.json`)
  }
  return output
}

function parseManifest(source: string): { version: string; serviceWorker: string } {
  const value: unknown = JSON.parse(source)
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    typeof value.version !== 'string' ||
    !/^\d+(?:\.\d+){0,3}$/u.test(value.version)
  ) {
    throw new TypeError('Extension manifest version is invalid')
  }
  const background = 'background' in value ? value.background : undefined
  if (
    typeof background !== 'object' ||
    background === null ||
    !('service_worker' in background) ||
    typeof background.service_worker !== 'string' ||
    background.service_worker.length === 0
  ) {
    throw new TypeError('Extension manifest service worker is invalid')
  }
  return { version: value.version, serviceWorker: background.service_worker }
}

function assertRemoteTabArtifact(files: Zippable, serviceWorker: string): void {
  const requiredFiles = [
    serviceWorker,
    'managed-schema.json',
    'offscreen.html',
    'offscreen.js',
    'loopback.js',
  ]
  for (const file of requiredFiles) {
    if (!(file in files)) {
      throw new TypeError(
        `Chrome Extension artifact is missing ${file}; sign packages/extension/build/chrome after running the Extension build`,
      )
    }
  }
}

function encodeLengthDelimited(field: number, value: Uint8Array): Buffer {
  return Buffer.concat([
    encodeVarint((field << 3) | 2),
    encodeVarint(value.byteLength),
    Buffer.from(value),
  ])
}

function encodeVarint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Protobuf varint is invalid')
  }
  const bytes: number[] = []
  do {
    const part = value & 0x7f
    value = Math.floor(value / 128)
    bytes.push(value === 0 ? part : part | 0x80)
  } while (value !== 0)
  return Buffer.from(bytes)
}

function uint32(value: number): Buffer {
  const output = Buffer.allocUnsafe(4)
  output.writeUInt32LE(value)
  return output
}

function encodeExtensionId(bytes: Uint8Array): string {
  return [...bytes]
    .flatMap((byte) => [byte >>> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join('')
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('updateBaseUrl must use HTTP or HTTPS')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
