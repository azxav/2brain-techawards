import type { BrainEngine } from '../core/engine.ts';
import { resolvePrincipalSourceAccess } from './source-access.ts';

type ChecklistEngine = Pick<BrainEngine, 'executeRaw'>;

export const WORKSPACE_SETUP_STEP_KEYS = [
  'connect_source',
  'complete_synchronization',
  'inspect_provenance',
  'invite_members',
  'register_agent',
] as const;
export type WorkspaceSetupStepKey = typeof WORKSPACE_SETUP_STEP_KEYS[number];

export interface WorkspaceSetupStepAction {
  label: string;
  href: string;
}

export interface WorkspaceSetupStep {
  step: WorkspaceSetupStepKey;
  title: string;
  description: string;
  complete: boolean;
  completed_at: string | null;
  evidence: string | null;
  action: WorkspaceSetupStepAction;
}

export interface WorkspaceSetupChecklist {
  complete: boolean;
  completed_steps: number;
  steps: WorkspaceSetupStep[];
}

export type WorkspaceMemberHomeState = 'setting_up' | 'access_required' | 'ready';

const STEP_DEFINITIONS: Record<WorkspaceSetupStepKey, { title: string; description: string; action: WorkspaceSetupStepAction }> = {
  connect_source: {
    title: 'Add an HTTPS Managed Git Source',
    description: 'Connect the first Source so the Workspace has a traceable origin for Knowledge.',
    action: { label: 'Connect a Source', href: '/app/settings/sources' },
  },
  complete_synchronization: {
    title: 'Complete its first synchronization',
    description: 'Run the first synchronization so compiled Knowledge exists with durable progress evidence.',
    action: { label: 'Review Sources and operations', href: '/app/settings/sources' },
  },
  inspect_provenance: {
    title: 'Inspect one compiled Page and its provenance',
    description: 'Open a Page and review its provenance so trust rests on inspected evidence.',
    action: { label: 'Open Knowledge', href: '/app/knowledge' },
  },
  invite_members: {
    title: 'Invite Members and grant Source Access',
    description: 'Invite a Member with an explicit Source Access decision. Access is fail-closed until granted.',
    action: { label: 'Invite Members', href: '/app/settings/members' },
  },
  register_agent: {
    title: 'Register the first Agent with least privilege',
    description: 'Register an Agent with the narrowest Agent Scope and Source Access it needs.',
    action: { label: 'Register an Agent', href: '/app/agents' },
  },
};

const ACCESS_MODE_LABELS: Record<string, string> = {
  all: 'All Sources',
  specific: 'Specific Sources',
  none: 'No Source Access',
};

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function step(
  key: WorkspaceSetupStepKey,
  evidence: { completedAt: string | Date; summary: string } | null,
): WorkspaceSetupStep {
  const definition = STEP_DEFINITIONS[key];
  return {
    step: key,
    title: definition.title,
    description: definition.description,
    complete: evidence !== null,
    completed_at: evidence ? toIso(evidence.completedAt) : null,
    evidence: evidence ? evidence.summary : null,
    action: definition.action,
  };
}

/**
 * Durable evidence that an Administrator inspected a compiled Page's
 * provenance. This is deliberately not a Change Event: Page reads stay out of
 * Recent changes, so the trust act gets its own dedicated record instead.
 */
export async function recordWorkspacePageProvenanceInspection(
  engine: ChecklistEngine,
  input: { workspaceId: string; membershipId: string; sourceId: string; slug: string },
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO workspace_page_provenance_inspections (workspace_id, membership_id, source_id, slug)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, membership_id, source_id, slug)
     DO UPDATE SET last_inspected_at=now()`,
    [input.workspaceId, input.membershipId, input.sourceId, input.slug],
  );
}

/**
 * Derive every Setup Checklist step from durable live evidence. No step is a
 * manually checked box: archiving or permanently deleting the evidence Source
 * regresses the Source-bound steps, while invitation and Agent registration
 * records remain durable through later revocation.
 */
export async function getWorkspaceSetupChecklist(
  engine: ChecklistEngine,
  workspaceId: string,
): Promise<WorkspaceSetupChecklist> {
  const [connected, synchronized, inspected, invited, registered] = await Promise.all([
    engine.executeRaw<{ source_id: string; created_at: string | Date }>(
      `SELECT source_id, created_at
         FROM workspace_sources
        WHERE workspace_id=$1 AND archived=FALSE AND deleted=FALSE
        ORDER BY created_at ASC, source_id ASC
        LIMIT 1`,
      [workspaceId],
    ),
    engine.executeRaw<{ source_id: string; last_sync_at: string | Date }>(
      `SELECT source_id, last_sync_at
         FROM workspace_sources
        WHERE workspace_id=$1 AND archived=FALSE AND deleted=FALSE AND last_sync_at IS NOT NULL
        ORDER BY last_sync_at ASC, source_id ASC
        LIMIT 1`,
      [workspaceId],
    ),
    engine.executeRaw<{ source_id: string; slug: string; first_inspected_at: string | Date }>(
      `SELECT i.source_id, i.slug, i.first_inspected_at
         FROM workspace_page_provenance_inspections i
         JOIN workspace_sources ws
           ON ws.workspace_id=i.workspace_id AND ws.source_id=i.source_id
          AND ws.archived=FALSE AND ws.deleted=FALSE
        WHERE i.workspace_id=$1
        ORDER BY i.first_inspected_at ASC, i.source_id ASC, i.slug ASC
        LIMIT 1`,
      [workspaceId],
    ),
    engine.executeRaw<{ normalized_email: string; access_mode: string; created_at: string | Date }>(
      `SELECT normalized_email, access_mode, created_at
         FROM workspace_invitations
        WHERE workspace_id=$1
        ORDER BY created_at ASC, invitation_id ASC
        LIMIT 1`,
      [workspaceId],
    ),
    engine.executeRaw<{ name: string; created_at: string | Date }>(
      `SELECT name, created_at
         FROM workspace_agents
        WHERE workspace_id=$1
        ORDER BY created_at ASC, agent_id ASC
        LIMIT 1`,
      [workspaceId],
    ),
  ]);

  const steps: WorkspaceSetupStep[] = [
    step('connect_source', connected[0]
      ? { completedAt: connected[0].created_at, summary: `Source ${connected[0].source_id} is connected` }
      : null),
    step('complete_synchronization', synchronized[0]
      ? { completedAt: synchronized[0].last_sync_at, summary: `Source ${synchronized[0].source_id} completed synchronization` }
      : null),
    step('inspect_provenance', inspected[0]
      ? { completedAt: inspected[0].first_inspected_at, summary: `Provenance inspected for ${inspected[0].source_id}/${inspected[0].slug}` }
      : null),
    step('invite_members', invited[0]
      ? { completedAt: invited[0].created_at, summary: `${invited[0].normalized_email} invited with ${ACCESS_MODE_LABELS[invited[0].access_mode] ?? invited[0].access_mode}` }
      : null),
    step('register_agent', registered[0]
      ? { completedAt: registered[0].created_at, summary: `Agent ${registered[0].name} is registered` }
      : null),
  ];
  const completedSteps = steps.filter(item => item.complete).length;
  return { complete: completedSteps === steps.length, completed_steps: completedSteps, steps };
}

/**
 * Cause-specific Member Home state. `setting_up` holds only while the entire
 * Workspace has no synchronized Knowledge; once Knowledge exists a Member
 * without usable Source Access sees the distinct access-required state.
 */
export async function getWorkspaceMemberHomeState(
  engine: ChecklistEngine,
  workspaceId: string,
  membershipId: string,
): Promise<WorkspaceMemberHomeState> {
  const sources = await engine.executeRaw<{ source_id: string; synchronized: boolean }>(
    `SELECT source_id, (last_sync_at IS NOT NULL) AS synchronized
       FROM workspace_sources
      WHERE workspace_id=$1 AND archived=FALSE AND deleted=FALSE
      ORDER BY source_id`,
    [workspaceId],
  );
  if (!sources.some(source => source.synchronized === true)) return 'setting_up';
  const currentSourceIds = sources.map(source => source.source_id);
  const access = await resolvePrincipalSourceAccess(
    engine,
    { remote: true, principal: { kind: 'member', id: membershipId } },
    currentSourceIds,
  );
  const permitted = access.kind === 'sources' ? access.sourceIds : currentSourceIds;
  return permitted.length === 0 ? 'access_required' : 'ready';
}
