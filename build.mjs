/**
 * Build the host half: `src/index.ts` → `lib/index.js`.
 *
 * One bundled ESM file. SDK peers and `@deepseek-ai/schemastery` stay external
 * because the DSH profile resolution layer points those specifiers at the
 * installation's own singleton copies; `zod` is bundled instead, so the plugin
 * needs no runtime `node_modules` of its own and cannot fail to resolve one.
 *
 * The bundle is then loaded for real, inside a throwaway directory whose
 * `node_modules` links the SDK peers out of the DSH installation. That is the
 * same resolution shape the Host will use, so a syntax error, a missing export,
 * a bad config schema, or a stray non-SDK bare import fails the build here
 * instead of silently at Host startup.
 */
import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

function fail(message) {
  console.error(`\n[build] FAIL: ${message}\n`)
  process.exit(1)
}

function warn(message) {
  console.warn(`[build] WARN: ${message}`)
}

/** Specifiers the DSH profile loader supplies at Host startup. */
const SDK_EXTERNAL = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/schemastery',
]

const result = await build({
  entryPoints: [join(ROOT, 'src/index.ts')],
  outfile: join(ROOT, 'lib/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  logLevel: 'warning',
  metafile: true,
  external: SDK_EXTERNAL,
})

// ── contract self-check ─────────────────────────────────────────────────────
if (PKG.dsh?.engines?.dsh === undefined) fail('package.json 缺少 dsh.engines.dsh')
if (PKG.dsh?.bundle?.patch === undefined) fail('package.json 缺少 dsh.bundle.patch')
if (!existsSync(join(ROOT, PKG.dsh.bundle.patch))) fail(`dsh.bundle.patch 指向的 ${PKG.dsh.bundle.patch} 不存在`)
if (PKG.dsh.client !== undefined) fail('本插件没有浏览器半，package.json 不应声明 dsh.client')
if (PKG.dependencies !== undefined && Object.keys(PKG.dependencies).length > 0) {
  fail('不应有运行时 dependencies：zod 已打进 bundle，其余外部依赖必须是 peerDependency')
}

/** Every bare specifier the bundle actually imports at runtime. */
const runtimeImports = new Set()
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) {
    if (!imported.external) continue
    if (imported.path.startsWith('node:')) continue
    if (PKG.peerDependencies?.[imported.path] === undefined) {
      fail(`lib/index.js 外部导入了 ${imported.path}，但它不是 peerDependency：link: 布局下解析不到`)
    }
    runtimeImports.add(imported.path)
  }
}

// ── load the bundle for real, in a throwaway resolution root ────────────────
/**
 * Locate the DSH installation's shared `node_modules`, the same tree the
 * profile resolution layer maps SDK specifiers into.
 * @returns the directory, or undefined when `dsh` is not on PATH.
 */
function sdkRootOf() {
  try {
    const bin = execFileSync('bash', ['-lc', 'readlink -f "$(command -v dsh)"'], { encoding: 'utf8' }).trim()
    if (bin === '') return undefined
    // …/@deepseek-ai/dsh/lib/bin.js → …/@deepseek-ai/dsh/node_modules
    const root = join(dirname(bin), '..', 'node_modules')
    return existsSync(root) ? resolve(root) : undefined
  } catch {
    return undefined
  }
}

const sdkRoot = sdkRootOf()
let loaded
if (sdkRoot === undefined) {
  warn('未找到 DSH 安装（dsh 不在 PATH 上），跳过真实装载自检：exports/Config 未验证')
} else {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-workspace-guard-build-'))
  try {
    cpSync(join(ROOT, 'lib/index.js'), join(stage, 'index.js'))
    for (const specifier of runtimeImports) {
      const source = join(sdkRoot, specifier)
      if (!existsSync(source)) fail(`SDK peer ${specifier} 不在 DSH 安装中：${source}`)
      const target = join(stage, 'node_modules', specifier)
      mkdirSync(dirname(target), { recursive: true })
      symlinkSync(source, target, 'dir')
    }
    loaded = await import(join(stage, 'index.js'))
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

if (loaded !== undefined) {
  if (typeof loaded.apply !== 'function') fail('lib/index.js 没有导出 apply')
  if (loaded.Config === undefined) fail('lib/index.js 没有导出 Config')
  if (!Array.isArray(loaded.inject)) fail('lib/index.js 没有导出 inject 数组')
  // Exercise the schema, so a bad default or an unsupported combinator fails here.
  const defaults = typeof loaded.Config === 'function' ? loaded.Config({}) : undefined
  for (const field of ['enabled', 'announceToAgent', 'selfOwnership', 'requireGitRepo', 'refuseOnProbeError', 'gitDirtyImpliesBusy', 'onBlocked', 'leaseTtlMinutes']) {
    if (defaults !== undefined && defaults[field] === undefined) fail(`Config 默认值缺少字段 ${field}`)
  }
  console.log(`[build] load check: exports apply/Config, inject=[${loaded.inject.join(', ')}]`)
  if (defaults !== undefined) {
    // Volatile fields arrive as stable reference objects the Loader commits in
    // place, so the effective value is read through `.get()` rather than printed raw.
    const plain = {}
    for (const [key, value] of Object.entries(defaults)) {
      plain[key] = typeof value?.get === 'function' ? value.get() : value
    }
    console.log(`[build] config defaults: ${JSON.stringify(plain)}`)
  }
}

const bytes = result.metafile.outputs['lib/index.js']?.bytes ?? 0
console.log(`[build] ok  lib/index.js  ${(bytes / 1024).toFixed(1)} KiB  (external: ${[...runtimeImports].join(', ')}; zod bundled)`)
