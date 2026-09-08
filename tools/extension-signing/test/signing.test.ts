import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createManagedPolicyTemplate,
  generateExtensionPrivateKey,
  signExtension,
} from '../src/index.js'

describe('extension signing', () => {
  it('creates stable CRX3 identity, update metadata, and managed policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browshare-extension-'))
    const source = join(root, 'source')
    const key = join(root, 'private.pem')
    const output = join(root, 'output')
    await mkdir(source)
    await writeFile(
      join(source, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Test',
        version: '1.2.3',
        background: { service_worker: 'service-worker.js' },
      }),
    )
    await writeFile(join(source, 'service-worker.js'), 'export {}')
    await writeFile(join(source, 'managed-schema.json'), '{}')
    await writeFile(join(source, 'offscreen.html'), '<script type="module" src="offscreen.js"></script>')
    await writeFile(join(source, 'offscreen.js'), 'import "./loopback.js"')
    await writeFile(join(source, 'loopback.js'), 'export {}')
    await generateExtensionPrivateKey(key)
    const input = {
      sourceDirectory: source,
      privateKeyPath: key,
      outputDirectory: output,
      updateBaseUrl: 'https://updates.example.test/remote-tab',
    }
    const first = await signExtension(input)
    const second = await signExtension(input)

    expect(first.extensionId).toMatch(/^[a-p]{32}$/u)
    expect(second.extensionId).toBe(first.extensionId)
    expect(second.sha256).toBe(first.sha256)
    expect((await readFile(first.crxPath)).subarray(0, 8)).toEqual(
      Buffer.from([0x43, 0x72, 0x32, 0x34, 3, 0, 0, 0]),
    )
    expect(await readFile(first.updateManifestPath, 'utf8')).toContain(
      `appid="${first.extensionId}"`,
    )
    expect(
      createManagedPolicyTemplate({
        extensionId: first.extensionId,
        updateManifestUrl: 'https://updates.example.test/updates.xml',
        loopbackUrl: 'ws://127.0.0.1:9224',
        runtimeSecret: '0123456789abcdef0123456789abcdef',
        runtimeGeneration: 'runtime-1',
      }),
    ).toEqual({
      ExtensionSettings: {
        [first.extensionId]: {
          installation_mode: 'force_installed',
          update_url: 'https://updates.example.test/updates.xml',
          override_update_url: true,
        },
      },
      '3rdparty': {
        extensions: {
          [first.extensionId]: {
            loopbackUrl: 'ws://127.0.0.1:9224',
            runtimeSecret: '0123456789abcdef0123456789abcdef',
            runtimeGeneration: 'runtime-1',
          },
        },
      },
    })
  })

  it('rejects an unbuilt static template before producing an invalid CRX', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browshare-extension-unbuilt-'))
    const source = join(root, 'source')
    const key = join(root, 'private.pem')
    await mkdir(source)
    await writeFile(
      join(source, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Test',
        version: '1.2.3',
        background: { service_worker: 'service-worker.js' },
      }),
    )
    await generateExtensionPrivateKey(key)

    await expect(
      signExtension({
        sourceDirectory: source,
        privateKeyPath: key,
        outputDirectory: join(root, 'output'),
        updateBaseUrl: 'https://updates.example.test/remote-tab',
      }),
    ).rejects.toThrow(/sign packages\/extension\/build\/chrome/u)
  })
})
