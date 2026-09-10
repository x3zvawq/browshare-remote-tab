import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hostname } from 'node:os'

// Run as the Profile owner before Chrome starts; Worker also holds its runtime lock.
// These browser defaults do not override a website's explicit CSS font families.
const directory = process.argv[2]
if (!directory) throw new Error('Chrome font defaults require a Profile directory')

async function configure() {
  try {
    const lock = await readlink(join(directory, 'SingletonLock'))
    const separator = lock.lastIndexOf('-')
    const pid = Number(lock.slice(separator + 1))
    if (lock.slice(0, separator) !== hostname() || !Number.isSafeInteger(pid) || pid < 1)
      throw new Error('Chrome lock owner cannot be inspected')
    try {
      process.kill(pid, 0)
      throw new Error('Chrome is still running')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const profile = join(directory, 'Default')
  const path = join(profile, 'Preferences')
  let preferences = {}
  try {
    preferences = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!object(preferences)) throw new Error('Invalid Chrome preferences')
  let fonts = preferences
  for (const key of ['webkit', 'webprefs', 'fonts']) {
    if (fonts[key] === undefined) fonts[key] = {}
    if (!object(fonts[key])) throw new Error('Invalid Chrome font preferences')
    fonts = fonts[key]
  }
  for (const [family, name] of Object.entries({
    standard: 'Noto Sans CJK SC',
    serif: 'Noto Serif CJK SC',
    sansserif: 'Noto Sans CJK SC',
    fixed: 'Noto Sans Mono CJK SC',
  })) {
    if (fonts[family] === undefined) fonts[family] = {}
    if (!object(fonts[family])) throw new Error('Invalid Chrome font family preferences')
    // Zyyy is the common-script fallback; Han defaults are separately registered by Chrome.
    for (const script of ['Zyyy', 'Hans', 'Hant']) fonts[family][script] = name
  }
  await mkdir(profile, { recursive: true, mode: 0o700 })
  const temporary = join(profile, `.browshare-fonts-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(preferences), { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

// JSON parser errors can contain Profile content. Emit only the fixed failure code.
configure().catch(() => {
  process.stderr.write('CHROME_FONT_CONFIGURATION_FAILED\n')
  process.exitCode = 1
})
