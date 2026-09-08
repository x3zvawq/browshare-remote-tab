#!/usr/bin/env node

import { generateExtensionPrivateKey, signExtension } from './index.js'

const [command, ...arguments_] = process.argv.slice(2)

if (command === 'generate-key') {
  const path = requiredOption(arguments_, '--key')
  await generateExtensionPrivateKey(path)
  process.stdout.write(`${JSON.stringify({ privateKeyPath: path })}\n`)
} else if (command === 'build') {
  const artifacts = await signExtension({
    sourceDirectory: requiredOption(arguments_, '--source'),
    privateKeyPath: requiredOption(arguments_, '--key'),
    outputDirectory: requiredOption(arguments_, '--out'),
    updateBaseUrl: requiredOption(arguments_, '--base-url'),
  })
  process.stdout.write(`${JSON.stringify(artifacts, null, 2)}\n`)
} else {
  process.stderr.write(
    'Usage:\n' +
      '  browshare-extension generate-key --key <private.pem>\n' +
      '  browshare-extension build --source <extension-dir> --key <private.pem> --out <dir> --base-url <url>\n',
  )
  process.exitCode = 2
}

function requiredOption(arguments_: string[], name: string): string {
  const index = arguments_.indexOf(name)
  const value = index < 0 ? undefined : arguments_[index + 1]
  if (!value) throw new TypeError(`Missing required option ${name}`)
  return value
}
