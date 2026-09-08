import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

const workspace = resolve(fileOption('--workspace') ?? process.cwd())
const temporaryRoot = resolve(workspace, 'tmp')
const output = resolve(workspace, fileOption('--out') ?? 'tmp/ci-artifacts')
const outputRelative = relative(temporaryRoot, output)

if (outputRelative === '' || outputRelative.startsWith('..') || isAbsolute(outputRelative)) {
  throw new TypeError('Artifact output must be a child of the workspace tmp directory')
}

const compatibility = JSON.parse(await readFile(resolve(output, 'compatibility.json'), 'utf8'))
const indexedFiles = await collectFiles(output, new Set(['artifact-index.json', 'SHA256SUMS', 'build-record.intoto.json']))
await writeFile(
  resolve(output, 'artifact-index.json'),
  `${JSON.stringify({ schemaVersion: 1, compatibility, files: indexedFiles }, null, 2)}\n`,
)

const subjectFiles = await collectFiles(output, new Set(['SHA256SUMS', 'build-record.intoto.json']))
const subjects = []
for (const file of subjectFiles) {
  subjects.push({
    name: file.path,
    digest: { sha256: createHash('sha256').update(await readFile(resolve(output, file.path))).digest('hex') },
  })
}

await writeFile(
  resolve(output, 'SHA256SUMS'),
  `${subjects.map((subject) => `${subject.digest.sha256}  ${subject.name}`).join('\n')}\n`,
)

const repository = process.env.GITHUB_REPOSITORY
const sourceRevision = process.env.GITHUB_SHA
const runId = process.env.GITHUB_RUN_ID
const runAttempt = process.env.GITHUB_RUN_ATTEMPT
const githubBuild = repository && runId && sourceRevision
const statement = {
  _type: 'https://in-toto.io/Statement/v1',
  subject: subjects,
  predicateType: 'https://slsa.dev/provenance/v1',
  predicate: {
    buildDefinition: {
      buildType: 'urn:browshare:remote-tab:build:ci-artifacts:v1',
      externalParameters: { compatibility },
      internalParameters: {},
      resolvedDependencies: githubBuild
        ? [{ uri: `git+https://github.com/${repository}@${sourceRevision}`, digest: { gitCommit: sourceRevision } }]
        : [],
    },
    runDetails: {
      builder: {
        id: githubBuild
          ? `https://github.com/${repository}/actions/runs/${runId}/attempts/${runAttempt ?? '1'}`
          : 'urn:browshare:remote-tab:builder:local:v1',
      },
      metadata: {
        invocationId: githubBuild ? `${runId}-${runAttempt ?? '1'}` : `local-${process.pid}`,
        finishedOn: new Date().toISOString(),
      },
    },
  },
}
await writeFile(resolve(output, 'build-record.intoto.json'), `${JSON.stringify(statement, null, 2)}\n`)

process.stdout.write(
  `${JSON.stringify(
    {
      status: 'passed',
      output,
      indexedFiles: indexedFiles.length,
      checksums: subjects.length,
      provenance: githubBuild ? 'github-build-record' : 'local-build-record',
    },
    null,
    2,
  )}\n`,
)

async function collectFiles(root, excludedNames) {
  const result = []

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (excludedNames.has(entry.name)) continue
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

function fileOption(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new TypeError(`Missing value for ${name}`)
  return value
}
