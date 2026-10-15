/**
 * Bundle a TypeScript test entry with esbuild and run it under node.
 *
 * DSH SDK packages stay external (they are supplied by the installation, never
 * installed into this plugin), so the bundle is staged in a throwaway directory
 * whose `node_modules` links each imported SDK package straight out of the DSH
 * installation. That is the same resolution shape the Host uses.
 *
 * Usage: node test/run-integration.mjs [entry.ts]
 */
import { spawnSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = dirname(fileURLToPath(import.meta.url))
const entry = resolve(process.argv[2] ?? join(ROOT, 'integration.entry.ts'))
const stage = mkdtempSync(join(tmpdir(), 'guard-it-'))

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outfile: join(stage, 'entry.mjs'),
  logLevel: 'warning',
  metafile: true,
  external: ['@deepseek-ai/*'],
})

/** Locate the DSH installation's shared `node_modules`. */
function sdkRootOf() {
  const bin = execFileSync('bash', ['-lc', 'readlink -f "$(command -v dsh)"'], { encoding: 'utf8' }).trim()
  if (bin === '') throw new Error('dsh not found on PATH')
  return resolve(join(dirname(bin), '..', 'node_modules'))
}

const sdkRoot = sdkRootOf()
const specifiers = new Set()
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) {
    if (imported.path.startsWith('node:') || !imported.path.startsWith('@deepseek-ai/')) continue
    specifiers.add(imported.path)
  }
}
// A wildcard external does not appear in `imports`, so scan the emitted text too.
const emitted = (await import('node:fs')).readFileSync(join(stage, 'entry.mjs'), 'utf8')
for (const match of emitted.matchAll(/from\s*"(@deepseek-ai\/[^"]+)"/g)) specifiers.add(match[1])

for (const specifier of specifiers) {
  const source = join(sdkRoot, specifier)
  if (!existsSync(source)) throw new Error(`SDK package missing from the DSH install: ${source}`)
  const target = join(stage, 'node_modules', specifier)
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(source, target, 'dir')
}

try {
  const run = spawnSync(process.execPath, [join(stage, 'entry.mjs'), ...process.argv.slice(3)], { stdio: 'inherit' })
  process.exit(run.status ?? 1)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
