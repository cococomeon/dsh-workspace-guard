/**
 * Unit tests for the pure judgment core.
 *
 * These import the TypeScript source directly (Node 24 strips the types), so
 * the verdicts are exercised without a build, a Host, or a live workspace. That
 * is the payoff of keeping `core/verdict.ts` IO-free: every branch below is a
 * plain function call.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  UNCOMMITTED_HOLDER,
  checkAssignment,
  describeCleanliness,
  describeOccupancy,
  judgeCleanliness,
  judgeOccupancy,
  orderCandidates,
  porcelainPath,
  rejectionReasons,
  selectWorkspace,
  withGitDirtyOccupancy,
} from '../src/core/verdict.ts'

// ── fixtures ────────────────────────────────────────────────────────────────

const CLEAN = { clean: true, state: 'clean', dirtyCount: 0, files: [], samples: [] }
const DIRTY = {
  clean: false,
  state: 'dirty',
  dirtyCount: 2,
  files: ['src/a.ts', 'src/b.ts'],
  samples: [' M src/a.ts', '?? src/b.ts'],
}
const FREE = { occupied: false, owner: 'none', occupants: [] }

/** One candidate with every default overridable. */
function candidate(overrides = {}) {
  return {
    workspaceId: 'ws-1',
    path: '/tmp/ws-1',
    title: 'ws-1',
    status: 'ok',
    occupancy: FREE,
    cleanliness: CLEAN,
    updatedAt: '2026-01-01T00:00:00.000Z',
    leasedBy: [],
    ...overrides,
  }
}

// ── occupancy ───────────────────────────────────────────────────────────────

test('occupancy: an idle member is free', () => {
  const verdict = judgeOccupancy({
    workspaceId: 'ws-1',
    path: '/tmp/ws-1',
    members: ['s1'],
    activity: [{ sessionId: 's1', kinds: [] }],
    selfOwnership: true,
  })
  assert.equal(verdict.occupied, false)
  assert.equal(verdict.owner, 'none')
  assert.deepEqual(verdict.occupants, [])
})

test('occupancy: a running turn by another session is a conflict', () => {
  const verdict = judgeOccupancy({
    workspaceId: 'ws-1',
    path: '/tmp/ws-1',
    members: ['s1', 's2'],
    activity: [
      { sessionId: 's1', kinds: ['turn'] },
      { sessionId: 's2', kinds: [] },
    ],
    requesterSessionId: 's2',
    selfOwnership: true,
  })
  assert.equal(verdict.occupied, true)
  assert.equal(verdict.owner, 'other')
  assert.deepEqual(verdict.occupants, [{ sessionId: 's1', kinds: ['turn'], relation: 'other' }])
})

test('occupancy: the requester\'s own activity is continuable when selfOwnership is on', () => {
  const verdict = judgeOccupancy({
    workspaceId: 'ws-1',
    path: '/tmp/ws-1',
    members: ['s1'],
    activity: [{ sessionId: 's1', kinds: ['turn', 'job'] }],
    requesterSessionId: 's1',
    selfOwnership: true,
  })
  assert.equal(verdict.occupied, false, 'its own residual state must not block a re-run')
  assert.equal(verdict.owner, 'self', 'the holder is still named')
  assert.deepEqual(verdict.occupants, [{ sessionId: 's1', kinds: ['turn', 'job'], relation: 'self' }])
})

test('occupancy: with selfOwnership off the requester blocks itself', () => {
  const verdict = judgeOccupancy({
    workspaceId: 'ws-1',
    path: '/tmp/ws-1',
    members: ['s1'],
    activity: [{ sessionId: 's1', kinds: ['turn'] }],
    requesterSessionId: 's1',
    selfOwnership: false,
  })
  assert.equal(verdict.occupied, true)
  assert.equal(verdict.owner, 'self')
})

test('occupancy: another holder outranks the requester in a shared workspace', () => {
  const verdict = judgeOccupancy({
    workspaceId: 'ws-1',
    path: '/tmp/ws-1',
    members: ['s1', 's2'],
    activity: [
      { sessionId: 's1', kinds: ['turn'] },
      { sessionId: 's2', kinds: ['turn'] },
    ],
    requesterSessionId: 's1',
    selfOwnership: true,
  })
  assert.equal(verdict.occupied, true, 'a shared workspace is a conflict even for a self-holder')
  assert.equal(verdict.owner, 'other')
})

test('occupancy: activity from a non-member is not attributed to this workspace', () => {
  const verdict = judgeOccupancy({
    workspaceId: 'ws-1',
    path: '/tmp/ws-1',
    members: ['s1'],
    activity: [{ sessionId: 'stranger', kinds: ['turn'] }],
    selfOwnership: true,
  })
  assert.equal(verdict.occupied, false)
  assert.equal(verdict.owner, 'none')
})

test('occupancy: uncommitted work counts as a holder only when enabled', () => {
  const base = judgeOccupancy({
    workspaceId: 'ws-1',
    path: '/tmp/ws-1',
    members: [],
    activity: [],
    selfOwnership: true,
  })
  assert.equal(withGitDirtyOccupancy(base, 3, false).occupied, false)
  const augmented = withGitDirtyOccupancy(base, 3, true)
  assert.equal(augmented.occupied, true)
  assert.equal(augmented.owner, 'other')
  assert.equal(augmented.occupants[0].sessionId, UNCOMMITTED_HOLDER)
  assert.equal(withGitDirtyOccupancy(base, 0, true).occupied, false, 'a clean workspace gains no holder')
})

// ── cleanliness ─────────────────────────────────────────────────────────────

test('cleanliness: a clean repository is clean', () => {
  const verdict = judgeCleanliness({
    path: '/tmp/ws-1',
    probe: { kind: 'repo', porcelain: [] },
    requireGitRepo: false,
    refuseOnProbeError: true,
  })
  assert.equal(verdict.clean, true)
  assert.equal(verdict.state, 'clean')
  assert.equal(verdict.dirtyCount, 0)
})

test('cleanliness: porcelain lines are the dirt, with paths and evidence', () => {
  const verdict = judgeCleanliness({
    path: '/tmp/ws-1',
    probe: { kind: 'repo', porcelain: [' M src/a.ts', '?? src/b.ts', 'R  old.ts -> new.ts'] },
    requireGitRepo: false,
    refuseOnProbeError: true,
  })
  assert.equal(verdict.clean, false)
  assert.equal(verdict.state, 'dirty')
  assert.equal(verdict.dirtyCount, 3)
  assert.deepEqual(verdict.files, ['src/a.ts', 'src/b.ts', 'new.ts'])
})

test('cleanliness: only the first ten porcelain lines are carried as evidence', () => {
  const porcelain = Array.from({ length: 25 }, (_, index) => ` M f${index}.ts`)
  const verdict = judgeCleanliness({ path: '/tmp/ws-1', probe: { kind: 'repo', porcelain }, requireGitRepo: false, refuseOnProbeError: true })
  assert.equal(verdict.dirtyCount, 25, 'the count is exact')
  assert.equal(verdict.files.length, 25)
  assert.equal(verdict.samples.length, 10, 'the evidence is bounded')
})

test('cleanliness: a non-repository follows requireGitRepo', () => {
  const lenient = judgeCleanliness({ path: '/tmp/ws-1', probe: { kind: 'not-a-repo' }, requireGitRepo: false, refuseOnProbeError: true })
  assert.equal(lenient.clean, true)
  assert.equal(lenient.state, 'not-a-repo')
  const strict = judgeCleanliness({ path: '/tmp/ws-1', probe: { kind: 'not-a-repo' }, requireGitRepo: true, refuseOnProbeError: true })
  assert.equal(strict.clean, false, 'a non-repository cannot be known clean')
})

test('cleanliness: a failed probe fails closed by default and open when told to', () => {
  const closed = judgeCleanliness({ path: '/tmp/ws-1', probe: { kind: 'error', message: 'git missing' }, requireGitRepo: false, refuseOnProbeError: true })
  assert.equal(closed.clean, false)
  assert.equal(closed.state, 'unknown')
  assert.match(closed.samples.join(' '), /git missing/)
  const open = judgeCleanliness({ path: '/tmp/ws-1', probe: { kind: 'error', message: 'git missing' }, requireGitRepo: false, refuseOnProbeError: false })
  assert.equal(open.clean, true)
})

test('porcelainPath: parses modified, untracked, renamed and quoted lines', () => {
  assert.equal(porcelainPath(' M src/a.ts'), 'src/a.ts')
  assert.equal(porcelainPath('?? src/b.ts'), 'src/b.ts')
  assert.equal(porcelainPath('R  old.ts -> new.ts'), 'new.ts')
  assert.equal(porcelainPath('A  "dir with space/f.ts"'), '"dir with space/f.ts"')
  assert.equal(porcelainPath('??'), '')
})

// ── assignment selection ────────────────────────────────────────────────────

test('assign: picks the only free and clean candidate', () => {
  const verdict = selectWorkspace({
    candidates: [
      candidate({ workspaceId: 'busy', occupancy: { occupied: true, owner: 'other', occupants: [{ sessionId: 's9', kinds: ['turn'], relation: 'other' }] } }),
      candidate({ workspaceId: 'good' }),
      candidate({ workspaceId: 'dirty', cleanliness: DIRTY }),
    ],
    allowUnclean: false,
  })
  assert.equal(verdict.assigned?.workspaceId, 'good')
  assert.equal(verdict.rejections.length, 2)
  const byId = new Map(verdict.rejections.map(item => [item.workspaceId, item]))
  assert.match(byId.get('busy').reasons.join(' '), /occupancy: .*busy — holder: other; s9/)
  assert.match(byId.get('dirty').reasons.join(' '), /cleanliness: .*dirty — 2 uncommitted change/)
})

test('assign: least recently mutated wins', () => {
  const verdict = selectWorkspace({
    candidates: [
      candidate({ workspaceId: 'recent', updatedAt: '2026-06-01T00:00:00.000Z' }),
      candidate({ workspaceId: 'oldest', updatedAt: '2026-01-01T00:00:00.000Z' }),
      candidate({ workspaceId: 'middle', updatedAt: '2026-03-01T00:00:00.000Z' }),
    ],
    allowUnclean: false,
  })
  assert.equal(verdict.assigned?.workspaceId, 'oldest')
})

test('assign: workspace id breaks an exact updatedAt tie deterministically', () => {
  const ordered = orderCandidates([
    candidate({ workspaceId: 'b', updatedAt: '2026-01-01T00:00:00.000Z' }),
    candidate({ workspaceId: 'a', updatedAt: '2026-01-01T00:00:00.000Z' }),
  ])
  assert.deepEqual(ordered.map(item => item.workspaceId), ['a', 'b'])
})

test('assign: eligibility follows the occupancy verdict the host already computed', () => {
  // `selfOwnership` decides whether the requester's own activity is continuable,
  // and that decision is already folded into `occupied` before selection runs —
  // so there is no second switch here that could disagree with it.
  const continuable = candidate({
    workspaceId: 'mine',
    occupancy: { occupied: false, owner: 'self', occupants: [{ sessionId: 'me', kinds: ['turn'], relation: 'self' }] },
  })
  const foreign = candidate({
    workspaceId: 'theirs',
    occupancy: { occupied: true, owner: 'other', occupants: [{ sessionId: 'them', kinds: ['turn'], relation: 'other' }] },
  })
  const verdict = selectWorkspace({ candidates: [continuable, foreign], allowUnclean: false })
  assert.equal(verdict.assigned?.workspaceId, 'mine', 'a verdict of "free" is assignable whatever the holder')
  assert.equal(verdict.rejections.length, 1)

  // The same workspace judged with selfOwnership off: occupied, so it is out.
  const strict = selectWorkspace({
    candidates: [
      candidate({
        workspaceId: 'mine',
        occupancy: { occupied: true, owner: 'self', occupants: [{ sessionId: 'me', kinds: ['turn'], relation: 'self' }] },
      }),
    ],
    allowUnclean: false,
  })
  assert.equal(strict.assigned, undefined)
  assert.match(strict.rejections[0].reasons.join(' '), /holder: self; me \[self\] \(turn\)/)
})

test('assign: an empty pool is a refusal that names every candidate, never a silent fallback', () => {
  const verdict = selectWorkspace({
    candidates: [candidate({ workspaceId: 'dirty', cleanliness: DIRTY })],
    allowUnclean: false,
  })
  assert.equal(verdict.assigned, undefined)
  assert.equal(verdict.rejections[0].workspaceId, 'dirty')
  assert.ok(verdict.rejections[0].reasons.length > 0)
})

test('assign: a missing directory is rejected on the directory criterion', () => {
  const reasons = rejectionReasons(candidate({ status: 'missing-dir' }), { candidates: [], allowUnclean: false })
  assert.match(reasons.join(' '), /directory: .*directory is missing/)
})

test('assign: allowUnclean admits a dirty workspace and records why it was admitted', () => {
  const verdict = selectWorkspace({
    candidates: [candidate({ workspaceId: 'dirty', cleanliness: DIRTY })],
    allowUnclean: true,
  })
  assert.equal(verdict.assigned?.workspaceId, 'dirty')
  assert.equal(verdict.rejections.length, 0)
})

// ── assign-time gate ────────────────────────────────────────────────────────

test('gate: a free and clean workspace is allowed', () => {
  const verdict = checkAssignment({
    workspaceId: 'ws-1',
    path: '/tmp/ws-1',
    occupancy: FREE,
    cleanliness: CLEAN,
    onBlocked: 'refuse',
  })
  assert.equal(verdict.allowed, true)
  assert.equal(verdict.warned, false)
  assert.deepEqual(verdict.failures, [])
})

test('gate: refuse names each failed criterion and its holder', () => {
  const verdict = checkAssignment({
    workspaceId: 'ws-1',
    path: '/tmp/ws-1',
    occupancy: { occupied: true, owner: 'other', occupants: [{ sessionId: 's7', kinds: ['turn', 'job'], relation: 'other' }] },
    cleanliness: DIRTY,
    onBlocked: 'refuse',
  })
  assert.equal(verdict.allowed, false)
  assert.deepEqual(verdict.failures.map(item => item.criterion), ['occupancy', 'cleanliness'])
  assert.match(verdict.messages[0], /occupancy: .*holder: other; s7 \[other\] \(turn, job\)/)
  assert.match(verdict.messages[1], /cleanliness: .*2 uncommitted change\(s\):  M src\/a\.ts \| \?\? src\/b\.ts/)
})

test('gate: warn lets it through but still reports every failure', () => {
  const verdict = checkAssignment({
    workspaceId: 'ws-1',
    path: '/tmp/ws-1',
    occupancy: FREE,
    cleanliness: DIRTY,
    onBlocked: 'warn',
  })
  assert.equal(verdict.allowed, true)
  assert.equal(verdict.warned, true)
  assert.equal(verdict.failures.length, 1)
  assert.equal(verdict.failures[0].criterion, 'cleanliness')
})

test('gate: caller-supplied failures join the verdict', () => {
  const verdict = checkAssignment({
    workspaceId: 'ws-1',
    path: '/tmp/ws-1',
    occupancy: FREE,
    cleanliness: CLEAN,
    onBlocked: 'refuse',
    extraFailures: [{ criterion: 'directory', message: 'directory: gone' }],
  })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.failures[0].criterion, 'directory')
})

// ── wording ─────────────────────────────────────────────────────────────────

test('wording: describeOccupancy names the holder and the activity families', () => {
  const busy = describeOccupancy('/tmp/ws-1', {
    occupied: true,
    owner: 'other',
    occupants: [{ sessionId: 's3', kinds: ['schedule'], relation: 'other' }],
  })
  assert.match(busy, /workspace '\/tmp\/ws-1' is busy — holder: other; s3 \[other\] \(schedule\)/)
  assert.equal(describeOccupancy('/tmp/ws-1', FREE), "occupancy: workspace '/tmp/ws-1' is free")
})

test('wording: describeCleanliness reports the count and the paths', () => {
  assert.equal(describeCleanliness('/tmp/ws-1', CLEAN), "cleanliness: workspace '/tmp/ws-1' is clean")
  assert.match(describeCleanliness('/tmp/ws-1', DIRTY), /2 uncommitted change\(s\)/)
})
