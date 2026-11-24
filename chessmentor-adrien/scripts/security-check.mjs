import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
const failures = []
for (const file of tracked) {
  if (/(^|\/)(\.dev\.vars[^/]*|\.env(?:\.[^/]*)?|\.wrangler|\.deepspace)(\/|$)/.test(file))
    failures.push(`${file}: local secret/runtime file is tracked`)
}
// Detect credential patterns without printing any matching value.
const paths = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: root, encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean)
const secretPattern =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|\b(?:sk-proj-|sk-ant-)[A-Za-z0-9_-]{25,}/
for (const file of new Set(paths)) {
  let content
  try {
    content = await readFile(resolve(root, file), 'utf8')
  } catch {
    continue
  }
  if (secretPattern.test(content)) failures.push(`${file}: possible credential; inspect locally`)
}
const credentials = []
try {
  const vars = await readFile(resolve(root, '.dev.vars'), 'utf8')
  for (const line of vars.split(/\r?\n/)) {
    const match = /^(?:APP_OWNER_JWT|APP_IDENTITY_TOKEN)\s*=\s*(.*)$/.exec(line)
    if (match) {
      const value = match[1].trim().replace(/^["']|["']$/g, '')
      if (value.length > 20) credentials.push(value)
    }
  }
} catch {
  /* A clean CI checkout should not have .dev.vars. */
}
async function scanClient(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) await scanClient(path)
    else {
      const content = await readFile(path, 'utf8')
      if (credentials.some((value) => content.includes(value)) || secretPattern.test(content))
        failures.push(`${path}: credential pattern in public build`)
      if (entry.name.endsWith('.map')) failures.push(`${path}: public source map`)
    }
  }
}
await scanClient(resolve(root, 'dist/client'))
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else
  console.log(
    'Source/index and public build credential checks passed. Historical credentials still require revocation.',
  )
