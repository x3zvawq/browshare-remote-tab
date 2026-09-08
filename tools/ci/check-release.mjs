import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const workspace = resolve(fileOption('--workspace') ?? process.cwd())
const compatibility = await readJson('deploy/compatibility.json')
const expectedTag = `v${compatibility.releaseVersion}`
const tag = fileOption('--tag') ?? expectedTag
const failures = []
const repository = fileOption('--repository') ?? process.env.GITHUB_REPOSITORY
if (repository !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
  throw new TypeError('Repository must be a GitHub owner/repository pair')
}

if (!/^\d+\.\d+\.\d+$/u.test(compatibility.releaseVersion)) {
  failures.push('releaseVersion must be a stable three-part semantic version')
}
if (compatibility.releaseVersion === '0.0.0') {
  failures.push('releaseVersion must be non-zero')
}
if (tag !== expectedTag) failures.push(`release tag is ${tag}, expected ${expectedTag}`)
if (compatibility.extension.version !== compatibility.releaseVersion) {
  failures.push(
    `Extension is ${compatibility.extension.version}, expected coordinated release ${compatibility.releaseVersion}`,
  )
}

const publicPackages = [
  'packages/core/package.json',
  'packages/extension/package.json',
  'packages/headless-client/package.json',
  'packages/protocol/package.json',
  'packages/viewer/package.json',
  'tools/extension-signing/package.json',
]
const privatePackages = [
  'package.json',
  'apps/signaling/package.json',
  'apps/standalone/package.json',
  'examples/embed/package.json',
]

for (const relativePath of publicPackages) {
  const packageJson = await readJson(relativePath)
  // npm provenance binds the archive metadata to its actual hosted source repository.
  if (repository !== undefined) {
    const expectedUrl = `git+https://github.com/${repository}.git`
    const expectedDirectory = relativePath.replace(/\/package\.json$/u, '')
    if (packageJson.repository?.type !== 'git' ||
      packageJson.repository?.url !== expectedUrl ||
      packageJson.repository?.directory !== expectedDirectory) {
      failures.push(`${packageJson.name} repository must be ${expectedUrl} with directory ${expectedDirectory}`)
    }
  }
  if (packageJson.version !== compatibility.releaseVersion) {
    failures.push(`${packageJson.name} is ${packageJson.version}, expected ${compatibility.releaseVersion}`)
  }
  if (packageJson.private === true) failures.push(`${packageJson.name} is unexpectedly private`)
  if (packageJson.license !== 'MIT') failures.push(`${packageJson.name} does not declare MIT`)
  if (packageJson.publishConfig?.access !== 'public') {
    failures.push(`${packageJson.name} does not publish as public`)
  }
  if (!Array.isArray(packageJson.files) || !packageJson.files.includes('dist')) {
    failures.push(`${packageJson.name} does not limit publication to built dist output`)
  }
}

for (const relativePath of privatePackages) {
  const packageJson = await readJson(relativePath)
  if (packageJson.version !== compatibility.releaseVersion) {
    failures.push(`${packageJson.name} is ${packageJson.version}, expected ${compatibility.releaseVersion}`)
  }
  if (packageJson.private !== true) failures.push(`${packageJson.name} must remain private`)
}

const extensionManifest = await readJson('packages/extension/extension/manifest.json')
if (extensionManifest.version !== compatibility.extension.version) {
  failures.push(
    `Extension manifest is ${extensionManifest.version}, expected ${compatibility.extension.version}`,
  )
}

const changelog = await readFile(resolve(workspace, 'CHANGELOG.md'), 'utf8')
const changelogHeading = new RegExp(
  `^## ${escapeRegExp(compatibility.releaseVersion)} - \\d{4}-\\d{2}-\\d{2}$`,
  'mu',
)
if (!changelogHeading.test(changelog)) {
  failures.push(`CHANGELOG.md has no dated ${compatibility.releaseVersion} heading`)
}

if (failures.length > 0) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', failures }, null, 2)}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'passed',
        tag,
        releaseVersion: compatibility.releaseVersion,
        publicPackages: publicPackages.length,
        repository: repository ?? null,
        repositoryMetadata: repository === undefined ? 'not-checked-no-hosted-repository' : 'verified',
        privatePackages: privatePackages.length,
        extension: compatibility.extension.version,
        protocol: compatibility.protocol,
      },
      null,
      2,
    )}\n`,
  )
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(workspace, relativePath), 'utf8'))
}

function fileOption(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new TypeError(`Missing value for ${name}`)
  return value
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

