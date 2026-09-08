import { readFile, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'

const artifactDirectory = new URL('../build/chrome/', import.meta.url)
const requiredFiles = [
  'manifest.json',
  'managed-schema.json',
  'offscreen.html',
  'offscreen.js',
  'service-worker.js',
]

const entries = await readdir(artifactDirectory, { withFileTypes: true })
const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
const manifest = JSON.parse(await readFile(new URL('manifest.json', artifactDirectory), 'utf8'))

for (const requiredFile of requiredFiles) {
  if (!files.includes(requiredFile)) {
    throw new Error(`Chrome extension artifact is missing ${requiredFile}`)
  }
}

for (const file of files.filter((candidate) => extname(candidate) === '.js')) {
  const source = await readFile(new URL(file, artifactDirectory), 'utf8')
  const imports = source.matchAll(/\b(?:from\s+|import\s*(?:\(\s*)?)["']([^.'"][^"']*)["']/gu)
  for (const match of imports) {
    throw new Error(`Chrome extension artifact ${join('build/chrome', file)} imports bare specifier ${match[1]}`)
  }
  if ((file === 'service-worker.js' || file === 'offscreen.js') && !source.includes(manifest.version)) {
    throw new Error(`Chrome extension artifact ${join('build/chrome', file)} does not embed manifest version ${manifest.version}`)
  }
  if (source.includes('chrome.runtime.getManifest')) {
    throw new Error(`Chrome extension artifact ${join('build/chrome', file)} calls context-specific chrome.runtime.getManifest()`)
  }
}
