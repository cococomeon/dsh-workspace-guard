/**
 * The IO boundary: everything that touches the real machine.
 *
 * Each function here answers exactly one question and returns plain data, so
 * the verdicts in `core/verdict.ts` stay pure. Nothing in this file decides
 * anything — it observes.
 *
 * @module dsh-workspace-guard/host/probe
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import type { GitProbe, ActivitySample } from '../core/verdict.ts'
import type { LeaseRecord } from '../core/spec.ts'

const execFileAsync = promisify(execFile)

/** One workspace as the registry reports it, before any judgment. */
export interface WorkspaceFacts {
  /** Workspace record id. */
  readonly id: string
  /** Canonical directory. */
  readonly path: string
  /** Display title. */
  readonly title: string
  /** ISO instant of creation. */
  readonly createdAt: string
  /** ISO instant of the last durable mutation. */
  readonly updatedAt: string
  /** Header-validated members, in registry order. */
  readonly sessionIds: readonly string[]
}

/** The registry face this plugin consumes; satisfied by `ctx.workspaceRegistry`. */
export interface WorkspaceRegistryFace {
  /** Ordered workspace projection. */
  list(): readonly WorkspaceFacts[]
  /** Look up one workspace by id. */
  get(id: string): WorkspaceFace | undefined
  /**
   * Create or reuse the record owning an existing directory. The path is
   * canonicalized; a relative, missing, or non-directory path rejects, and a
   * repeated call for the same canonical path returns the existing record.
   */
  create(path: string, title?: string): Promise<WorkspaceFace>
}

/** The per-workspace face this plugin consumes. */
export interface WorkspaceFace extends WorkspaceFacts {
  /** Live directory check. */
  status(): Promise<'ok' | 'missing-dir'>
  /** Record a session against this workspace. Rejects on a cwd mismatch. */
  attachSession(sessionId: string): Promise<void>
  /** Drop a session from this workspace. Idempotent. */
  detachSession(sessionId: string): Promise<void>
}

/** The activity answer for one session: the families that reported active. */
export type SessionActivityKinds = string[]

/**
 * Ask every composed activity provider about one session.
 *
 * This is the platform's own occupancy signal — the same waterfall
 * `WorkspaceRegistry.archiveSession` gates archival on — reused rather than
 * reinvented. Its providers cover a running turn (the Agent registry), owned
 * jobs (the job registry), subagent descendants, and armed schedules.
 *
 * @param ctx - the plugin context.
 * @param sessionId - the session to ask about.
 * @returns the activity family keys that answered non-empty.
 */
export async function probeSessionActivity(ctx: Context, sessionId: string): Promise<SessionActivityKinds> {
  const activity = await ctx.waterfall(
    'workspace/session-activity',
    { sessionId },
    () => Promise.resolve([]),
  )
  return [...new Set(activity.map(entry => String(entry.kind)))].sort()
}

/**
 * Ask about several sessions, keeping the answer tied to its session id.
 *
 * @param ctx - the plugin context.
 * @param sessionIds - the sessions to ask about.
 * @returns one sample per session, never rejecting on a single session's fault.
 */
export async function probeActivity(ctx: Context, sessionIds: readonly string[]): Promise<ActivitySample[]> {
  const samples = await Promise.all(sessionIds.map(async sessionId => {
    try {
      return { sessionId, kinds: await probeSessionActivity(ctx, sessionId) }
    } catch {
      // A provider that throws answers nothing; an unreadable session must not
      // take the whole listing down, and "no answer" is not evidence of activity.
      return { sessionId, kinds: [] as string[] }
    }
  }))
  return samples
}

/**
 * Read one workspace's git status.
 *
 * Read-only by construction: `git status --porcelain` never writes, and this
 * plugin never runs `checkout`/`reset`/`clean`/`stash` — a workspace's
 * uncommitted work is the user's, and the AFA space convention forbids
 * discarding it.
 *
 * @param path - the workspace directory.
 * @param signal - caller cancellation.
 * @returns what the probe found, including its two failure modes.
 */
export async function probeGit(path: string, signal?: AbortSignal): Promise<GitProbe> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'status', '--porcelain'], {
      signal,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })
    return { kind: 'repo', porcelain: stdout.split('\n').filter(line => line !== '') }
  } catch (error) {
    return classifyGitFailure(error)
  }
}

/**
 * Turn a failed git invocation into a verdict input.
 *
 * "Not a repository" is a fact about the directory and is reported as one;
 * anything else (git missing, a timeout, an unreadable tree) is reported as an
 * error so the fail-closed default can act on it.
 *
 * @param error - the rejection from `execFile`.
 * @returns the probe result.
 */
export function classifyGitFailure(error: unknown): GitProbe {
  const shaped = error as { code?: unknown; stderr?: unknown; message?: unknown }
  const stderr = typeof shaped.stderr === 'string' ? shaped.stderr : ''
  const message = typeof shaped.message === 'string' ? shaped.message : String(error)
  if (/not a git repository/i.test(stderr) || /not a git repository/i.test(message)) {
    return { kind: 'not-a-repo' }
  }
  return { kind: 'error', message: stderr.trim() !== '' ? stderr.trim() : message }
}

/** The lease-table face this plugin consumes. */
export interface LeaseTableFace {
  /** Snapshot of every stored lease. */
  entries(): IterableIterator<[string, LeaseRecord]>
  /** Insert or overwrite one lease. */
  put(key: string, value: LeaseRecord): Promise<void>
  /** Delete one lease; `false` when it was already absent. */
  delete(key: string): Promise<boolean>
}

/**
 * Read the leases that are still in force.
 *
 * An expired lease is invisible to callers but not deleted here — reads stay
 * side-effect free, and a later acquire overwrites its slot.
 *
 * @param table - the lease table.
 * @param now - the instant to judge expiry against.
 * @returns the live leases keyed by workspace id.
 */
export function liveLeases(table: LeaseTableFace, now: Date = new Date()): Map<string, LeaseRecord> {
  const live = new Map<string, LeaseRecord>()
  for (const [key, record] of table.entries()) {
    if (Date.parse(record.expiresAt) > now.getTime()) live.set(key, record)
  }
  return live
}

/**
 * Build a lease record for one assignment.
 *
 * @param input - workspace, session, optional task and note.
 * @param ttlMs - how long the claim holds.
 * @param now - the instant the claim is made.
 * @returns the record to store.
 */
export function makeLease(
  input: { workspaceId: string; sessionId: string; taskId?: string; note?: string },
  ttlMs: number,
  now: Date = new Date(),
): LeaseRecord {
  return {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.note === undefined ? {} : { note: input.note }),
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  }
}
