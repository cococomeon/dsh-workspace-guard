/**
 * Host loader entry for dsh-workspace-guard.
 *
 * The plugin answers four questions about DSH workspaces: is one occupied, is
 * one clean, which one should a task get, and may a task proceed in the one it
 * was assigned. It owns no workspace state of its own: occupancy comes from the
 * platform's `workspace/session-activity` waterfall, cleanliness from a
 * read-only git probe, and the workspace↔session relation from the workspace
 * registry that already validates it. This plugin stores only its own
 * increments — assignment leases — in a storage domain of its own.
 *
 * @module dsh-workspace-guard
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import {
  judgeCleanliness,
  judgeOccupancy,
  withGitDirtyOccupancy,
  describeCleanliness,
  describeOccupancy,
  type ActivitySample,
  type OccupancyVerdict,
} from './core/verdict.ts'
import { workspaceGuardDomainSpec, type LeaseRecord } from './core/spec.ts'
import {
  liveLeases,
  makeLease,
  probeActivity,
  probeGit,
  type LeaseTableFace,
  type WorkspaceFace,
  type WorkspaceRegistryFace,
} from './host/probe.ts'
import { buildWorkspaceGuardTools, WORKSPACE_GUARD_TOOL_NAMES, type GuardPolicy, type WorkspaceGuardHost, type WorkspaceReport } from './host/tools.ts'

/** Order of the announcement section within the shared tool-guidance band. */
const SECTION_ORDER = 205

/** Default lease lifetime: two hours is long enough for a task, short enough to self-heal. */
export const DEFAULT_LEASE_TTL_MINUTES = 120

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const WORKSPACE_GUARD_GUIDANCE = '本机已安装 dsh-workspace-guard 插件（工作区占用/干净度判定与分配）。能力：workspace_guard_list 列出全部工作区及其占用与干净度；workspace_guard_check 判定单个工作区；workspace_guard_register 把一个已存在目录登记为工作区；workspace_guard_assign 为会话挑一个空闲且干净的工作区并记录分配；workspace_guard_assert 在任务开始前校验被指派的工作区是否可用（不干净或被占用即拒绝，并在错误里说明是哪条判据失败、占用者是谁）；workspace_guard_link 记录/查询「工作区 ↔ 会话」关联。占用判据来自平台原生的 session 活动信号（turn/job/subagent/schedule），干净判据来自只读的 git status，绝不修改任何工作区。需要判断「某个工作区能不能用」时优先使用本插件，不要凭猜测。'

/** Plugin config, validated by the same-named schemastery schema. */
export interface ConfigInput {
  /** Master switch for the plugin. */
  enabled?: boolean
  /** Announce the plugin in the system prompt. */
  announceToAgent?: boolean
  /** Treat the requester's own activity as continuable instead of a conflict. */
  selfOwnership?: boolean
  /** Treat a directory that is not a git repository as unclean. */
  requireGitRepo?: boolean
  /** Treat an unanswerable git probe as unclean. */
  refuseOnProbeError?: boolean
  /** Also count uncommitted changes as occupancy. */
  gitDirtyImpliesBusy?: boolean
  /** What `workspace_guard_assert` does when a criterion fails. */
  onBlocked?: 'refuse' | 'warn'
  /** Assignment lease lifetime, in minutes. */
  leaseTtlMinutes?: number
}

/** Resolved config; every field volatile so a settings edit commits in place. */
export interface Config {
  enabled: Volatile<boolean>
  announceToAgent: Volatile<boolean>
  selfOwnership: Volatile<boolean>
  requireGitRepo: Volatile<boolean>
  refuseOnProbeError: Volatile<boolean>
  gitDirtyImpliesBusy: Volatile<boolean>
  onBlocked: Volatile<'refuse' | 'warn'>
  leaseTtlMinutes: Volatile<number>
}

/**
 * Schema and settings page for the plugin.
 *
 * Every field is volatile: the Loader commits an edit into the running fiber's
 * references without remounting the row, so the policy below is re-read at call
 * time and a settings change takes effect on the next judgment.
 */
export const Config: z<ConfigInput, Config> = z.object({
  enabled: z.boolean().default(true).volatile(),
  announceToAgent: z.boolean().default(true).volatile(),
  selfOwnership: z.boolean().default(true).volatile(),
  requireGitRepo: z.boolean().default(false).volatile(),
  refuseOnProbeError: z.boolean().default(true).volatile(),
  gitDirtyImpliesBusy: z.boolean().default(false).volatile(),
  onBlocked: z.union(['refuse', 'warn']).default('refuse').volatile(),
  leaseTtlMinutes: z.number().min(1).max(10080).default(DEFAULT_LEASE_TTL_MINUTES).volatile(),
})

export const inject = ['workspaceRegistry', 'storageDomain']

/** The registry face the agent tools register into. */
interface AgentToolRegistry {
  register(definition: ToolDefinition): () => void
  /** Scoped lookup; present on the real registry. */
  get?(name: string, scope?: unknown): unknown
}

/**
 * Read one config field's current value.
 *
 * The Loader hands volatile fields as stable references it commits in place, so
 * a live value must be read at use time rather than captured when the plugin
 * activates; a plain value is returned as it stands.
 *
 * @param field - the config field as the Loader handed it.
 * @param fallback - value to use when the field is absent.
 * @returns the effective field value.
 */
export function readConfigField<T>(field: Volatile<T> | T | undefined, fallback: T): T {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof (field as { get?: unknown }).get === 'function') {
    return (field as Volatile<T>).get() as T
  }
  return field as T
}

/**
 * Resolve the optional agent-tool registry.
 *
 * Deliberately not injected: a deployment whose runtime serves no registry must
 * still mount the plugin and lose only the agent-tool surface.
 *
 * @param ctx - the plugin context.
 * @returns the registry, or undefined when this deployment serves none.
 */
export function resolveToolRegistry(ctx: Context): AgentToolRegistry | undefined {
  try {
    const tools = ctx.get('tools') as AgentToolRegistry | undefined
    return tools !== undefined && typeof tools.register === 'function' ? tools : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the optional system-prompt registry.
 *
 * Deliberately not injected, for the same reason as the tool registry: a
 * deployment that serves no prompt registry must still mount the plugin and
 * lose only its announcement. Accessing an absent cordis service throws, so
 * this is a guarded read rather than a plain property access.
 *
 * @param ctx - the plugin context.
 * @returns the face, or undefined when this deployment serves none.
 */
export function resolveSystemPrompt(ctx: Context): { section(init: { name: string; order: number; text: string }): () => void } | undefined {
  try {
    const prompt = ctx.get('systemPrompt') as { section?: unknown } | undefined
    return prompt !== undefined && typeof prompt.section === 'function'
      ? prompt as { section(init: { name: string; order: number; text: string }): () => void }
      : undefined
  } catch {
    return undefined
  }
}

/** The Host face, implemented over the registry, the activity waterfall and the lease table. */
class WorkspaceGuardHostImpl implements WorkspaceGuardHost {
  /**
   * @param ctx - the plugin context (the activity waterfall dispatches on it).
   * @param registry - the workspace registry face.
   * @param leases - the plugin's own lease table.
   * @param policyOf - resolves the live policy on every call.
   */
  constructor(
    private readonly ctx: Context,
    private readonly registry: WorkspaceRegistryFace,
    private readonly leases: LeaseTableFace,
    private readonly policyOf: () => GuardPolicy,
  ) {}

  /** @returns the live operator policy. */
  policy(): GuardPolicy {
    return this.policyOf()
  }

  /**
   * Judge every registered workspace.
   *
   * @param requesterSessionId - the session asking; may continue its own work.
   * @returns one report per workspace, in registry order.
   */
  async report(requesterSessionId?: string): Promise<WorkspaceReport[]> {
    const facts = this.registry.list()
    const policy = this.policyOf()
    const live = liveLeases(this.leases)
    // Ask about every session that could hold a workspace: the registry's
    // header-validated members, plus any session this plugin leased a workspace
    // to. The waterfall is the platform's own occupancy signal, so it is asked
    // once per candidate and the answers are shared across every workspace.
    const candidates = new Set<string>()
    for (const fact of facts) for (const sessionId of fact.sessionIds) candidates.add(sessionId)
    for (const lease of live.values()) candidates.add(lease.sessionId)
    const activity = await probeActivity(this.ctx, [...candidates])
    return await Promise.all(facts.map(async fact => this.buildReport(fact, activity, live, policy, requesterSessionId)))
  }

  /**
   * Judge one workspace by id or canonical path.
   *
   * @param idOrPath - workspace id, or a directory path.
   * @param requesterSessionId - the session asking.
   * @returns the report, or undefined when nothing matches.
   */
  async reportOne(idOrPath: string, requesterSessionId?: string): Promise<WorkspaceReport | undefined> {
    const facts = this.registry.list()
    const fact = facts.find(item => item.id === idOrPath)
      ?? facts.find(item => item.path === idOrPath)
      ?? facts.find(item => item.path.endsWith(`/${idOrPath}`))
    if (fact === undefined) return undefined
    const policy = this.policyOf()
    const live = liveLeases(this.leases)
    const candidates = new Set<string>(fact.sessionIds)
    for (const lease of live.values()) candidates.add(lease.sessionId)
    const activity = await probeActivity(this.ctx, [...candidates])
    return await this.buildReport(fact, activity, live, policy, requesterSessionId)
  }

  /**
   * Record one assignment lease.
   *
   * @param input - the assignment to record.
   */
  async recordLease(input: { workspaceId: string; sessionId: string; taskId?: string; note?: string; ttlMs: number }): Promise<void> {
    const record = makeLease(input, input.ttlMs)
    await this.leases.put(record.workspaceId, record)
  }

  /**
   * Attach or detach a session on the registry that owns the relation.
   *
   * @param input - workspace, session and direction.
   */
  async link(input: { workspaceId: string; sessionId: string; action: 'attach' | 'detach' }): Promise<void> {
    const workspace = this.workspace(input.workspaceId)
    if (workspace === undefined) throw new Error(`unknown workspace '${input.workspaceId}'`)
    const sessionId = input.sessionId as Parameters<WorkspaceFace['attachSession']>[0]
    if (input.action === 'attach') await workspace.attachSession(sessionId)
    else await workspace.detachSession(sessionId)
  }

  /**
   * Find the workspace the registry accounts one session to.
   *
   * Reads the registry rather than the lease table: the registry's account is
   * header-validated, so it is the authoritative direction.
   *
   * @param sessionId - the session.
   * @returns the workspace id, or undefined when unaccounted.
   */
  async workspaceOfSession(sessionId: string): Promise<string | undefined> {
    return this.registry.list().find(item => item.sessionIds.includes(sessionId))?.id
  }

  /**
   * Register an existing directory as a workspace, or return its record.
   *
   * @param input - the directory and an optional title for a new record.
   * @returns the record's identity.
   */
  async register(input: { path: string; title?: string }): Promise<{ workspaceId: string; path: string; title: string }> {
    const created = await this.registry.create(input.path, input.title)
    return { workspaceId: created.id, path: created.path, title: created.title }
  }

  /** @returns the workspace face for one id, or undefined. */
  private workspace(id: string): WorkspaceFace | undefined {
    return this.registry.get(id)
  }

  /**
   * Build one report from the shared activity answer.
   *
   * @param fact - the registry facts.
   * @param activity - activity samples for every candidate session.
   * @param live - leases in force.
   * @param policy - the live policy.
   * @param requesterSessionId - the session asking.
   * @returns the report.
   */
  private async buildReport(
    fact: { readonly id: string; readonly path: string; readonly title: string; readonly updatedAt: string; readonly sessionIds: readonly string[] },
    activity: readonly ActivitySample[],
    live: Map<string, LeaseRecord>,
    policy: GuardPolicy,
    requesterSessionId?: string,
  ): Promise<WorkspaceReport> {
    const workspace = this.workspace(fact.id)
    // The directory check and the git probe are independent observations.
    const [status, probe] = await Promise.all([
      workspace === undefined ? Promise.resolve('missing-dir' as const) : workspace.status(),
      probeGit(fact.path),
    ])
    const cleanliness = judgeCleanliness({
      path: fact.path,
      probe,
      requireGitRepo: policy.requireGitRepo,
      refuseOnProbeError: policy.refuseOnProbeError,
    })
    const base = judgeOccupancy({
      workspaceId: fact.id,
      path: fact.path,
      members: fact.sessionIds,
      activity,
      ...(requesterSessionId === undefined ? {} : { requesterSessionId }),
      selfOwnership: policy.selfOwnership,
    })
    const occupancy: OccupancyVerdict = withGitDirtyOccupancy(base, cleanliness.dirtyCount, policy.gitDirtyImpliesBusy)
    const leasedBy = [...live.values()].filter(lease => lease.workspaceId === fact.id).map(lease => lease.sessionId)
    return {
      workspaceId: fact.id,
      path: fact.path,
      title: fact.title,
      updatedAt: fact.updatedAt,
      status,
      occupied: occupancy.occupied,
      owner: occupancy.owner,
      occupants: occupancy.occupants,
      clean: cleanliness.clean,
      cleanliness: describeCleanliness(fact.path, cleanliness),
      dirtyCount: cleanliness.dirtyCount,
      dirtyFiles: cleanliness.files.slice(0, 10),
      dirtySamples: [...cleanliness.samples],
      sessions: [...fact.sessionIds],
      leasedBy,
      occupancyDetail: describeOccupancy(fact.path, occupancy),
    }
  }
}

/**
 * Mount the plugin: open its domain, register its tools, and announce it.
 *
 * @param ctx - the plugin context.
 * @param config - the resolved plugin config.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const domain = await ctx.storageDomain.open(workspaceGuardDomainSpec)
  ctx.effect(() => () => { void domain.close() })
  const leases: LeaseTableFace = domain.table('leases')

  const policyOf = (): GuardPolicy => ({
    selfOwnership: readConfigField(config.selfOwnership, true),
    requireGitRepo: readConfigField(config.requireGitRepo, false),
    refuseOnProbeError: readConfigField(config.refuseOnProbeError, true),
    gitDirtyImpliesBusy: readConfigField(config.gitDirtyImpliesBusy, false),
    onBlocked: readConfigField(config.onBlocked, 'refuse'),
    leaseTtlMs: readConfigField(config.leaseTtlMinutes, DEFAULT_LEASE_TTL_MINUTES) * 60_000,
  })

  const host = new WorkspaceGuardHostImpl(ctx, ctx.workspaceRegistry as WorkspaceRegistryFace, leases, policyOf)

  let disposeTools: (() => void) | undefined
  const setToolsEnabled = (active: boolean): void => {
    if (!active) {
      disposeTools?.()
      disposeTools = undefined
      return
    }
    if (disposeTools !== undefined) return
    const registry = resolveToolRegistry(ctx)
    if (registry === undefined) return
    const disposers = buildWorkspaceGuardTools(host).map(tool => registry.register(tool))
    disposeTools = () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  }

  let disposeSection: (() => void) | undefined
  const sync = (): void => {
    setToolsEnabled(readConfigField(config.enabled, true))
    disposeSection?.()
    disposeSection = undefined
    if (!readConfigField(config.enabled, true) || !readConfigField(config.announceToAgent, true)) return
    const registry = resolveToolRegistry(ctx)
    // The announcement names tools, so it renders only while they exist: a
    // deployment with no tool registry must not leave guidance telling the
    // model to call tools this session cannot see.
    if (registry?.get?.(WORKSPACE_GUARD_TOOL_NAMES[0]) === undefined) return
    const prompt = resolveSystemPrompt(ctx)
    if (prompt === undefined) return
    disposeSection = prompt.section({
      name: 'plugin:workspace-guard',
      order: SECTION_ORDER,
      text: WORKSPACE_GUARD_GUIDANCE,
    })
  }

  ctx.on('loader/volatile-update', () => { sync() })
  sync()
}
