import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const workspace = resolve(fileOption('--workspace') ?? process.cwd())
const temporaryRoot = resolve(workspace, 'tmp')
const output = resolve(workspace, fileOption('--out') ?? 'tmp/ci-artifacts')
const outputRelative = relative(temporaryRoot, output)

if (outputRelative === '' || outputRelative.startsWith('..') || isAbsolute(outputRelative)) {
  throw new TypeError('Artifact output must be a child of the workspace tmp directory')
}

const packageDirectories = [
  'packages/core',
  'packages/extension',
  'packages/headless-client',
  'packages/protocol',
  'packages/viewer',
  'tools/extension-signing',
]

await rm(output, { recursive: true, force: true })
const npmOutput = resolve(output, 'npm')
await mkdir(npmOutput, { recursive: true })

for (const directory of packageDirectories) {
  await exec('pnpm', ['pack', '--pack-destination', npmOutput], {
    cwd: resolve(workspace, directory),
  })
}

await cp(resolve(workspace, 'packages/extension/build/chrome'), resolve(output, 'extension/chrome'), {
  recursive: true,
})
await cp(resolve(workspace, 'deploy/compatibility.json'), resolve(output, 'compatibility.json'))
await cp(resolve(workspace, 'LICENSE'), resolve(output, 'LICENSE'))
await cp(resolve(workspace, 'THIRD_PARTY_NOTICES.md'), resolve(output, 'THIRD_PARTY_NOTICES.md'))

const dependencyLicenses = {
  schemaVersion: 1,
  generatedBy: 'pnpm licenses list',
  scopes: {
    production: await collectLicenses('production', '--prod'),
    development: await collectLicenses('development', '--dev'),
  },
}
await writeFile(
  resolve(output, 'dependency-licenses.json'),
  `${JSON.stringify(dependencyLicenses, null, 2)}\n`,
)

const files = await collectFiles(output)
await writeFile(
  resolve(output, 'artifact-index.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      compatibility: JSON.parse(
        await readFile(resolve(workspace, 'deploy/compatibility.json'), 'utf8'),
      ),
      files,
    },
    null,
    2,
  )}\n`,
)

process.stdout.write(
  `${JSON.stringify({ status: 'passed', output, packages: packageDirectories.length, files: files.length }, null, 2)}\n`,
)

async function collectFiles(root) {
  const result = []

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === 'artifact-index.json') continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        const metadata = await stat(path)
        result.push({ path: relative(root, path).split('\\').join('/'), bytes: metadata.size })
      }
    }
  }

  await visit(root)
  return result
}

async function collectLicenses(scope, flag) {
  const { stdout } = await exec('pnpm', ['licenses', 'list', '--json', flag], { cwd: workspace })
  const grouped = JSON.parse(stdout)
  const packages = Object.entries(grouped)
    .flatMap(([groupLicense, entries]) =>
      entries.flatMap((entry) =>
        entry.versions.map((version) => ({
          name: entry.name,
          version,
          license: entry.license ?? groupLicense,
          ...(entry.author ? { author: entry.author } : {}),
          ...(entry.homepage ? { homepage: entry.homepage } : {}),
        })),
      ),
    )
    .sort((left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
    )

  return { scope, packages }
}

function fileOption(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new TypeError(`Missing value for ${name}`)
  return value
}
