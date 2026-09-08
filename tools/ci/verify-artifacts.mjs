import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

const workspace = resolve(fileOption('--workspace') ?? process.cwd())
const temporaryRoot = resolve(workspace, 'tmp')
const output = resolve(workspace, fileOption('--out') ?? 'tmp/ci-artifacts')
const outputRelative = relative(temporaryRoot, output)

if (outputRelative === '' || outputRelative.startsWith('..') || isAbsolute(outputRelative)) {
  throw new TypeError('Artifact input must be a child of the workspace tmp directory')
}

const checksumLines = (await readFile(resolve(output, 'SHA256SUMS'), 'utf8'))
  .trim()
  .split('\n')
const expected = new Map()

for (const line of checksumLines) {
  const match = /^([a-f0-9]{64})  (.+)$/u.exec(line)
  if (!match) throw new TypeError(`Invalid SHA256SUMS line: ${line}`)
  const [, digest, name] = match
  const path = resolve(output, name)
  const pathRelative = relative(output, path)
  if (pathRelative.startsWith('..') || isAbsolute(pathRelative)) {
    throw new TypeError(`Checksum path escapes artifact directory: ${name}`)
  }
  if (expected.has(name)) throw new TypeError(`Duplicate checksum path: ${name}`)
  const actual = createHash('sha256').update(await readFile(path)).digest('hex')
  if (actual !== digest) throw new Error(`Checksum mismatch for ${name}`)
  expected.set(name, digest)
}

const buildRecord = JSON.parse(await readFile(resolve(output, 'build-record.intoto.json'), 'utf8'))
if (
  buildRecord._type !== 'https://in-toto.io/Statement/v1' ||
  buildRecord.predicateType !== 'https://slsa.dev/provenance/v1'
) {
  throw new TypeError('Build record is not an in-toto SLSA provenance statement')
}
const recordedSubjects = new Map(
  buildRecord.subject.map((subject) => [subject.name, subject.digest?.sha256]),
)
if (recordedSubjects.size !== expected.size) throw new Error('Build-record subject count differs')
for (const [name, digest] of expected) {
  if (recordedSubjects.get(name) !== digest) {
    throw new Error(`Build-record subject mismatch for ${name}`)
  }
}

const cycloneDx = JSON.parse(await readFile(resolve(output, 'sbom-source.cdx.json'), 'utf8'))
const spdx = JSON.parse(await readFile(resolve(output, 'sbom-source.spdx.json'), 'utf8'))
const dependencyLicenses = JSON.parse(
  await readFile(resolve(output, 'dependency-licenses.json'), 'utf8'),
)
if (cycloneDx.bomFormat !== 'CycloneDX' || !Array.isArray(cycloneDx.components)) {
  throw new TypeError('CycloneDX SBOM is invalid')
}
if (spdx.spdxVersion !== 'SPDX-2.3' || !Array.isArray(spdx.packages)) {
  throw new TypeError('SPDX SBOM is invalid')
}
if (dependencyLicenses.schemaVersion !== 1 || dependencyLicenses.generatedBy !== 'pnpm licenses list') {
  throw new TypeError('Dependency license report is invalid')
}

const licenseScopes = ['production', 'development']
const licenseCounts = {}
for (const scope of licenseScopes) {
  const report = dependencyLicenses.scopes?.[scope]
  if (report?.scope !== scope || !Array.isArray(report.packages)) {
    throw new TypeError(`Dependency license scope is invalid: ${scope}`)
  }
  const seen = new Set()
  for (const dependency of report.packages) {
    if (
      typeof dependency.name !== 'string' ||
      dependency.name.length === 0 ||
      typeof dependency.version !== 'string' ||
      dependency.version.length === 0 ||
      typeof dependency.license !== 'string' ||
      dependency.license.length === 0
    ) {
      throw new TypeError(`Dependency license entry is incomplete: ${scope}`)
    }
    const identity = `${dependency.name}@${dependency.version}`
    if (seen.has(identity)) throw new TypeError(`Duplicate dependency license entry: ${scope}/${identity}`)
    seen.add(identity)
  }
  licenseCounts[scope] = report.packages.length
}

process.stdout.write(
  `${JSON.stringify(
    {
      status: 'passed',
      checksums: expected.size,
      provenanceSubjects: recordedSubjects.size,
      cycloneDxComponents: cycloneDx.components.length,
      spdxPackages: spdx.packages.length,
      dependencyLicenses: licenseCounts,
    },
    null,
    2,
  )}\n`,
)

function fileOption(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new TypeError(`Missing value for ${name}`)
  return value
}
