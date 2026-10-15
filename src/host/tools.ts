/**
 * The model-facing tool surface.
 *
 * Four capabilities, five tools: the inventory and the single-workspace check
 * expose the two judgments, `assign` picks and records a workspace, `assert`
 * gates a task against the workspace it was assigned, and `link` records or
 * drops the workspace↔session relation through the registry that owns it.
 *
 * Every refusal is an `ok:false` value the model can act on, and every refusal
 * names the failing criterion and its holder — never a bare "not clean".
 *
 * @module dsh-workspace-guard/host/tools
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  checkAssignment,
  selectWorkspace,
  type Candidate,
} from '../core/verdict.ts'

/** Unconstrained JSON value the tools return. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** How many session ids a report lists before summarising the rest as a count. */
const MAX_LISTED_SESSIONS = 10

/** What one workspace looks like once every judgment has run. */
export interface WorkspaceReport {
  /** Workspace record id. */
  readonly workspaceId: string
  /** Canonical directory. */
  readonly path: string
  /** Display title. */
  readonly title: string
  /** ISO instant of the last durable registry mutation; the assignment tie-break. */
  readonly updatedAt: string
  /** Live directory check. */
  readonly status: 'ok' | 'missing-dir'
  /** Whether this workspace blocks a new claim. */
  readonly occupied: boolean
  /** Who holds it. */
  readonly owner: 'none' | 'self' | 'other'
  /** Every holder, with the activity families it holds with. */
  readonly occupants: readonly { sessionId: string; kinds: readonly string[]; relation: 'self' | 'other' }[]
  /** Whether it is known clean. */
  readonly clean: boolean
  /** The cleanliness headline. */
  readonly cleanliness: string
  /** Uncommitted change count. */
  readonly dirtyCount: number
  /** The uncommitted paths, capped at ten. */
  readonly dirtyFiles: readonly string[]
  /** The raw `git status --porcelain` lines, capped at ten: the exact evidence. */
  readonly dirtySamples: readonly string[]
  /** Header-validated sessions the registry accounts to this workspace. */
  readonly sessions: readonly string[]
  /** Sessions holding a live lease from this plugin. */
  readonly leasedBy: readonly string[]
  /** The registry's own one-line reasons, for a caller that wants the sentence. */
  readonly occupancyDetail: string
}

/** The Host face the tools drive; implemented in `src/index.ts`. */
export interface WorkspaceGuardHost {
  /** Judge every registered workspace from `requesterSessionId`'s point of view. */
  report(requesterSessionId?: string): Promise<WorkspaceReport[]>
  /** Judge one workspace by id. */
  reportOne(workspaceId: string, requesterSessionId?: string): Promise<WorkspaceReport | undefined>
  /** Current tolerances, re-read at call time so a config edit takes effect. */
  policy(): GuardPolicy
  /** Record a lease for one assignment. */
  recordLease(input: { workspaceId: string; sessionId: string; taskId?: string; note?: string; ttlMs: number }): Promise<void>
  /** Attach or detach a session in the registry that owns the relation. */
  link(input: { workspaceId: string; sessionId: string; action: 'attach' | 'detach' }): Promise<void>
  /** Which workspace the registry accounts one session to, if any. */
  workspaceOfSession(sessionId: string): Promise<string | undefined>
  /**
   * Register an existing directory as a workspace, or return the existing
   * record for it. Idempotent: the registry reuses a record for the same
   * canonical path.
   */
  register(input: { path: string; title?: string }): Promise<{ workspaceId: string; path: string; title: string }>
}

/** The operator-configurable tolerances, resolved fresh on every call. */
export interface GuardPolicy {
  /** Whether the requester's own activity counts as continuable. */
  readonly selfOwnership: boolean
  /** Whether a non-repository directory counts as unclean. */
  readonly requireGitRepo: boolean
  /** Whether an unanswerable git probe counts as unclean. */
  readonly refuseOnProbeError: boolean
  /** Whether a git-dirty workspace also counts as occupied. */
  readonly gitDirtyImpliesBusy: boolean
  /** What `assert` does when a gate fails. */
  readonly onBlocked: 'refuse' | 'warn'
  /** Lease lifetime in milliseconds. */
  readonly leaseTtlMs: number
}

/** Model-facing JSON rendering shared by every tool. */
function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** Mark an already JSON-safe projection as the tool's canonical value. */
function json(value: unknown): Json {
  return value as Json
}

/** A refusal the model is expected to read and act on. */
function refused(code: string, message: string, extra: Record<string, Json> = {}): Json {
  return json({ ok: false, code, message, ...extra })
}

/** One workspace as JSON, with the full evidence. */
function reportJson(report: WorkspaceReport): Json {
  return json({
    workspaceId: report.workspaceId,
    path: report.path,
    title: report.title,
    updatedAt: report.updatedAt,
    status: report.status,
    occupied: report.occupied,
    owner: report.owner,
    occupants: report.occupants.map(item => json({ sessionId: item.sessionId, relation: item.relation, activity: [...item.kinds] })),
    occupancyDetail: report.occupancyDetail,
    clean: report.clean,
    cleanliness: report.cleanliness,
    dirtyCount: report.dirtyCount,
    dirtyFiles: [...report.dirtyFiles],
    dirtySamples: [...report.dirtySamples],
    // Membership is capped like the dirt evidence: a long-lived workspace can
    // carry dozens of sessions, and every one of them in the payload would spend
    // a caller's context on ids it did not ask for. The exact count rides along.
    sessionCount: report.sessions.length,
    sessions: report.sessions.slice(0, MAX_LISTED_SESSIONS),
    leasedBy: [...report.leasedBy],
  })
}

/** Turn one report into an assignment candidate. */
function candidateOf(report: WorkspaceReport): Candidate {
  // The report already carries both verdicts in human form; the selector needs
  // them structurally, so they are rebuilt rather than re-probed.
  return {
    workspaceId: report.workspaceId,
    path: report.path,
    title: report.title,
    status: report.status,
    occupancy: {
      occupied: report.occupied,
      owner: report.owner,
      occupants: report.occupants.map(item => ({ sessionId: item.sessionId, kinds: [...item.kinds], relation: item.relation })),
    },
    cleanliness: {
      clean: report.clean,
      state: report.clean ? 'clean' : report.dirtyCount > 0 ? 'dirty' : 'unknown',
      dirtyCount: report.dirtyCount,
      files: [...report.dirtyFiles],
      samples: [...report.dirtySamples],
    },
    updatedAt: report.updatedAt,
    leasedBy: [...report.leasedBy],
  }
}

/** A failure the model reads: which criterion, and what exactly is wrong. */
function criterionFailuresJson(report: WorkspaceReport): Json[] {
  const failures: Json[] = []
  if (report.status !== 'ok') {
    failures.push(json({ criterion: 'directory', message: `directory: workspace '${report.path}' is missing on disk` }))
  }
  if (report.occupied) {
    failures.push(json({ criterion: 'occupancy', message: report.occupancyDetail }))
  }
  if (!report.clean) {
    failures.push(json({ criterion: 'cleanliness', message: report.cleanliness }))
  }
  return failures
}

/**
 * Build the four-capability tool set.
 *
 * @param host - the Host face.
 * @returns one definition per tool, in registration order.
 */
export function buildWorkspaceGuardTools(host: WorkspaceGuardHost): ToolDefinition[] {
  return [
    defineTool({
      name: 'workspace_guard_list',
      description: [
        'List every DSH workspace with all four guard judgments: canonical path, live directory status, occupancy (and who holds it), and cleanliness (and how many uncommitted changes).',
        'Read-only: probing a workspace never writes to it and never touches its git state.',
        'Use this to see which workspaces are free before picking one, or to audit the whole machine.',
      ].join(' '),
      parameters: {
        sessionId: { type: 'string', description: 'Optional session id to judge from: activity belonging to this session is reported as self-held and is continuable when the selfOwnership setting is on. Defaults to the calling session.' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const requester = args.sessionId ?? callingSessionId(exec)
        const reports = await host.report(requester)
        return json({
          ok: true,
          count: reports.length,
          requesterSessionId: requester ?? null,
          policy: policyJson(host.policy()),
          workspaces: reports.map(reportJson),
        })
      },
    }),

    defineTool({
      name: 'workspace_guard_register',
      description: [
        'Register an existing directory as a DSH workspace so the other guard tools can judge, assign and gate it.',
        'Idempotent: a directory that is already a workspace returns its existing record unchanged (the registry keys records by canonical path), so this is safe to call before every assignment.',
        'The directory must already exist — this registers a workspace over a directory, it never creates one, and the registry refuses a relative, missing, or non-directory path.',
        'Registration alone changes nothing on disk and does not touch the directory\'s contents or git state.',
      ].join(' '),
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute path of an existing directory to register as a workspace.' },
        title: { type: 'string', description: 'Display title used only when a new record is created; an existing record keeps its title.' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args) {
        if (args.path === undefined || args.path.trim() === '') {
          return refused('path-required', 'path is required: pass the absolute path of an existing directory')
        }
        try {
          const registered = await host.register({ path: args.path, ...(args.title === undefined ? {} : { title: args.title }) })
          const report = await host.reportOne(registered.workspaceId)
          return json({
            ok: true,
            workspaceId: registered.workspaceId,
            path: registered.path,
            title: registered.title,
            workspace: report === undefined ? null : reportJson(report),
          })
        } catch (error) {
          return refused('register-refused', `the registry refused to register '${args.path}': ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    }),

    defineTool({
      name: 'workspace_guard_check',
      description: [
        'Judge one workspace: whether it is occupied, by whom, whether it is clean, and where the dirt is.',
        'Read-only.',
        'Accepts a workspace id or a directory path. The refusal-shaped answer names every failing criterion, so a caller can report precisely why a workspace is unusable instead of guessing.',
      ].join(' '),
      parameters: {
        workspaceId: { type: 'string', description: 'Workspace record id, as reported by workspace_guard_list.' },
        path: { type: 'string', description: 'Canonical workspace directory; used when workspaceId is omitted.' },
        sessionId: { type: 'string', description: 'Optional session id to judge from. Defaults to the calling session.' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const requester = args.sessionId ?? callingSessionId(exec)
        const report = await host.reportOne(args.workspaceId ?? args.path ?? '', requester)
        if (report === undefined) {
          return refused('workspace-not-found', `no workspace matches '${args.workspaceId ?? args.path ?? ''}'; call workspace_guard_list for the registered ids and paths`)
        }
        const failures = criterionFailuresJson(report)
        return json({
          ok: failures.length === 0,
          workspace: reportJson(report),
          failures,
        })
      },
    }),

    defineTool({
      name: 'workspace_guard_assign',
      description: [
        'Assign a workspace to a session: pick the best free and clean workspace, then record the assignment.',
        'Candidate pool: every registered workspace whose directory exists, that is not occupied (unless occupied by the requester itself and the selfOwnership setting is on), and that is known clean. The pool is ordered least-recently-mutated first, so new work spreads away from whatever was just used.',
        'When the pool is empty the call is refused and every candidate is listed with the criterion it failed — it never silently falls back to a workspace it rejected.',
        'Recording is optional (record:false); the assignment is stored as a lease keyed by workspace id and expires after the configured lease TTL, so a crashed holder cannot wedge a workspace forever.',
      ].join(' '),
      parameters: {
        sessionId: { type: 'string', description: 'Session the workspace is assigned to. Defaults to the calling session.' },
        taskId: { type: 'string', description: 'Optional task id kept with the assignment record.' },
        note: { type: 'string', description: 'Optional free-form note kept with the assignment record.' },
        record: { type: 'boolean', description: 'Record the assignment as a lease (default true). Pass false to only preview the choice.' },
        allowCleanish: { type: 'boolean', description: 'Also accept workspaces that are not known clean (default false). Refused assignments then become eligible; the response names which candidates this admitted.' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const sessionId = args.sessionId ?? callingSessionId(exec)
        const policy = host.policy()
        const reports = await host.report(sessionId)
        const verdict = selectWorkspace({
          candidates: reports.map(candidateOf),
          allowUnclean: args.allowCleanish === true,
        })
        if (verdict.assigned === undefined) {
          return refused('no-eligible-workspace', 'no registered workspace is both free and clean; every candidate and the criterion it failed is listed under candidates', {
            candidates: verdict.rejections.map(item => json({ workspaceId: item.workspaceId, path: item.path, reasons: [...item.reasons] })),
          })
        }
        const chosen = reports.find(item => item.workspaceId === verdict.assigned?.workspaceId)
        const recorded = args.record !== false
        if (recorded) {
          if (sessionId === undefined) {
            return refused('session-unknown', 'cannot record an assignment without a session id; pass sessionId or call this from a session')
          }
          await host.recordLease({
            workspaceId: verdict.assigned.workspaceId,
            sessionId,
            ...(args.taskId === undefined ? {} : { taskId: args.taskId }),
            ...(args.note === undefined ? {} : { note: args.note }),
            ttlMs: policy.leaseTtlMs,
          })
        }
        return json({
          ok: true,
          assignedWorkspaceId: verdict.assigned.workspaceId,
          path: verdict.assigned.path,
          title: verdict.assigned.title,
          recorded,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(args.taskId === undefined ? {} : { taskId: args.taskId }),
          pool: {
            considered: reports.length,
            eligible: reports.length - verdict.rejections.length,
            rejected: verdict.rejections.map(item => json({ workspaceId: item.workspaceId, path: item.path, reasons: [...item.reasons] })),
          },
          workspace: chosen === undefined ? null : reportJson(chosen),
        })
      },
    }),

    defineTool({
      name: 'workspace_guard_assert',
      description: [
        'Gate a task against the workspace it was assigned: refuse unless that workspace is free and known clean.',
        'This is the assign-time check the operator asked for — an assigned workspace MUST be clean before the task may proceed.',
        'On refusal the answer names every failing criterion and its holder: the occupying session (with the activity families holding it) and the uncommitted paths, never a bare "not clean".',
        'Read-only with respect to the workspace: it probes and, when a lease is requested, records the claim; it never modifies the workspace or its git state.',
      ].join(' '),
      parameters: {
        workspaceId: { type: 'string', description: 'The assigned workspace id to gate. Required unless taskId maps to a recorded lease.' },
        taskId: { type: 'string', description: 'Optional task id; used to find the assignment recorded for it, and kept in the answer.' },
        sessionId: { type: 'string', description: 'Session the task runs as. Defaults to the calling session.' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const sessionId = args.sessionId ?? callingSessionId(exec)
        const policy = host.policy()
        const workspaceId = args.workspaceId
        if (workspaceId === undefined || workspaceId === '') {
          return refused('workspace-required', 'workspaceId is required: pass the workspace the task was assigned to (workspace_guard_assign returns it as assignedWorkspaceId)')
        }
        const report = await host.reportOne(workspaceId, sessionId)
        if (report === undefined) {
          return refused('workspace-not-found', `no workspace matches '${workspaceId}'; call workspace_guard_list for the registered ids`)
        }
        const verdict = checkAssignment({
          workspaceId: report.workspaceId,
          path: report.path,
          occupancy: {
            occupied: report.occupied,
            owner: report.owner,
            occupants: report.occupants.map(item => ({ sessionId: item.sessionId, kinds: [...item.kinds], relation: item.relation })),
          },
          cleanliness: {
            clean: report.clean,
            state: report.clean ? 'clean' : report.dirtyCount > 0 ? 'dirty' : 'unknown',
            dirtyCount: report.dirtyCount,
            files: [...report.dirtyFiles],
            samples: [...report.dirtySamples],
          },
          onBlocked: policy.onBlocked,
        })
        const base = {
          workspaceId: report.workspaceId,
          path: report.path,
          ...(args.taskId === undefined ? {} : { taskId: args.taskId }),
          ...(sessionId === undefined ? {} : { sessionId }),
          workspace: reportJson(report),
          failures: verdict.failures.map(item => json({ criterion: item.criterion, message: item.message })),
        }
        if (!verdict.allowed) {
          return refused('workspace-unusable', `refused: the assigned workspace failed ${verdict.failures.length} criterion(s) — ${verdict.messages.join(' || ')}`, base)
        }
        return json({ ok: true, ...base, warned: verdict.warned })
      },
    }),

    defineTool({
      name: 'workspace_guard_link',
      description: [
        'Record or drop the workspace↔session relation, then read it back in both directions.',
        'The relation is stored by the DSH workspace registry itself, not by this plugin: attachSession validates that the session\'s canonical cwd equals the workspace path and rejects a mismatch without writing, so the relation cannot be forged.',
        'action:"attach" binds a session to a workspace; action:"detach" removes it; action:"read" changes nothing and reports both directions for one session or one workspace.',
        'This plugin keeps only its own increments (the assignment leases); it never duplicates the registry\'s ownership account.',
      ].join(' '),
      parameters: {
        action: { type: 'string', required: true, description: 'attach, detach, or read.' },
        workspaceId: { type: 'string', description: 'Workspace record id.' },
        sessionId: { type: 'string', description: 'Session id. Defaults to the calling session for attach and read.' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const action = args.action
        if (action !== 'attach' && action !== 'detach' && action !== 'read') {
          return refused('bad-action', `action must be attach, detach or read; got '${String(action)}'`)
        }
        const workspaceId = args.workspaceId
        if (workspaceId === undefined || workspaceId === '') {
          return refused('workspace-required', 'workspaceId is required; call workspace_guard_list for the registered ids')
        }
        const sessionId = args.sessionId ?? callingSessionId(exec)
        if (action === 'read') {
          if (sessionId === undefined) {
            return refused('session-required', 'read needs a sessionId (or a calling session) to resolve the session→workspace direction')
          }
          const report = await host.reportOne(workspaceId, sessionId)
          if (report === undefined) return refused('workspace-not-found', `no workspace matches '${workspaceId}'`)
          const owning = await host.workspaceOfSession(sessionId)
          return json({
            ok: true,
            workspaceToSessions: { workspaceId: report.workspaceId, path: report.path, sessionCount: report.sessions.length, sessions: report.sessions.slice(0, MAX_LISTED_SESSIONS) },
            sessionToWorkspace: { sessionId, workspaceId: owning ?? null, path: owning === undefined ? null : report.path },
            leases: [...report.leasedBy],
          })
        }
        if (sessionId === undefined) {
          return refused('session-required', `${action} needs a sessionId (or a calling session)`)
        }
        try {
          await host.link({ workspaceId, sessionId, action })
        } catch (error) {
          return refused('link-refused', `the registry refused to ${action} session '${sessionId}' on workspace '${workspaceId}': ${error instanceof Error ? error.message : String(error)}`)
        }
        const report = await host.reportOne(workspaceId, sessionId)
        return json({
          ok: true,
          action,
          workspaceToSessions: {
            workspaceId,
            sessionCount: report === undefined ? 0 : report.sessions.length,
            sessions: report === undefined ? [] : report.sessions.slice(0, MAX_LISTED_SESSIONS),
          },
          sessionToWorkspace: { sessionId, workspaceId: (await host.workspaceOfSession(sessionId)) ?? null },
        })
      },
    }),
  ]
}

/** Registered tool names, in registration order. */
export const WORKSPACE_GUARD_TOOL_NAMES = [
  'workspace_guard_list',
  'workspace_guard_register',
  'workspace_guard_check',
  'workspace_guard_assign',
  'workspace_guard_assert',
  'workspace_guard_link',
] as const

/** The effective policy as JSON, so every answer states the tolerances in force. */
function policyJson(policy: GuardPolicy): Json {
  return json({
    selfOwnership: policy.selfOwnership,
    requireGitRepo: policy.requireGitRepo,
    refuseOnProbeError: policy.refuseOnProbeError,
    gitDirtyImpliesBusy: policy.gitDirtyImpliesBusy,
    onBlocked: policy.onBlocked,
    leaseTtlMs: policy.leaseTtlMs,
  })
}

/**
 * The calling session's id, taken from the Agent the tool runs on behalf of.
 *
 * The registry sets `exec.agent` on a call the agent loop made, and the Agent
 * carries its Session. An execution outside any session (a programmatic
 * dispatch) has neither, and then there is simply no requester — the honest
 * answer, rather than an error.
 *
 * @param exec - the tool execution context.
 * @returns the session id, or undefined outside a session.
 */
function callingSessionId(exec: unknown): string | undefined {
  const agent = (exec as { agent?: unknown } | undefined)?.agent as
    | { session?: { id?: unknown; header?: { id?: unknown } } }
    | undefined
  const id = agent?.session?.id ?? agent?.session?.header?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}


