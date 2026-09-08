import { mkdir, writeFile } from 'node:fs/promises'

const extensionId = required('BROWSHARE_REMOTE_TAB_EXTENSION_ID')
const updateUrl = required('BROWSHARE_REMOTE_TAB_EXTENSION_UPDATE_URL')
const runtimeSecret = required('BROWSHARE_REMOTE_TAB_RUNTIME_SECRET')
const runtimeGeneration = required('BROWSHARE_REMOTE_TAB_RUNTIME_GENERATION')
const extensionHost = process.env.BROWSHARE_REMOTE_TAB_EXTENSION_HOST ?? '127.0.0.1'
const extensionPort = process.env.BROWSHARE_REMOTE_TAB_EXTENSION_PORT ?? '9224'

if (!/^[a-p]{32}$/u.test(extensionId)) throw new TypeError('Extension ID is invalid')
if (new TextEncoder().encode(runtimeSecret).byteLength < 32) {
  throw new TypeError('Runtime secret must contain at least 32 bytes')
}
const parsedUpdateUrl = new URL(updateUrl)
if (parsedUpdateUrl.protocol !== 'http:' && parsedUpdateUrl.protocol !== 'https:') {
  throw new TypeError('Extension update URL must use HTTP or HTTPS')
}
if (extensionHost !== '127.0.0.1' && extensionHost !== '::1') {
  throw new TypeError('Extension loopback host must be 127.0.0.1 or ::1')
}
if (!/^\d+$/u.test(extensionPort) || Number(extensionPort) < 1 || Number(extensionPort) > 65535) {
  throw new TypeError('Extension loopback port must be an integer from 1 to 65535')
}
const loopbackHost = extensionHost === '::1' ? '[::1]' : extensionHost

const policy = {
  ExtensionSettings: {
    [extensionId]: {
      installation_mode: 'force_installed',
      update_url: parsedUpdateUrl.toString(),
      override_update_url: true,
    },
  },
  '3rdparty': {
    extensions: {
      [extensionId]: {
        loopbackUrl: `ws://${loopbackHost}:${extensionPort}`,
        runtimeSecret,
        runtimeGeneration,
      },
    },
  },
}

const directory = '/etc/opt/chrome/policies/managed'
await mkdir(directory, { recursive: true })
await writeFile(`${directory}/browshare-remote-tab.json`, `${JSON.stringify(policy, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o644,
})

function required(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Missing required environment variable ${name}`)
  }
  return value
}
