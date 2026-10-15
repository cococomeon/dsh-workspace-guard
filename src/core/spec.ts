/**
 * The plugin's own durable increments, declared as a storage domain.
 *
 * Decision 4 of the design: the workspace↔session relation is NOT duplicated
 * here. `workspaceRegistry` already owns it — header-validated, durable, and
 * the single authority both the GUI and the board read. What this plugin adds
 * is only what the registry has no concept of: an assignment record that
 * remembers *why* a workspace was handed out and for how long the claim holds,
 * so a stale claim can be told apart from a live one.
 *
 * @module dsh-workspace-guard/core/spec
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/**
 * One recorded assignment: a workspace handed to a session.
 *
 * `expiresAt` is what makes this a lease rather than a permanent fact. An
 * expired lease is ignored by every read, so a crashed holder cannot wedge a
 * workspace forever, while the record itself survives for the audit trail.
 */
export const leaseRecord = z.object({
  /** Workspace record id the claim is over. */
  workspaceId: z.string(),
  /** Session the workspace was assigned to. */
  sessionId: z.string(),
  /** Task the assignment was made for, when the caller named one. */
  taskId: z.string().optional(),
  /** Free-form reason kept with the claim. */
  note: z.string().optional(),
  /** ISO-8601 instant the claim was made. */
  acquiredAt: z.string(),
  /** ISO-8601 instant the claim stops being honoured. */
  expiresAt: z.string(),
})

/** One stored assignment record. */
export type LeaseRecord = z.infer<typeof leaseRecord>

/** Durable domain state. Present so the domain carries a version marker. */
export const workspaceGuardState = z.object({
  /** Format version of this domain's global slot. */
  version: z.number(),
})

/** The domain declaration: one `leases` table keyed by workspace id. */
export const workspaceGuardDomainSpec = defineDomain({
  // Domain names must match /^[a-z][a-z0-9_]*$/ — no hyphens, unlike the
  // package name. `defineDomain` throws at module load on a bad name.
  name: 'workspace_guard',
  version: 1,
  global: { schema: workspaceGuardState, initial: { version: 1 } },
  tables: {
    leases: domainTable<string, LeaseRecord>(leaseRecord),
  },
})
