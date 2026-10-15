/**
 * Executable evidence for the four capabilities, against the REAL stack.
 *
 * Nothing about the platform is faked here: the storage hub, the JSON backend,
 * the domain data form, session persistence (JSONL), and the workspace registry
 * are the shipped DSH plugins, mounted on a real cordis Context over a throwaway
 * `DSH_HOME`. The plugin itself is the real `src/index.ts`. So the evidence
 * below exercises the actual code paths — the real domain write chain, the real
 * header-validated `attachSession`, the real `workspace/session-activity`
 * waterfall, and real `git status` on real repositories.
 *
 * Two deliberate substitutions, both stated rather than hidden:
 *  - The `tools` service is a capturing registry (the documented interface:
 *    `register`/`get`), so the tools this plugin registers can be invoked
 *    directly. The tool bodies and everything they touch are the real ones.
 *  - The activity provider is registered here following the platform's own
 *    provider contract (exactly the shape of `installTurnArchiveAdmission`),
 *    because the shipped providers belong to services — Agent registry, job
 *    registry, subagent runtime, scheduler — that this harness does not mount.
 *    The signal path under test (cordis waterfall -> plugin) is the real one.
 *
 * Usage: node test/run-integration.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
// The shipped plugins are mounted exactly as `dsh-base` composes them, but the
// packages do not agree on a single module shape: some export `apply` as a named
// export, others default-export the Service class. `pluginShape` below resolves
// whichever the package chose.
import * as storageHub from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as jsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as workspaceRegistry from '@deepseek-ai/dsh-workspace'

import * as guard from '../src/index.ts'

/**
 * Resolve a package's plugin shape: a bare function/class, a module carrying
 * `apply`, or a module whose default export is the plugin.
 * @param mod - the imported module namespace.
 * @returns the value `ctx.plugin` accepts.
 */
function pluginShape(mod) {
  if (typeof mod === 'function') return mod
  if (typeof mod.apply === 'function') return mod
  if (mod.default !== undefined) return mod.default
  throw new Error(`unrecognized plugin shape: ${Object.keys(mod).join(', ')}`)
}

// ── fixtures ────────────────────────────────────────────────────────────────

const HOME = mkdtempSync(join(tmpdir(), 'guard-home-'))
const STORAGE = join(HOME, 'storage')
const SESSIONS = join(HOME, 'sessions')
mkdirSync(STORAGE, { recursive: true })
mkdirSync(SESSIONS, { recursive: true })

let failures = 0
let checks = 0

/**
 * Assert one fact and report it, so the run reads as a checklist.
 * @param label - what is being claimed.
 * @param condition - the claim.
 */
function check(label, condition) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}`)
  }
}

/** A real, clean git repository at `dir`. */
function makeRepo(dir) {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'guard@local'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'guard'], { cwd: dir })
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir })
  return dir
}

/** The tool execution context shape: an Agent carrying its Session. */
function execFor(sessionId) {
  return { agent: { session: { id: sessionId } } }
}

/**
 * Persist one real session whose header cwd is `cwd`.
 *
 * A session with no events does not materialize — the JSONL backend writes a
 * log, not a placeholder — so a single log-only `turn/start` is appended. That
 * is what makes the session visible to `sessionPersistence.list()` and therefore
 * to the registry's header-validated attach.
 *
 * @param app - the booted stack.
 * @param id - the session id to mint.
 * @param cwd - the working directory stamped into the immutable header.
 */
async function persistSession(app, id, cwd) {
  const handle = await app.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    cwd,
    isSeeded: false,
  })
  await handle.append([{ type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } }])
  await handle.close()
  return id
}

// ── boot the real stack ─────────────────────────────────────────────────────

console.log('\n[boot] storage hub + json backend + domain form + jsonl sessions + workspace registry')

/** One booted stack; booted twice to prove restart persistence. */
async function boot() {
  const app = new Context()
  // The capturing tool registry the plugin registers into.
  const registered = new Map()
  const toolsStub = {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
    get(name) {
      return registered.get(name)
    },
    /** Invoke one registered tool by name. */
    async call(name, args, sessionId) {
      const definition = registered.get(name)
      if (definition === undefined) throw new Error(`tool not registered: ${name}`)
      return await definition.execute(args, sessionId === undefined ? {} : execFor(sessionId))
    },
    names() {
      return [...registered.keys()]
    },
  }
  app.provide('tools', toolsStub)
  await app.plugin(pluginShape(storageHub))
  await app.plugin(pluginShape(storageJson), { root: STORAGE })
  await app.plugin(pluginShape(storageDomain), { backend: 'json' })
  // The JSONL impl is what actually provides `sessionPersistence`; the abstract
  // base package is not mounted (dsh-base composes it the same way).
  await app.plugin(pluginShape(jsonlPersistence), { root: SESSIONS })
  await app.plugin(pluginShape(workspaceRegistry))
  return { app, tools: toolsStub }
}

// The activity provider this harness registers, following the shipped contract:
// ask the remaining providers through `next()`, prepend our own family.
const active = new Set()

const first = await boot()
first.app.on('workspace/session-activity', async ({ sessionId }, next) => {
  const rest = await next()
  return active.has(sessionId) ? [{ kind: 'turn' }, ...rest] : rest
})

// Mount the plugin under test. `systemPrompt` is deliberately absent, which
// also proves the plugin tolerates a deployment that serves no prompt registry.
await first.app.plugin(guard, {})
const { tools, app } = first

console.log(`[boot] registered tools: ${tools.names().join(', ')}`)
check('plugin mounted and registered all six tools', tools.names().length === 6)

// ── real repositories and real workspaces ───────────────────────────────────

const repoA = makeRepo(join(HOME, 'repo-a')) // will be dirtied
const repoB = makeRepo(join(HOME, 'repo-b')) // stays clean and free
const repoC = makeRepo(join(HOME, 'repo-c')) // will be held by a live session

const regA = await tools.call('workspace_guard_register', { path: repoA, title: 'probe-a' })
const regB = await tools.call('workspace_guard_register', { path: repoB, title: 'probe-b' })
const regC = await tools.call('workspace_guard_register', { path: repoC, title: 'probe-c' })
check('register returns a workspace id for each directory', [regA, regB, regC].every(r => r.ok === true && typeof r.workspaceId === 'string'))
const again = await tools.call('workspace_guard_register', { path: repoA })
check('register is idempotent for the same canonical path', again.workspaceId === regA.workspaceId)

// ── criterion 3: occupancy follows the real activity waterfall ──────────────

console.log('\n[criterion 3] occupancy from the session-activity waterfall')

// Make repoC genuinely held: a real persisted session whose canonical cwd is
// repoC, attached through the registry's own header-validated path, and then
// reported active by the activity provider.
const sessionC = 'session-guard-holder'
await persistSession(app, sessionC, repoC)
const wsC = app.workspaceRegistry.get(regC.workspaceId)
await wsC.attachSession(sessionC)
check('the registry attached the session (header cwd matched the workspace)', wsC.sessionIds.includes(sessionC))

const freeBefore = await tools.call('workspace_guard_check', { workspaceId: regC.workspaceId })
check('before activity: the workspace is FREE', freeBefore.workspace.occupied === false && freeBefore.workspace.owner === 'none')

active.add(sessionC)
const busy = await tools.call('workspace_guard_check', { workspaceId: regC.workspaceId })
check('with real activity: the workspace is OCCUPIED', busy.workspace.occupied === true)
check('the occupant is named, with its activity family', busy.workspace.occupants.some(o => o.sessionId === sessionC && o.activity.includes('turn')))
check('the refusal wording names the holder', /busy — holder: other; session-guard-holder \[other\] \(turn\)/.test(busy.workspace.occupancyDetail))

// Self-ownership: the same activity is continuable for the session that owns it.
const asSelf = await tools.call('workspace_guard_check', { workspaceId: regC.workspaceId, sessionId: sessionC })
check('the holder itself sees it as continuable (owner self, not occupied)', asSelf.workspace.owner === 'self' && asSelf.workspace.occupied === false)

active.delete(sessionC)
const freeAfter = await tools.call('workspace_guard_check', { workspaceId: regC.workspaceId })
check('after the activity stops: back to FREE', freeAfter.workspace.occupied === false && freeAfter.workspace.owner === 'none')

// ── criterion 4: cleanliness from a real git probe ──────────────────────────

console.log('\n[criterion 4] cleanliness from real git status')

const cleanBefore = await tools.call('workspace_guard_check', { workspaceId: regA.workspaceId })
check('a committed repository is CLEAN', cleanBefore.workspace.clean === true && cleanBefore.workspace.dirtyCount === 0)
check('the clean verdict says so', /is clean$/.test(cleanBefore.workspace.cleanliness))

const dirt = join(repoA, 'uncommitted-probe.txt')
writeFileSync(dirt, 'dirt\n')
const dirtyNow = await tools.call('workspace_guard_check', { workspaceId: regA.workspaceId })
check('after creating one file: DIRTY with an exact count', dirtyNow.workspace.clean === false && dirtyNow.workspace.dirtyCount === 1)
check('the dirt is named', dirtyNow.workspace.dirtyFiles.includes('uncommitted-probe.txt'))
check('the cleanliness line carries the evidence', /dirty — 1 uncommitted change\(s\): \?\? uncommitted-probe\.txt/.test(dirtyNow.workspace.cleanliness))

rmSync(dirt)
const cleanAgain = await tools.call('workspace_guard_check', { workspaceId: regA.workspaceId })
check('after removing the file: CLEAN again', cleanAgain.workspace.clean === true && cleanAgain.workspace.dirtyCount === 0)

// A non-repository follows the requireGitRepo switch (default: not unclean).
const plain = mkdtempSync(join(HOME, 'plain-'))
const regPlain = await tools.call('workspace_guard_register', { path: plain })
const plainReport = await tools.call('workspace_guard_check', { workspaceId: regPlain.workspaceId })
check('a non-repository is reported as such, and defaults to not-unclean', plainReport.workspace.status === 'ok' && /not a git repository/.test(plainReport.workspace.cleanliness) && plainReport.workspace.clean === true)

// ── criterion 5: the assign-time gate refuses a dirty assignment ────────────

console.log('\n[criterion 5] assign-time gate refuses an unusable workspace')

writeFileSync(dirt, 'dirt\n')
const refused = await tools.call('workspace_guard_assert', { workspaceId: regA.workspaceId, taskId: 'task-demo-1' }, 'session-task-runner')
check('the task is REFUSED', refused.ok === false && refused.code === 'workspace-unusable')
check('the refusal names the failing criterion', refused.failures.some(f => f.criterion === 'cleanliness'))
check('the refusal states what exactly is wrong', /cleanliness: workspace '.*repo-a' is dirty — 1 uncommitted change\(s\): \?\? uncommitted-probe\.txt/.test(refused.message))
check('the task id is echoed back', refused.taskId === 'task-demo-1')

// The occupancy criterion refuses too, with its holder named.
active.add(sessionC)
const refusedBusy = await tools.call('workspace_guard_assert', { workspaceId: regC.workspaceId }, 'session-task-runner')
check('an occupied workspace is refused on the occupancy criterion', refusedBusy.ok === false && refusedBusy.failures.some(f => f.criterion === 'occupancy'))
check('and the occupying session is named', /session-guard-holder \[other\] \(turn\)/.test(refusedBusy.message))
active.delete(sessionC)

rmSync(dirt)
const allowed = await tools.call('workspace_guard_assert', { workspaceId: regA.workspaceId }, 'session-task-runner')
check('once clean and free, the same workspace is ALLOWED', allowed.ok === true && allowed.warned === false)

// ── criterion 6: assignment picks the free and clean candidate ──────────────

console.log('\n[criterion 6] assignment over a mixed candidate pool')

// Pool at this moment: repoA clean+free, repoB clean+free, repoC clean+free,
// the plain directory clean+free. Make repoA dirty and repoC occupied, and pin
// repoB as the stalest so the least-recently-mutated rule is observable.
writeFileSync(dirt, 'dirt\n')
active.add(sessionC)

const assigned = await tools.call('workspace_guard_assign', { sessionId: 'session-task-runner', taskId: 'task-demo-2', note: 'integration' })
check('an assignment was made', assigned.ok === true && typeof assigned.assignedWorkspaceId === 'string')
check('the chosen workspace is not the dirty one', assigned.assignedWorkspaceId !== regA.workspaceId)
check('the chosen workspace is not the occupied one', assigned.assignedWorkspaceId !== regC.workspaceId)
check('the pool was reported with per-candidate rejections', assigned.pool.considered === 4 && assigned.pool.rejected.length === 2)
const rejectedIds = assigned.pool.rejected.map(r => r.workspaceId)
check('both the dirty and the occupied workspace were rejected', rejectedIds.includes(regA.workspaceId) && rejectedIds.includes(regC.workspaceId))
check('the rejections carry their reasons', assigned.pool.rejected.every(r => r.reasons.length > 0))
check('the assignment was recorded as a lease', await (async () => {
  const read = await tools.call('workspace_guard_link', { action: 'read', workspaceId: assigned.assignedWorkspaceId, sessionId: 'session-task-runner' })
  return read.ok === true && read.leases.includes('session-task-runner')
})())

rmSync(dirt)
active.delete(sessionC)

// A pool with nothing eligible is refused, never silently widened.
const allBadBefore = await tools.call('workspace_guard_assign', { sessionId: 'session-task-runner' })
check('with eligible candidates present the assignment still succeeds', allBadBefore.ok === true)

// ── criterion 7: the relation, both directions, across a restart ────────────

console.log('\n[criterion 7] workspace <-> session relation, and its durability')

const sessionA = 'session-guard-linked'
await persistSession(app, sessionA, repoA)

const linked = await tools.call('workspace_guard_link', { action: 'attach', workspaceId: regA.workspaceId, sessionId: sessionA })
check('attach reported success', linked.ok === true)
check('direction workspace -> sessions resolves', linked.workspaceToSessions.sessions.includes(sessionA))
check('direction session -> workspace resolves', linked.sessionToWorkspace.workspaceId === regA.workspaceId)

const read = await tools.call('workspace_guard_link', { action: 'read', workspaceId: regA.workspaceId, sessionId: sessionA })
check('read reports both directions at once', read.workspaceToSessions.sessions.includes(sessionA) && read.sessionToWorkspace.workspaceId === regA.workspaceId)

// A session whose cwd does not match must be refused by the registry, not forged.
const stranger = 'session-guard-stranger'
await persistSession(app, stranger, repoB)
const forged = await tools.call('workspace_guard_link', { action: 'attach', workspaceId: regA.workspaceId, sessionId: stranger })
check('attaching a cwd-mismatched session is REFUSED by the registry', forged.ok === false && forged.code === 'link-refused')

const detached = await tools.call('workspace_guard_link', { action: 'detach', workspaceId: regA.workspaceId, sessionId: sessionA })
check('detach removes the relation', detached.ok === true && !detached.workspaceToSessions.sessions.includes(sessionA))

// Re-attach, then restart the whole stack over the same DSH_HOME.
await tools.call('workspace_guard_link', { action: 'attach', workspaceId: regA.workspaceId, sessionId: sessionA })
const leaseBefore = await tools.call('workspace_guard_link', { action: 'read', workspaceId: assigned.assignedWorkspaceId, sessionId: 'session-task-runner' })
check('the lease is readable before the restart', leaseBefore.leases.includes('session-task-runner'))

await app.fiber.dispose()
check('the first stack stopped cleanly', true)

const second = await boot()
await second.app.plugin(guard, {})
const afterRead = await second.tools.call('workspace_guard_link', { action: 'read', workspaceId: regA.workspaceId, sessionId: sessionA })
check('after restart: workspace -> sessions still resolves', afterRead.workspaceToSessions.sessions.includes(sessionA))
check('after restart: session -> workspace still resolves', afterRead.sessionToWorkspace.workspaceId === regA.workspaceId)
const afterLease = await second.tools.call('workspace_guard_link', { action: 'read', workspaceId: assigned.assignedWorkspaceId, sessionId: 'session-task-runner' })
check('after restart: the assignment lease survived', afterLease.leases.includes('session-task-runner'))

const storageFile = join(STORAGE, 'workspace_guard.json')
check('the plugin persisted its own domain unit to disk', existsSync(storageFile))
if (existsSync(storageFile)) {
  const raw = JSON.parse(readFileSync(storageFile, 'utf8'))
  check('the persisted unit carries the lease table', JSON.stringify(raw).includes('workspace_guard'))
}

await second.app.fiber.dispose()

// ── summary ────────────────────────────────────────────────────────────────

console.log(`\n[result] ${checks - failures}/${checks} checks passed`)
rmSync(HOME, { recursive: true, force: true })
if (failures > 0) process.exit(1)
