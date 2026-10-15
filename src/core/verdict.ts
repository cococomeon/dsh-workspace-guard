/**
 * Pure judgment core: occupancy, cleanliness, assignment selection and the
 * assign-time gate.
 *
 * Every function here is total, synchronous and IO-free. The probe layer
 * (`src/host/probe.ts`) gathers facts — registry membership, session activity,
 * git porcelain — and this module decides. That split is the whole point: the
 * four verdicts are unit-testable without a live Host, and the refusal wording
 * lives in one place so the tools and the tests cannot drift.
 *
 * @module dsh-workspace-guard/core/verdict
 */

/** How many porcelain lines a verdict carries as evidence. */
export const MAX_SAMPLES = 10

// ── occupancy ───────────────────────────────────────────────────────────────

/** Activity kinds one session reports, as the probe observed them. */
export interface ActivitySample {
  /** The session that was asked about. */
  readonly sessionId: string
  /** The activity families that answered non-empty; empty means idle. */
  readonly kinds: readonly string[]
}

/** Everything the occupancy verdict is allowed to depend on. */
export interface OccupancyInput {
  /** Workspace record id. */
  readonly workspaceId: string
  /** Canonical workspace directory. */
  readonly path: string
  /**
   * Header-validated members of this workspace, in registry order. A workspace
   * session account is the registry's own answer to "whose canonical cwd is
   * this directory", so it is the membership set occupancy is judged over.
   */
  readonly members: readonly string[]
  /** Activity for every session the probe asked about. */
  readonly activity: readonly ActivitySample[]
  /** The session asking; its own activity is judged separably. */
  readonly requesterSessionId?: string
  /** Whether the requester's own activity is continuable or a conflict. */
  readonly selfOwnership: boolean
}

/** One session currently holding a workspace. */
export interface Occupant {
  /** Holding session id. */
  readonly sessionId: string
  /** Activity families it holds the workspace with. */
  readonly kinds: readonly string[]
  /** Whether this is the requesting session. */
  readonly relation: 'self' | 'other'
}

/** The occupancy answer for one workspace. */
export interface OccupancyVerdict {
  /** Whether this workspace blocks a new claim by the requester. */
  readonly occupied: boolean
  /** Who holds it: `other` outranks `self` because a shared workspace is a conflict. */
  readonly owner: 'none' | 'self' | 'other'
  /** Every holder, in the order the probe reported them. */
  readonly occupants: readonly Occupant[]
}

/**
 * Judge whether a workspace is occupied.
 *
 * Membership is checked, not just activity: an activity sample for a session
 * that is not a member of this workspace is some other directory's problem, so
 * it is dropped rather than attributed here. That keeps the verdict bound to
 * the registry's own membership answer.
 *
 * `occupied` means "this blocks the requester", while `owner` means "who holds
 * it" — the two differ when `selfOwnership` is off and only the requester is
 * active: the workspace is busy but the holder is still the requester.
 *
 * @param input - the observed facts.
 * @returns the occupancy verdict.
 */
export function judgeOccupancy(input: OccupancyInput): OccupancyVerdict {
  const members = new Set(input.members)
  const occupants: Occupant[] = []
  for (const sample of input.activity) {
    if (sample.kinds.length === 0) continue
    if (!members.has(sample.sessionId)) continue
    occupants.push({
      sessionId: sample.sessionId,
      kinds: [...sample.kinds],
      relation: input.requesterSessionId === sample.sessionId ? 'self' : 'other',
    })
  }
  const others = occupants.filter(item => item.relation === 'other')
  const selves = occupants.filter(item => item.relation === 'self')
  const owner: OccupancyVerdict['owner'] = others.length > 0 ? 'other' : selves.length > 0 ? 'self' : 'none'
  // Only others block when self-ownership is continuable; with the switch off,
  // the requester's own residual turn blocks a re-run like anyone else's.
  const blocking = input.selfOwnership ? others : occupants
  return { occupied: blocking.length > 0, owner, occupants }
}

/**
 * The synthetic holder id used when uncommitted work counts as occupancy.
 *
 * Uncommitted changes have no owning session, so they cannot be attributed to
 * a real one. Giving them their own id keeps the occupant list honest: a reader
 * sees that the workspace is held, and by what, without the plugin inventing a
 * session that does not exist.
 */
export const UNCOMMITTED_HOLDER = '<uncommitted-changes>'

/**
 * Fold uncommitted work into an occupancy verdict.
 *
 * Off by default: dirtiness is already its own criterion, so counting it twice
 * only matters for operators who want a dirty workspace to read as *held* —
 * for instance to keep an assigner that ignores cleanliness from landing on it.
 *
 * @param verdict - the activity-derived verdict.
 * @param dirtyCount - uncommitted change count for the same workspace.
 * @param enabled - whether the operator asked for this.
 * @returns the verdict, augmented when it applies.
 */
export function withGitDirtyOccupancy(verdict: OccupancyVerdict, dirtyCount: number, enabled: boolean): OccupancyVerdict {
  if (!enabled || dirtyCount === 0) return verdict
  if (verdict.occupants.some(item => item.sessionId === UNCOMMITTED_HOLDER)) return verdict
  return {
    occupied: true,
    owner: 'other',
    occupants: [...verdict.occupants, { sessionId: UNCOMMITTED_HOLDER, kinds: ['git-dirty'], relation: 'other' }],
  }
}

// ── cleanliness ─────────────────────────────────────────────────────────────

/** What a git probe found, including the two ways it can fail to answer. */
export type GitProbe =
  | { readonly kind: 'repo'; readonly porcelain: readonly string[] }
  | { readonly kind: 'not-a-repo' }
  | { readonly kind: 'error'; readonly message: string }

/** The headline of a cleanliness verdict. */
export type CleanlinessState = 'clean' | 'dirty' | 'not-a-repo' | 'unknown'

/** Everything the cleanliness verdict is allowed to depend on. */
export interface CleanlinessInput {
  /** Canonical workspace directory. */
  readonly path: string
  /** What the git probe found. */
  readonly probe: GitProbe
  /** Treat a non-repository directory as unclean. */
  readonly requireGitRepo: boolean
  /** Treat an unanswerable probe as unclean (the fail-closed default). */
  readonly refuseOnProbeError: boolean
}

/** The cleanliness answer for one workspace. */
export interface CleanlinessVerdict {
  /** Whether this workspace may be claimed. */
  readonly clean: boolean
  /** Why, in one word. */
  readonly state: CleanlinessState
  /** Uncommitted change count. */
  readonly dirtyCount: number
  /** Every uncommitted path, in git's own order. */
  readonly files: readonly string[]
  /** The first {@link MAX_SAMPLES} raw porcelain lines, as evidence. */
  readonly samples: readonly string[]
}

/**
 * Extract the path from one `git status --porcelain` line.
 *
 * The format is `XY <path>` — two status columns, one space, then the path —
 * and a rename or copy reports `XY <old> -> <new>`, where the new path is the
 * one that exists now.
 *
 * @param line - one porcelain line.
 * @returns the path it names.
 */
export function porcelainPath(line: string): string {
  const rest = line.length > 3 ? line.slice(3) : ''
  const arrow = rest.indexOf(' -> ')
  return (arrow === -1 ? rest : rest.slice(arrow + 4)).trim()
}

/**
 * Judge whether a workspace is clean.
 *
 * A failed probe and a non-repository directory are refused by default: the
 * requirement is that a workspace is *known* clean before a task runs in it, so
 * "could not tell" fails closed unless the operator opts out.
 *
 * @param input - the observed facts.
 * @returns the cleanliness verdict.
 */
export function judgeCleanliness(input: CleanlinessInput): CleanlinessVerdict {
  const probe = input.probe
  if (probe.kind === 'error') {
    return {
      clean: !input.refuseOnProbeError,
      state: 'unknown',
      dirtyCount: 0,
      files: [],
      samples: [`probe failed: ${probe.message}`],
    }
  }
  if (probe.kind === 'not-a-repo') {
    return {
      clean: !input.requireGitRepo,
      state: 'not-a-repo',
      dirtyCount: 0,
      files: [],
      samples: [],
    }
  }
  const dirty = probe.porcelain.length > 0
  return {
    clean: !dirty,
    state: dirty ? 'dirty' : 'clean',
    dirtyCount: probe.porcelain.length,
    files: probe.porcelain.map(porcelainPath).filter(item => item !== ''),
    samples: probe.porcelain.slice(0, MAX_SAMPLES),
  }
}

// ── assignment selection ────────────────────────────────────────────────────

/** One assignable workspace, with both verdicts already computed. */
export interface Candidate {
  /** Workspace record id. */
  readonly workspaceId: string
  /** Canonical directory. */
  readonly path: string
  /** Display title. */
  readonly title: string
  /** Live directory check from the registry. */
  readonly status: 'ok' | 'missing-dir'
  /** Its occupancy verdict. */
  readonly occupancy: OccupancyVerdict
  /** Its cleanliness verdict. */
  readonly cleanliness: CleanlinessVerdict
  /** ISO instant of the last durable registry mutation; the tie-break key. */
  readonly updatedAt: string
  /** Sessions this plugin holds a lease for on this workspace. */
  readonly leasedBy: readonly string[]
}

/** Everything the assignment verdict is allowed to depend on. */
export interface AssignmentInput {
  /** The candidate pool, already reduced to registry workspaces. */
  readonly candidates: readonly Candidate[]
  /**
   * Allow a candidate that is not known clean.
   *
   * There is deliberately no matching `allowSelfOwned` switch: whether a
   * workspace the requester itself holds counts as occupied is the occupancy
   * policy's decision, and it is already baked into `Candidate.occupancy` by
   * the time selection runs. A second switch here could only disagree with it.
   */
  readonly allowUnclean: boolean
}

/** Why one candidate lost. */
export interface CandidateRejection {
  /** Workspace record id. */
  readonly workspaceId: string
  /** Canonical directory. */
  readonly path: string
  /** Every criterion it failed, in criterion order. */
  readonly reasons: readonly string[]
}

/** The assignment answer: at most one winner, plus the full losing field. */
export interface AssignmentVerdict {
  /** The chosen workspace, absent when the pool had no eligible candidate. */
  readonly assigned?: Candidate
  /** Every losing candidate with its reasons. */
  readonly rejections: readonly CandidateRejection[]
}

/**
 * Order candidates for assignment: least recently mutated first.
 *
 * The registry stamps `updatedAt` on every durable mutation, so the oldest
 * record is the workspace no one has touched for the longest — spreading new
 * work away from whatever was just used. Workspace id breaks exact ties so the
 * choice is deterministic rather than dependent on Map order.
 *
 * @param candidates - eligible candidates.
 * @returns a new, sorted array.
 */
export function orderCandidates(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? -1 : 1
    return left.workspaceId < right.workspaceId ? -1 : 1
  })
}

/**
 * Collect every reason a candidate cannot be assigned.
 *
 * @param candidate - the candidate.
 * @param input - the assignment request.
 * @returns the reasons; empty means assignable.
 */
export function rejectionReasons(candidate: Candidate, input: AssignmentInput): string[] {
  const reasons: string[] = []
  if (candidate.status !== 'ok') {
    reasons.push(`directory: workspace '${candidate.path}' is registered but its directory is missing`)
  }
  if (candidate.occupancy.occupied) {
    reasons.push(describeOccupancy(candidate.path, candidate.occupancy))
  }
  if (!candidate.cleanliness.clean && !input.allowUnclean) {
    reasons.push(describeCleanliness(candidate.path, candidate.cleanliness))
  }
  return reasons
}

/**
 * Pick a workspace for a task.
 *
 * @param input - the candidate pool and the caller's tolerances.
 * @returns the winner and every rejection.
 */
export function selectWorkspace(input: AssignmentInput): AssignmentVerdict {
  const rejections: CandidateRejection[] = []
  const eligible: Candidate[] = []
  for (const candidate of input.candidates) {
    const reasons = rejectionReasons(candidate, input)
    if (reasons.length === 0) eligible.push(candidate)
    else rejections.push({ workspaceId: candidate.workspaceId, path: candidate.path, reasons })
  }
  const ordered = orderCandidates(eligible)
  const assigned = ordered[0]
  return { ...(assigned === undefined ? {} : { assigned }), rejections }
}

// ── assign-time gate ────────────────────────────────────────────────────────

/** Which gate a refusal came from. */
export type Criterion = 'occupancy' | 'cleanliness' | 'directory'

/** One failed criterion, carrying its own explanation. */
export interface CriterionFailure {
  /** The gate that failed. */
  readonly criterion: Criterion
  /** What failed and by whom, ready to hand to a model. */
  readonly message: string
}

/** Everything the assign-time gate is allowed to depend on. */
export interface AssignmentCheckInput {
  /** Workspace record id. */
  readonly workspaceId: string
  /** Canonical directory. */
  readonly path: string
  /** Its occupancy verdict. */
  readonly occupancy: OccupancyVerdict
  /** Its cleanliness verdict. */
  readonly cleanliness: CleanlinessVerdict
  /** What to do when a gate fails. */
  readonly onBlocked: 'refuse' | 'warn'
  /** Failures contributed by the caller (a missing directory, a foreign lease). */
  readonly extraFailures?: readonly CriterionFailure[]
}

/** The assign-time answer. */
export interface AssignmentCheckVerdict {
  /** Whether the task may proceed. */
  readonly allowed: boolean
  /** Whether it proceeds despite failed gates. */
  readonly warned: boolean
  /** Every failed gate. */
  readonly failures: readonly CriterionFailure[]
  /** The failure messages alone, in the same order. */
  readonly messages: readonly string[]
}

/**
 * Gate a task against the workspace it was assigned.
 *
 * The user's requirement is that an assigned workspace must be *known clean*
 * before the task runs, so the default is to refuse — and the refusal names
 * each failing criterion and its holder rather than saying "not clean".
 *
 * @param input - the observed facts and the caller's disposition.
 * @returns the gate verdict.
 */
export function checkAssignment(input: AssignmentCheckInput): AssignmentCheckVerdict {
  const failures: CriterionFailure[] = []
  if (input.occupancy.occupied) {
    failures.push({ criterion: 'occupancy', message: describeOccupancy(input.path, input.occupancy) })
  }
  if (!input.cleanliness.clean) {
    failures.push({ criterion: 'cleanliness', message: describeCleanliness(input.path, input.cleanliness) })
  }
  for (const extra of input.extraFailures ?? []) failures.push(extra)
  const blocked = failures.length > 0
  return {
    allowed: input.onBlocked === 'warn' ? true : !blocked,
    warned: input.onBlocked === 'warn' && blocked,
    failures,
    messages: failures.map(item => item.message),
  }
}

// ── refusal wording ─────────────────────────────────────────────────────────
// One home for the sentences a model reads when it is refused. Both the gate
// and the assignment report quote these, so the two never disagree.

/**
 * Explain an occupancy verdict, naming every holder.
 *
 * @param path - the workspace directory.
 * @param verdict - its occupancy verdict.
 * @returns a one-line explanation.
 */
export function describeOccupancy(path: string, verdict: OccupancyVerdict): string {
  const holders = verdict.occupants
    .map(item => `${item.sessionId} [${item.relation}] (${item.kinds.join(', ')})`)
    .join('; ')
  if (!verdict.occupied) {
    return holders === ''
      ? `occupancy: workspace '${path}' is free`
      : `occupancy: workspace '${path}' is free; this session's own activity only (${holders})`
  }
  return `occupancy: workspace '${path}' is busy — holder: ${verdict.owner}; ${holders}`
}

/**
 * Explain a cleanliness verdict, with the dirty evidence.
 *
 * @param path - the workspace directory.
 * @param verdict - its cleanliness verdict.
 * @returns a one-line explanation.
 */
export function describeCleanliness(path: string, verdict: CleanlinessVerdict): string {
  switch (verdict.state) {
    case 'clean':
      return `cleanliness: workspace '${path}' is clean`
    case 'dirty':
      return `cleanliness: workspace '${path}' is dirty — ${verdict.dirtyCount} uncommitted change(s): ${verdict.samples.join(' | ')}`
    case 'not-a-repo':
      return `cleanliness: workspace '${path}' is not a git repository`
    case 'unknown':
      return `cleanliness: workspace '${path}' could not be probed — ${verdict.samples.join(' | ')}`
  }
}
