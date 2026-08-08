import express from 'express';
import rateLimit from 'express-rate-limit';
import type { BrainEngine } from '../core/engine.ts';
import { cookie, envInt } from './request-helpers.ts';
import type { WorkspaceEmailMessage } from '../workspace/email-delivery.ts';
import type { OpenClawControl, OpenClawProviderId } from '../workspace/openclaw-control.ts';
import {
  AGENT_SHARED_CATEGORIES,
  AGENT_WARNING_REVISION,
  AgentAccessError,
  CLAUDE_FALLBACK_MODEL,
  CODEX_DEFAULT_MODEL,
  checkAgentRequiredProvider,
  confirmAgentWarning,
  confirmBoundAgentGrant,
  deriveAgentNativePassword,
  getAgentAccessStatus,
  hasConfirmedAgentWarning,
  importAgentAnthropicCredential,
  importAgentOpenRouterCredential,
  initializeBoundWorkspaceAgent,
  projectAgentProvider,
  proveAgentDefaultAnswer,
  reconcileAgentRuntimeOperation,
  requestNativePasswordRotation,
  retryAgentRuntimeOperation,
  setBoundAgentGrant,
  type AgentAccessStatus,
  type AgentReadinessBlocker,
} from '../workspace/agent-access.ts';
import {
  clearBindingReadiness,
  loadBinding,
  readinessFromBinding,
  resolveBoundWorkspaceId,
} from '../workspace/agent-binding.ts';
import {
  AGENT_AUTHORIZE_PATH,
  AGENT_BASE_PATH,
  AGENT_CLIENT_BASE_PATH,
  AGENT_NATIVE_READY_PATH,
  AGENT_RUNTIME_HEALTH_PATH,
} from '../workspace/agent-gate-paths.ts';
import type { PrincipalSourceAccess } from '../workspace/source-access.ts';
import { readWorkspaceFoundationState } from '../workspace/foundation.ts';
import {
  WorkspaceHttpError,
  sendWorkspaceError,
  workspaceRequestContext,
  workspaceSafeErrorHandler,
} from './safe-errors.ts';
import {
  authenticateWorkspaceSession,
  beginWorkspaceSetup,
  bootstrapCredentialMatches,
  confirmFirstAdministrator,
  inspectWorkspaceToken,
  issueWorkspaceSetupToken,
  redeemWorkspaceRecovery,
  redeemWorkspaceLogin,
  requestWorkspaceLogin,
  renewWorkspaceConfirmation,
  revokeWorkspaceSession,
  workspaceSessionCsrfMatches,
} from '../workspace/auth.ts';
import { appDocument, confirmDocument, invitationDocument, loginDocument, messageDocument, setupDocument, workspacePanelForPath, type AppHomeContext } from './workspace-shell.ts';
import {
  appendWorkspaceAuditEvent,
  runProtectedWorkspaceMutation,
  type WorkspaceProtectedAction,
} from '../workspace/events.ts';
import {
  changeConnectedAppAccess,
  changeConnectedAppAccessInTransaction,
  ConnectedAppAccessDeniedError,
  listConnectedApps,
  revokeConnectedApp,
  revokeConnectedAppInTransaction,
  type ConnectedAppProjection,
} from '../workspace/connected-apps.ts';
import {
  createWorkspaceInvitation,
  listWorkspaceMemberships,
  redeemWorkspaceInvitation,
  setWorkspaceMembershipRole,
  setWorkspaceMembershipSourceAccess,
  setWorkspaceMembershipStatus,
} from '../workspace/memberships.ts';
import {
  cancelBackgroundOperation,
  getBackgroundOperation,
  listBackgroundOperations,
  listArchivedManagedGitSources,
  listManagedGitSources,
  queueManagedGitSource,
  retryBackgroundOperation,
  WorkspaceSourceProvisioningError,
  type BackgroundOperationView,
  type ManagedGitSourceView,
} from '../workspace/source-provisioning.ts';
import { queueSourceMaintenance } from '../workspace/source-synchronization.ts';
import {
  cancelWorkspaceExport,
  getWorkspaceExport,
  listWorkspaceExports,
  requestWorkspaceExport,
  retrieveWorkspaceExportArtifact,
  retryWorkspaceExport,
  WorkspaceExportError,
  type WorkspaceExportView,
} from '../workspace/export.ts';
import {
  getWorkspaceMemberHomeState,
  getWorkspaceSetupChecklist,
  recordWorkspacePageProvenanceInspection,
} from '../workspace/setup-checklist.ts';
import {
  archiveWorkspaceSource,
  restoreWorkspaceSource,
  WorkspaceSourceLifecycleError,
} from '../workspace/source-lifecycle.ts';
import {
  previewSourceDeletionImpact,
  queueSourcePermanentDeletion,
  WorkspaceSourceDeletionError,
  type SourceDeletionImpact,
} from '../workspace/source-deletion.ts';
import {
  createWorkspaceSavedView,
  deleteWorkspaceSavedView,
  listWorkspaceKnowledge,
  listWorkspaceSavedViews,
  openWorkspaceSavedView,
  updateWorkspaceSavedView,
  WorkspaceKnowledgeError,
  type WorkspaceKnowledgeProperty,
  type WorkspaceKnowledgeSort,
} from '../workspace/knowledge.ts';
import {
  getWorkspacePage,
  listWorkspacePageVersions,
  WorkspacePageError,
} from '../workspace/page-detail.ts';
import {
  listWorkspaceSearchSources,
  searchWorkspaceKnowledge,
  WorkspaceSearchError,
  type WorkspaceSearchFilters,
} from '../workspace/search.ts';
import {
  cancelWorkspaceAsk,
  conservativeWorkspaceAskSynthesizer,
  createWorkspaceAsk,
  getWorkspaceAsk,
  runWorkspaceAsk,
  WorkspaceAskError,
  type WorkspaceAskSynthesizer,
} from '../workspace/ask.ts';
import {
  getWorkspaceAgent,
  listWorkspaceAgents,
  registerWorkspaceAgent,
  revokeWorkspaceAgentCredential,
  rotateWorkspaceAgentCredential,
  setWorkspaceAgentOwner,
  setWorkspaceAgentPurpose,
  setWorkspaceAgentScope,
  setWorkspaceAgentSourceAccess,
  setWorkspaceAgentStatus,
  WorkspaceAgentError,
  type WorkspaceAgentDirectoryEntry,
} from '../workspace/agents.ts';
import {
  listWorkspaceAgentActivity,
  WorkspaceAgentActivityError,
  type WorkspaceAgentActivityEntry,
} from '../workspace/agent-activity.ts';
import {
  assignWorkspaceAttentionItem,
  dismissWorkspaceAttentionItem,
  getWorkspaceAttentionItem,
  listWorkspaceAttentionItems,
  requestWorkspaceAttentionResolution,
  runWorkspaceAttentionDetectors,
  startWorkspaceAttentionProgress,
  WorkspaceAttentionError,
  type WorkspaceAttentionItemView,
} from '../workspace/attention.ts';
import {
  listWorkspaceLiveUpdates,
  WorkspaceLiveUpdateError,
} from '../workspace/live-updates.ts';
import { getWorkspaceHome, type WorkspaceHomeView } from '../workspace/home.ts';
import {
  archiveWorkspaceNotification,
  countWorkspaceUnreadNotifications,
  listWorkspaceNotifications,
  setWorkspaceNotificationRead,
  WorkspaceNotificationError,
  type WorkspaceNotificationView,
} from '../workspace/notifications.ts';

type WorkspaceRouterEngine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;

export interface WorkspaceRouterOptions {
  requestId?: () => string;
  bootstrapCredential?: string;
  production?: boolean;
  tokenSecret?: string;
  allowedOrigin?: string;
  deliverConfirmation?: (message: WorkspaceEmailMessage) => Promise<void>;
  liveUpdateIntervalMs?: number;
  askSynthesizer?: WorkspaceAskSynthesizer;
  /** Per-IP abuse protection for the authentication surface. Omit for defaults (env-tunable). */
  authRateLimit?: { limit?: number; windowMs?: number };
  /**
   * #68: the closed loopback seam to the colocated OpenClaw runtime. Injected
   * only by the agent-tier composition root; Brain tier and tests leave it
   * absent so no route can reach an OpenClaw runtime that does not exist.
   */
  openClawControl?: OpenClawControl;
}


function sourceApiView(source: ManagedGitSourceView) {
  return {
    source_id: source.sourceId,
    name: source.name,
    remote_url: source.remoteUrl,
    expected_cadence: source.expectedCadence,
    included_in_workspace_search: source.includedInWorkspaceSearch,
    provisioning_state: source.provisioningState,
    last_verified_at: source.lastVerifiedAt,
    last_verified_revision: source.lastVerifiedRevision,
    last_sync_at: source.lastSyncAt,
    last_synced_revision: source.lastSyncedRevision,
    known_unsynchronized_revision: source.knownUnsynchronizedRevision,
    lifecycle_state: source.lifecycleState,
    archived_at: source.archivedAt,
    freshness: {
      state: source.freshness.state,
      reason: source.freshness.reason,
      potentially_outdated: source.freshness.potentiallyOutdated,
    },
    latest_verification: source.latestVerification && {
      outcome: source.latestVerification.outcome,
      error_code: source.latestVerification.errorCode,
      request_id: source.latestVerification.requestId,
      completed_at: source.latestVerification.completedAt,
    },
  };
}

function operationApiView(operation: BackgroundOperationView) {
  return {
    operation_id: operation.operationId,
    type: operation.type,
    resource_id: operation.resourceId,
    state: operation.state,
    progress: operation.progress,
    outcome: operation.outcome,
    error: operation.error && {
      code: operation.error.code,
      message: operation.error.message,
      request_id: operation.error.requestId,
    },
    retryable: operation.retryable,
    cancel_requested: operation.cancelRequested,
    cancellation_safe: operation.cancellationSafe,
    attempt: operation.attempt,
    max_attempts: operation.maxAttempts,
    request_id: operation.requestId,
    created_at: operation.createdAt,
    updated_at: operation.updatedAt,
  };
}

function exportApiView(view: WorkspaceExportView) {
  return {
    export_id: view.exportId,
    state: view.state,
    progress: view.progress,
    outcome: view.outcome,
    error: view.error && {
      code: view.error.code,
      message: view.error.message,
      request_id: view.error.requestId,
    },
    retryable: view.retryable,
    cancel_requested: view.cancelRequested,
    cancellation_safe: view.cancellationSafe,
    attempt: view.attempt,
    max_attempts: view.maxAttempts,
    checksum: view.checksum,
    byte_size: view.byteSize,
    record_counts: view.recordCounts,
    expires_at: view.expiresAt,
    request_id: view.requestId,
    created_at: view.createdAt,
    updated_at: view.updatedAt,
  };
}

function notificationApiView(notification: WorkspaceNotificationView) {
  return {
    notification_id: notification.id,
    event_type: notification.eventType,
    target: notification.target,
    summary: notification.summary,
    unread: notification.unread,
    archived: notification.archived,
    created_at: notification.createdAt,
    expires_at: notification.expiresAt,
  };
}

function connectedAppApiView(app: ConnectedAppProjection) {
  return {
    membership_id: app.membershipId,
    ...(app.memberEmail === undefined ? {} : { member_email: app.memberEmail }),
    client_id: app.clientId,
    client_name: app.clientName,
    connected_at: app.connectedAt.toISOString(),
    updated_at: app.updatedAt.toISOString(),
    configured_access_level: app.configuredAccessLevel,
    effective_access_level: app.effectiveAccessLevel,
    limiting_reason: app.limitingReason,
    available_access_levels: app.availableAccessLevels,
    unavailable_access_level_reasons: app.unavailableAccessLevelReasons,
  };
}

function connectedAppAuditState(app: ConnectedAppProjection) {
  return {
    membership_id: app.membershipId,
    client_id: app.clientId,
    configured_access_level: app.configuredAccessLevel,
    effective_access_level: app.effectiveAccessLevel,
  };
}

function homeApiView(home: WorkspaceHomeView) {
  return {
    generated_at: home.generatedAt,
    trust_summary: home.trustSummary.map(statement => ({
      kind: statement.kind,
      state: statement.state,
      summary: statement.summary,
      evidence: statement.evidence,
    })),
    attention: home.attention.map(item => ({
      item_id: item.itemId,
      category: item.category,
      summary: item.summary,
      status: item.status,
      assignee: item.assignee,
      next_action: item.nextAction,
      evidence: item.evidence,
    })),
    operations: home.operations.map(operation => ({
      operation_id: operation.operationId,
      type: operation.type,
      state: operation.state,
      progress: operation.progress,
      updated_at: operation.updatedAt,
      evidence: operation.evidence,
    })),
    recent_changes: home.recentChanges.map(change => ({
      event_id: change.eventId,
      resource_type: change.resourceType,
      summary: change.summary,
      occurred_at: change.occurredAt,
      evidence: change.evidence,
    })),
    empty: {
      attention: home.empty.attention,
      operations: home.empty.operations,
      recent_changes: home.empty.recentChanges,
    },
  };
}

function sendExportError(res: express.Response, error: unknown): boolean {
  if (!(error instanceof WorkspaceExportError)) return false;
  const status = error.code === 'export_not_found' ? 404
    : error.code === 'export_expired' ? 410
      : error.code === 'export_not_ready' || error.code === 'export_not_retryable'
        || error.code === 'export_not_cancellable' || error.code === 'idempotency_key_reused' ? 409
        : 400;
  res.status(status).json({
    error: {
      code: error.code,
      message: 'The Workspace Export request could not be completed.',
      recovery: 'Review the export status and try again when it is available.',
      retryable: error.code === 'export_not_ready',
      request_id: res.locals.workspaceRequestId,
    },
  });
  return true;
}

function sendProvisioningError(res: express.Response, error: unknown): boolean {
  if (!(error instanceof WorkspaceSourceProvisioningError)) return false;
  const status = error.code === 'operation_not_found' ? 404
    : error.code === 'operation_not_retryable' || error.code === 'operation_not_cancellable'
      || error.code === 'source_id_taken' || error.code === 'idempotency_key_reused' ? 409
      : 400;
  res.status(status).json({
    error: {
      code: error.code,
      message: 'The Source request could not be accepted.',
      recovery: 'Review the supported HTTPS Git configuration and try again.',
      retryable: false,
      request_id: res.locals.workspaceRequestId,
    },
  });
  return true;
}

function sendSourceLifecycleError(res: express.Response, error: unknown): boolean {
  if (!(error instanceof WorkspaceSourceLifecycleError)) return false;
  const forbidden = error.code === 'source_lifecycle_forbidden';
  res.status(forbidden ? 403 : 404).json({
    error: {
      code: error.code,
      message: forbidden ? 'Administrator Source Access is required.' : 'The Source was not found.',
      recovery: forbidden ? 'Ask an authorized Administrator to perform this action.' : 'Refresh the Source list and try again.',
      retryable: false,
      request_id: res.locals.workspaceRequestId,
    },
  });
  return true;
}

function deletionImpactApiView(impact: SourceDeletionImpact) {
  return {
    source_id: impact.sourceId,
    pages: impact.pages,
    page_versions: impact.pageVersions,
    saved_views: impact.savedViews,
    background_operations: impact.backgroundOperations,
    verification_events: impact.verificationEvents,
    access_grants: impact.accessGrants,
  };
}

function sendSourceDeletionError(res: express.Response, error: unknown): boolean {
  if (!(error instanceof WorkspaceSourceDeletionError)) return false;
  const status = error.code === 'source_deletion_forbidden' ? 403
    : error.code === 'source_not_found' ? 404
      : error.code === 'source_not_archived' || error.code === 'idempotency_key_reused' ? 409
        : 400;
  const messages: Record<typeof error.code, [string, string]> = {
    source_deletion_forbidden: ['Administrator Source Access is required.', 'Ask an authorized Administrator to perform this action.'],
    source_not_found: ['The Source was not found.', 'Refresh the archived Source list and try again.'],
    source_not_archived: ['Only an Archived Source can be permanently deleted.', 'Archive the Source first, then request permanent deletion.'],
    confirmation_mismatch: ['The typed confirmation does not match the immutable Source ID.', 'Type the exact Source ID, not the display name.'],
    reason_required: ['A reason is required for permanent deletion.', 'Provide the reason recorded with the immutable Audit Event.'],
    idempotency_key_required: ['An idempotency key is required.', 'Retry from the deletion dialog.'],
    idempotency_key_reused: ['This idempotency key was already used with a different request.', 'Start a new deletion request from the dialog.'],
  };
  res.status(status).json({
    error: {
      code: error.code,
      message: messages[error.code][0],
      recovery: messages[error.code][1],
      retryable: false,
      request_id: res.locals.workspaceRequestId,
    },
  });
  return true;
}

function sendKnowledgeError(res: express.Response, error: unknown): boolean {
  if (!(error instanceof WorkspaceKnowledgeError)) return false;
  const notFound = error.code === 'saved_view_not_found';
  res.status(notFound ? 404 : 400).json({
    error: {
      code: error.code,
      message: notFound ? 'The Saved View was not found.' : 'The Knowledge request is invalid.',
      recovery: notFound ? 'Refresh your Saved Views and try again.' : 'Review the filters, sort, properties, or cursor and try again.',
      retryable: false,
      request_id: res.locals.workspaceRequestId,
    },
  });
  return true;
}

function sendSearchError(res: express.Response, error: unknown): boolean {
  if (!(error instanceof WorkspaceSearchError)) return false;
  res.status(400).json({
    error: {
      code: error.code,
      message: 'The Search request is invalid.',
      recovery: 'Review the search terms, Source selection, filters, or cursor and try again.',
      retryable: false,
      request_id: res.locals.workspaceRequestId,
    },
  });
  return true;
}

function sendAskError(res: express.Response, error: unknown): boolean {
  if (!(error instanceof WorkspaceAskError)) return false;
  const invalid = error.code === 'invalid_question';
  const conflict = error.code === 'ask_not_cancellable';
  res.status(invalid ? 400 : conflict ? 409 : 404).json({
    error: {
      code: error.code,
      message: invalid ? 'Ask 2Brain needs one question.' : conflict ? 'This Ask can no longer be cancelled.' : 'That Ask Result is unavailable.',
      recovery: invalid ? 'Enter one question up to 200 characters.' : conflict ? 'Refresh the Ask Result.' : 'Check current Membership and Source Access.',
      retryable: false,
      request_id: res.locals.workspaceRequestId,
    },
  });
  return true;
}

function sendPageError(res: express.Response, error: unknown): boolean {
  if (!(error instanceof WorkspacePageError)) return false;
  const notFound = error.code === 'page_not_found';
  res.status(notFound ? 404 : 400).json({
    error: {
      code: error.code,
      message: notFound ? 'The Page is unavailable.' : 'The Page reference is invalid.',
      recovery: notFound
        ? 'Return to Knowledge; the Page may be restricted, archived, or removed.'
        : 'Review the Source ID and Page slug and try again.',
      retryable: false,
      request_id: res.locals.workspaceRequestId,
    },
  });
  return true;
}

function agentApiView(agent: WorkspaceAgentDirectoryEntry) {
  return {
    agent_id: agent.agentId,
    name: agent.name,
    purpose: agent.purpose,
    owner: { membership_id: agent.owner.membershipId, email: agent.owner.email },
    status: agent.status,
    scope: agent.scope,
    source_access: { mode: agent.sourceAccess.mode, source_ids: agent.sourceAccess.sourceIds },
    last_activity_at: agent.lastActivityAt,
    created_at: agent.createdAt,
    revoked_at: agent.revokedAt,
  };
}

function sendAgentError(res: express.Response, error: unknown): boolean {
  if (error instanceof Error && error.message.includes('reason is required')) {
    res.status(400).json({
      error: {
        code: 'reason_required',
        message: 'A reason is required for this Agent authorization change.',
        recovery: 'Provide the reason recorded with the immutable Audit Event.',
        retryable: false,
        request_id: res.locals.workspaceRequestId,
      },
    });
    return true;
  }
  if (!(error instanceof WorkspaceAgentError)) return false;
  const status = error.code === 'agent_not_found' || error.code === 'credential_not_found' ? 404
    : error.code === 'agent_revoked' || error.code === 'managed_agent_operation_required' ? 409
      : 400;
  const messages: Record<typeof error.code, [string, string]> = {
    agent_not_found: ['The Agent was not found.', 'Refresh the Agent Directory and try again.'],
    agent_name_required: ['An Agent name of at most 80 characters is required.', 'Provide the Agent name and try again.'],
    agent_purpose_required: ['An Agent purpose of at most 240 characters is required.', 'Describe what the Agent is accountable for.'],
    agent_owner_not_found: ['The Agent Owner must be an existing Workspace Membership.', 'Pick an active Member as the accountable owner.'],
    agent_revoked: ['A revoked Agent cannot receive new credentials.', 'Reactivate the Agent first, or register a new one.'],
    credential_not_found: ['The credential was not found or is already revoked.', 'Refresh the Agent detail and try again.'],
    invalid_agent_scope: ['The Agent Scope must be Read, Write, or Admin.', 'Pick one cumulative Scope tier.'],
    invalid_agent_status: ['The Agent status must be active or revoked.', 'Pick a supported status.'],
    managed_agent_operation_required: ['The shared OpenClaw Agent is managed by the Workspace runtime.', 'Change its Scope and Sources from Agent access settings.'],
    invalid_source_access_grant: ['The Source Access grant is invalid.', 'Use immutable Source IDs with All, Specific, or None.'],
    specific_source_access_required: ['Specific Source Access needs at least one Source.', 'Select at least one Source or choose No Source Access.'],
  };
  res.status(status).json({
    error: {
      code: error.code,
      message: messages[error.code][0],
      recovery: messages[error.code][1],
      retryable: false,
      request_id: res.locals.workspaceRequestId,
    },
  });
  return true;
}

/**
 * #68: the closed refusal vocabulary of the Agent customer APIs.
 *
 * A code that is not in this table cannot be sent, so no upstream OpenClaw
 * message, database error, or internal exception text can ever reach a client
 * as an "error code". Every entry names a state of THIS Workspace's shared
 * runtime and nothing about the machinery underneath it.
 */
const AGENT_ACCESS_REFUSALS = {
  agent_setup_incomplete: [409,
    'The shared Agent is not finished setting up.',
    'Wait for setup to finish, then refresh Agent access settings.'],
  agent_warning_required: [409,
    'The current shared-state warning has not been acknowledged.',
    'Read and acknowledge the shared-access warning, then try again.'],
  // The recovery deliberately does not promise that confirming is the last
  // step: a grant zeroes the verified MCP generation too, so the runtime is
  // usually still reconfiguring once the Administrator has confirmed.
  agent_grant_confirmation_needed: [409,
    'The current Agent grant has not been confirmed.',
    'Review the Agent Scope and Sources and confirm the grant; the runtime then finishes applying it.'],
  agent_operation_conflict: [409,
    'That Agent runtime operation conflicts with one already recorded.',
    'Refresh Agent access settings and try again.'],
  agent_operation_not_found: [404,
    'That Agent runtime operation is not repairable.',
    'Refresh Agent access settings; a newer change has replaced it.'],
  agent_native_rotation_pending: [503,
    'The shared native password is being rotated.',
    'Wait for the rotation to finish, then request access again.'],
  // #68 Task 10. Each names a state of THIS Workspace's setup. None of them
  // relays a provider, plan, account, quota, or upstream error string — the
  // Administrator is told what to do next, not what the vendor said.
  invalid_provider: [400,
    'The provider must be Codex or Claude.',
    'Pick one of the two required subscriptions and run its check again.'],
  invalid_provider_credential: [400,
    'A provider credential is required.',
    'Paste the credential and try connecting again.'],
  required_model_unavailable: [409,
    'The required model is not available to this Agent.',
    'Check that the subscription is connected and includes the required model, then run the check again.'],
  agent_provider_import_failed: [503,
    'The shared Agent runtime did not accept that provider connection.',
    'Confirm the credential is current, then try connecting again.'],
  agent_model_check_failed: [503,
    'The model check did not complete.',
    'Retry the check. If it keeps failing, confirm the subscription is connected.'],
  agent_answer_proof_failed: [503,
    'The shared Agent did not return an answer.',
    'Confirm both required subscriptions are connected and checked, then run the answer check again.'],
  openclaw_runtime_unavailable: [503,
    'The shared Agent runtime is not available.',
    'Retry shortly. If it persists, give an Administrator the request ID.'],
} as const;

type AgentAccessRefusal = keyof typeof AGENT_ACCESS_REFUSALS;

/**
 * Readiness blockers that earn a refusal code of their own.
 *
 * A blocker is listed here only when the caller can act on it directly;
 * everything else is the reconciler's work and collapses into
 * `agent_setup_incomplete`. Lookup walks `AgentReadiness.blockers`, which
 * `evaluateAgentReadiness` builds in a fixed order, so when several blockers
 * hold at once the earliest listed one answers.
 */
const BLOCKER_REFUSALS: Partial<Record<AgentReadinessBlocker, AgentAccessRefusal>> = {
  grant_unconfirmed: 'agent_grant_confirmation_needed',
};

/**
 * A grant is confirmed only at the CURRENT revision; a stale confirmation of an
 * older, narrower grant is not one. Spelled once so the status projection and
 * the grant response cannot drift into two different rules.
 *
 * There is no `accessRevision >= 1` guard here: `workspace_agent_runtime_bindings`
 * declares `access_revision INTEGER NOT NULL DEFAULT 1 CHECK (access_revision > 0)`,
 * so the storage layer already refuses a non-positive revision — proved by a
 * test rather than restated as an unreachable branch.
 */
function grantConfirmed(status: Pick<AgentAccessStatus, 'accessRevision' | 'accessConfirmedRevision'>): boolean {
  return status.accessConfirmedRevision === status.accessRevision;
}

function refuseAgentAccess(res: express.Response, code: AgentAccessRefusal): void {
  const [status, message, recovery] = AGENT_ACCESS_REFUSALS[code];
  res.status(status).json({
    error: {
      code,
      message,
      recovery,
      // Only the 503s describe a state that resolves on its own.
      retryable: status === 503,
      request_id: res.locals.workspaceRequestId,
    },
  });
}

/**
 * Map the bound-Agent domain errors onto that closed vocabulary.
 *
 * `AgentAccessError.message` IS its code, and several of those codes describe
 * deployment secrets (`agent_password_secret_changed`) — they are deliberately
 * collapsed to a generic unavailability rather than forwarded, so the API is
 * not an oracle for the state of the deployment secret.
 */
function sendAgentAccessError(res: express.Response, error: unknown): boolean {
  if (!(error instanceof AgentAccessError)) return false;
  const mapped: Record<AgentAccessError['code'], AgentAccessRefusal> = {
    agent_binding_not_found: 'agent_setup_incomplete',
    agent_password_secret_required: 'openclaw_runtime_unavailable',
    agent_password_secret_changed: 'openclaw_runtime_unavailable',
    invalid_agent_password_generation: 'openclaw_runtime_unavailable',
    idempotency_conflict: 'agent_operation_conflict',
    invalid_runtime_operation: 'agent_operation_not_found',
    required_model_unavailable: 'required_model_unavailable',
    provider_import_failed: 'agent_provider_import_failed',
    model_check_failed: 'agent_model_check_failed',
    answer_proof_failed: 'agent_answer_proof_failed',
    // A proof that lost its compare-and-set describes a configuration the
    // Administrator has already replaced. Refreshing and rerunning the check is
    // the same recovery an idempotency clash gets, so it reuses that code
    // rather than inventing a second word for "your view is stale".
    proof_superseded: 'agent_operation_conflict',
  };
  refuseAgentAccess(res, mapped[error.code]);
  return true;
}

function agentActivityEntryApiView(entry: WorkspaceAgentActivityEntry) {
  return {
    activity_id: entry.activityId,
    operation: entry.operation,
    outcome: entry.outcome,
    latency_ms: entry.latencyMs,
    occurred_at: entry.occurredAt,
    request_id: entry.requestId,
    source: entry.source && { source_id: entry.source.sourceId },
    page: entry.page && { source_id: entry.page.sourceId, slug: entry.page.slug },
    relationship: entry.relationship,
    run: entry.run && {
      run_id: entry.run.runId,
      correlation_id: entry.run.correlationId,
      started_at: entry.run.startedAt,
      ended_at: entry.run.endedAt,
      outcome: entry.run.outcome,
      metadata: entry.run.metadata,
    },
    // Request Detail is Administrator-only and appears only when captured.
    ...(entry.requestDetail ? {
      request_detail: {
        redacted: entry.requestDetail.redacted,
        captured_at: entry.requestDetail.capturedAt,
        ...(entry.requestDetail.fullParameters ? { full_parameters: entry.requestDetail.fullParameters } : {}),
      },
    } : {}),
  };
}

function sendAgentActivityError(res: express.Response, error: unknown): boolean {
  if (!(error instanceof WorkspaceAgentActivityError)) return false;
  const notFound = error.code === 'agent_not_found' || error.code === 'run_not_found';
  const message = error.code === 'agent_not_found' ? 'The Agent was not found.'
    : error.code === 'run_not_found' ? 'The Agent Run was not found.'
      : 'The Agent Activity request is invalid.';
  res.status(notFound ? 404 : 400).json({
    error: {
      code: error.code,
      message,
      recovery: notFound ? 'Refresh the Agent Directory and try again.' : 'Review the activity request and try again.',
      retryable: false,
      request_id: res.locals.workspaceRequestId,
    },
  });
  return true;
}

function attentionItemApiView(item: WorkspaceAttentionItemView) {
  return {
    item_id: item.itemId,
    category: item.category,
    condition_type: item.conditionType,
    summary: item.summary,
    resource: { type: item.resource.type, id: item.resource.id },
    status: item.status,
    assignee: item.assignee && { membership_id: item.assignee.membershipId, email: item.assignee.email },
    dismiss_reason: item.dismissReason,
    detected_at: item.detectedAt,
    last_verified_at: item.lastVerifiedAt,
    resolved_at: item.resolvedAt,
    dismissed_at: item.dismissedAt,
    evidence: item.evidence,
    episode: {
      episode_id: item.episode.episodeId,
      state: item.episode.state,
      detected_at: item.episode.detectedAt,
      cleared_at: item.episode.clearedAt,
    },
  };
}

function sendAttentionError(res: express.Response, error: unknown): boolean {
  if (!(error instanceof WorkspaceAttentionError)) return false;
  const status = error.code === 'attention_item_not_found' ? 404
    : error.code === 'attention_status_invalid' ? 409
      : 400;
  const messages: Record<typeof error.code, [string, string]> = {
    attention_item_not_found: ['The Attention Item was not found.', 'Refresh the Attention queue and try again.'],
    attention_status_invalid: ['The Attention Item does not support this transition.', 'Refresh the item; its lifecycle state changed.'],
    attention_assignee_not_found: ['The assignee must be an active Workspace Membership.', 'Pick an active Member as the assignee.'],
    attention_viewer_invalid: ['The Attention request is invalid.', 'Review the request and try again.'],
    reason_required: ['A reason is required to dismiss an Attention Item.', 'Provide the reason recorded with the immutable Audit Event.'],
  };
  res.status(status).json({
    error: {
      code: error.code,
      message: messages[error.code][0],
      recovery: messages[error.code][1],
      retryable: false,
      request_id: res.locals.workspaceRequestId,
    },
  });
  return true;
}

function queryText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function queryList(value: unknown): string[] | undefined {
  const text = queryText(value);
  return text === undefined ? undefined : text.split(',').filter(Boolean);
}

/** Modular 2Brain boundary for the shared Workspace and its role-gated Settings. */
export function createWorkspaceRouter(
  engine: WorkspaceRouterEngine,
  options: WorkspaceRouterOptions = {},
): express.Router {
  const router = express.Router();
  const sessionMember = (req: express.Request) => authenticateWorkspaceSession(engine as Parameters<typeof authenticateWorkspaceSession>[0], cookie(req, 'workspace_session'));
  const requireMember = async (req: express.Request, res: express.Response, csrf = false) => {
    const member = await sessionMember(req);
    if (!member) { res.status(401).json({ error: { code: 'unauthorized', request_id: res.locals.workspaceRequestId } }); return null; }
    if (csrf && !await workspaceSessionCsrfMatches(engine, cookie(req, 'workspace_session'), req.header('x-csrf-token'))) {
      res.status(403).json({ error: { code: 'csrf_or_session_invalid', request_id: res.locals.workspaceRequestId } }); return null;
    }
    return member;
  };
  const requireAdministrator = async (req: express.Request, res: express.Response, csrf = false) => {
    const member = await sessionMember(req);
    if (!member) { res.status(401).json({ error: { code: 'unauthorized', request_id: res.locals.workspaceRequestId } }); return null; }
    if (member.role !== 'administrator') { res.status(403).json({ error: { code: 'forbidden', request_id: res.locals.workspaceRequestId } }); return null; }
    if (csrf && !await workspaceSessionCsrfMatches(engine, cookie(req, 'workspace_session'), req.header('x-csrf-token'))) {
      res.status(403).json({ error: { code: 'csrf_or_session_invalid', request_id: res.locals.workspaceRequestId } }); return null;
    }
    return member;
  };
  const auditAuthFailure = async (action: WorkspaceProtectedAction, requestId: string, actor: 'operator' | 'system') => {
    try {
      await appendWorkspaceAuditEvent(engine, {
        actor: { kind: actor, id: actor === 'operator' ? 'bootstrap-credential' : 'workspace-auth' },
        action,
        target: { type: 'workspace', id: 'singleton' },
        requestId,
        outcome: 'failed',
      });
    } catch { /* Preserve the original safe failure response. */ }
  };
  // Per-IP abuse protection for the authentication surface (#37). Magic-link
  // issuance is a paid resource once email delivery is live, and every token
  // endpoint is a brute-force oracle (including the bootstrap-credential
  // operator routes), so the whole surface shares one conservative per-IP
  // budget; refusals use the Workspace error envelope. Of the token landing
  // pages only GET /setup/:token is limited — it calls inspectWorkspaceToken
  // (a token-validity oracle); the other GET pages render static HTML.
  const authRateLimiter = rateLimit({
    windowMs: options.authRateLimit?.windowMs ?? envInt('GBRAIN_WORKSPACE_AUTH_RATE_WINDOW_MS', 15 * 60 * 1000),
    limit: options.authRateLimit?.limit ?? envInt('GBRAIN_WORKSPACE_AUTH_RATE_LIMIT', 20),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => sendWorkspaceError(res, new WorkspaceHttpError('rate_limited', 'login')),
  });
  router.use(workspaceRequestContext(options.requestId));
  router.use(express.json({ limit: '16kb' }));
  router.use('/api/workspace/v1', (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const origin = req.header('origin');
    const expected = options.allowedOrigin ?? `${req.protocol}://${req.get('host')}`;
    const operatorRoute = req.path.startsWith('/operator/');
    if ((!origin && !operatorRoute) || (origin && origin !== expected)) {
      return res.status(403).json({ error: { code: 'origin_not_allowed', request_id: res.locals.workspaceRequestId } });
    }
    next();
  });

  router.get('/api/workspace/v1/live-updates', async (req, res, next) => {
    try {
      const member = await requireMember(req, res);
      if (!member) return;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      const data = await listWorkspaceLiveUpdates(engine, {
        workspaceId: member.workspace_id,
        membershipId: member.membership_id,
        role: member.role as 'administrator' | 'member',
        cursor,
      });
      res.json({ data, request_id: res.locals.workspaceRequestId });
    } catch (error) {
      if (error instanceof WorkspaceLiveUpdateError) {
        const status = error.code === 'unauthorized' ? 401 : 400;
        return res.status(status).json({ error: { code: error.code, request_id: res.locals.workspaceRequestId } });
      }
      next(error);
    }
  });

  router.get('/api/workspace/v1/home', async (req, res, next) => {
    try {
      const member = await requireMember(req, res); if (!member) return;
      const home = await getWorkspaceHome(engine, {
        workspaceId: member.workspace_id,
        viewer: {
          membershipId: member.membership_id,
          role: member.role as 'administrator' | 'member',
        },
      });
      res.json({ data: homeApiView(home), request_id: res.locals.workspaceRequestId });
    } catch (error) { next(error); }
  });

  router.get('/api/workspace/v1/live-updates/stream', async (req, res, next) => {
    try {
      const member = await requireMember(req, res);
      if (!member) return;
      let cursor = req.header('last-event-id')
        ?? (typeof req.query.cursor === 'string' ? req.query.cursor : undefined);
      const first = await listWorkspaceLiveUpdates(engine, {
        workspaceId: member.workspace_id,
        membershipId: member.membership_id,
        role: member.role as 'administrator' | 'member',
        cursor,
      });
      res.status(200).set({
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.flushHeaders();

      let closed = false;
      let inFlight = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const stop = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
      };
      res.on('close', stop);

      const writeBatch = (batch: Awaited<ReturnType<typeof listWorkspaceLiveUpdates>>) => {
        for (const event of batch.events) {
          res.write(`id: ${event.cursor}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`);
        }
        if (batch.cursor !== cursor) {
          res.write(`id: ${batch.cursor}\nevent: checkpoint\ndata: ${JSON.stringify({ cursor: batch.cursor })}\n\n`);
        }
        cursor = batch.cursor;
      };
      writeBatch(first);

      const push = async () => {
        if (closed || inFlight) return;
        inFlight = true;
        try {
          const current = await sessionMember(req);
          if (!current) {
            res.write('event: access-revoked\ndata: {}\n\n');
            stop();
            res.end();
            return;
          }
          const batch = await listWorkspaceLiveUpdates(engine, {
            workspaceId: current.workspace_id,
            membershipId: current.membership_id,
            role: current.role as 'administrator' | 'member',
            cursor,
          });
          if (batch.events.length === 0 && batch.cursor === cursor) res.write(': keep-alive\n\n');
          writeBatch(batch);
        } catch {
          if (!closed) {
            res.write(`event: connection-error\ndata: ${JSON.stringify({ request_id: res.locals.workspaceRequestId })}\n\n`);
            stop();
            res.end();
          }
        } finally {
          inFlight = false;
        }
      };
      const interval = Math.max(options.liveUpdateIntervalMs ?? 1_000, 10);
      timer = setInterval(() => { void push(); }, interval);
      timer.unref?.();
    } catch (error) {
      if (error instanceof WorkspaceLiveUpdateError) {
        const status = error.code === 'unauthorized' ? 401 : 400;
        return res.status(status).json({ error: { code: error.code, request_id: res.locals.workspaceRequestId } });
      }
      next(error);
    }
  });

  const sendNotificationError = (res: express.Response, error: unknown): boolean => {
    if (!(error instanceof WorkspaceNotificationError)) return false;
    const status = error.code === 'notification_not_found' ? 404
      : error.code === 'unauthorized' ? 401 : 400;
    res.status(status).json({
      error: {
        code: error.code,
        message: error.code === 'notification_not_found'
          ? 'The Notification was not found.'
          : 'The Notification request is invalid.',
        recovery: 'Refresh Notifications and try again.',
        retryable: false,
        request_id: res.locals.workspaceRequestId,
      },
    });
    return true;
  };

  router.get('/api/workspace/v1/notifications/unread-count', async (req, res, next) => {
    try {
      const member = await requireMember(req, res); if (!member) return;
      const unreadCount = await countWorkspaceUnreadNotifications(engine, {
        workspaceId: member.workspace_id, membershipId: member.membership_id,
      });
      res.json({ data: { unread_count: unreadCount }, request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendNotificationError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/notifications', async (req, res, next) => {
    try {
      const member = await requireMember(req, res); if (!member) return;
      const page = await listWorkspaceNotifications(engine, {
        workspaceId: member.workspace_id,
        membershipId: member.membership_id,
        cursor: queryText(req.query.cursor),
        limit: req.query.limit === undefined ? undefined : Number(queryText(req.query.limit)),
      });
      res.json({
        data: { items: page.items.map(notificationApiView), next_cursor: page.nextCursor },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendNotificationError(res, error)) next(error); }
  });

  router.patch('/api/workspace/v1/notifications/:notificationId/read', async (req, res, next) => {
    try {
      const member = await requireMember(req, res, true); if (!member) return;
      if (typeof req.body?.read !== 'boolean') {
        throw new WorkspaceNotificationError('invalid_notification_read_state');
      }
      const notification = await setWorkspaceNotificationRead(engine, {
        workspaceId: member.workspace_id, membershipId: member.membership_id,
        notificationId: req.params.notificationId, read: req.body.read,
      });
      res.json({ data: notificationApiView(notification), request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendNotificationError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/notifications/:notificationId/archive', async (req, res, next) => {
    try {
      const member = await requireMember(req, res, true); if (!member) return;
      const notification = await archiveWorkspaceNotification(engine, {
        workspaceId: member.workspace_id, membershipId: member.membership_id,
        notificationId: req.params.notificationId,
      });
      res.json({ data: notificationApiView(notification), request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendNotificationError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/operator/links', authRateLimiter, async (req, res, next) => {
    try {
      const provided = req.header('authorization')?.replace(/^Bootstrap\s+/i, '');
      const expected = options.bootstrapCredential ?? process.env.GBRAIN_BOOTSTRAP_CREDENTIAL;
      if (!bootstrapCredentialMatches(provided, expected)) return res.status(401).json({ error: { code: 'unauthorized', request_id: res.locals.workspaceRequestId } });
      if (req.body?.purpose !== 'setup' && req.body?.purpose !== 'recovery') return res.status(400).json({ error: { code: 'invalid_purpose', request_id: res.locals.workspaceRequestId } });
      const purpose = req.body.purpose;
      // Optional: a caller that may retry sends a stable key and gets the same
      // link back. Absent, issuance stays random per call.
      const idempotencyKey = req.body?.idempotency_key;
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 200)) {
        return res.status(400).json({ error: { code: 'invalid_idempotency_key', request_id: res.locals.workspaceRequestId } });
      }
      const issued = await issueWorkspaceSetupToken(engine, purpose, {
        email: req.body?.email,
        idempotencyKey,
        tokenSecret: options.tokenSecret ?? process.env.GBRAIN_WORKSPACE_TOKEN_SECRET,
      });
      res.status(201).json({ data: { purpose, token: issued }, request_id: res.locals.workspaceRequestId });
    } catch (error) { next(error); }
  });

  router.post('/api/workspace/v1/operator/outbox/:deliveryKey/retry', authRateLimiter, async (req, res, next) => {
    try {
      const provided = req.header('authorization')?.replace(/^Bootstrap\s+/i, '');
      const expected = options.bootstrapCredential ?? process.env.GBRAIN_BOOTSTRAP_CREDENTIAL;
      if (!bootstrapCredentialMatches(provided, expected)) return res.status(401).json({ error: { code: 'unauthorized', request_id: res.locals.workspaceRequestId } });
      const secret = options.tokenSecret ?? process.env.GBRAIN_WORKSPACE_TOKEN_SECRET;
      if (!secret || !options.deliverConfirmation) return res.status(503).json({ error: { code: 'delivery_not_configured', request_id: res.locals.workspaceRequestId } });
      const rows = await engine.executeRaw<{ recipient_email: string; request_id: string }>(
        "SELECT recipient_email, request_id FROM workspace_email_outbox WHERE delivery_key=$1 AND delivery_state IN ('pending','failed')",
        [req.params.deliveryKey],
      );
      if (!rows[0]) return res.status(404).json({ error: { code: 'delivery_not_found', request_id: res.locals.workspaceRequestId } });
      const renewed = await renewWorkspaceConfirmation(engine, rows[0].recipient_email, rows[0].request_id, secret);
      try {
        await options.deliverConfirmation({ email: rows[0].recipient_email, token: renewed.confirmationToken, purpose: 'confirmation' });
        await engine.executeRaw("UPDATE workspace_email_outbox SET delivery_state='sent' WHERE delivery_key=$1", [renewed.deliveryKey]);
      } catch (error) {
        await engine.executeRaw("UPDATE workspace_email_outbox SET delivery_state='failed' WHERE delivery_key=$1", [renewed.deliveryKey]);
        throw error;
      }
      res.json({ data: { state: 'sent', delivery_key: renewed.deliveryKey }, request_id: res.locals.workspaceRequestId });
    } catch (error) { next(error); }
  });

  router.get('/api/workspace/v1/operator/outbox', authRateLimiter, async (req, res, next) => {
    try {
      const provided = req.header('authorization')?.replace(/^Bootstrap\s+/i, '');
      const expected = options.bootstrapCredential ?? process.env.GBRAIN_BOOTSTRAP_CREDENTIAL;
      if (!bootstrapCredentialMatches(provided, expected)) return res.status(401).json({ error: { code: 'unauthorized', request_id: res.locals.workspaceRequestId } });
      const requestId = typeof req.query.request_id === 'string' ? req.query.request_id : '';
      if (!requestId) return res.status(400).json({ error: { code: 'request_id_required', request_id: res.locals.workspaceRequestId } });
      const rows = await engine.executeRaw<{ delivery_key: string; delivery_state: string; created_at: string }>(
        'SELECT delivery_key, delivery_state, created_at FROM workspace_email_outbox WHERE request_id=$1 ORDER BY created_at DESC',
        [requestId],
      );
      res.json({ data: rows, request_id: res.locals.workspaceRequestId });
    } catch (error) { next(error); }
  });

  router.get('/setup/:token', authRateLimiter, async (req: express.Request<{ token: string }>, res, next) => {
    try {
      const state = await inspectWorkspaceToken(engine, req.params.token, 'setup');
      res.type('html').send(setupDocument(req.params.token, res.locals.workspaceRequestId, state.valid));
    } catch (error) { next(error); }
  });

  router.post('/api/workspace/v1/setup', authRateLimiter, async (req, res, next) => {
    try {
      const secret = options.tokenSecret ?? process.env.GBRAIN_WORKSPACE_TOKEN_SECRET;
      if (!secret) throw new Error('Workspace token secret is not configured.');
      const pending = await beginWorkspaceSetup(engine, req.body?.token ?? '', req.body?.workspace_name ?? '', req.body?.administrator_email ?? '', res.locals.workspaceRequestId, secret);
      let state = 'delivery_queued';
      if (options.deliverConfirmation) {
        try {
          await options.deliverConfirmation({ email: req.body.administrator_email, token: pending.confirmationToken, purpose: 'confirmation' });
          await engine.executeRaw("UPDATE workspace_email_outbox SET delivery_state='sent' WHERE delivery_key=$1", [pending.deliveryKey]);
          state = 'email_confirmation_required';
        } catch (error) {
          await engine.executeRaw("UPDATE workspace_email_outbox SET delivery_state='failed' WHERE delivery_key=$1", [pending.deliveryKey]);
          throw error;
        }
      }
      res.status(202).json({ data: { state }, request_id: res.locals.workspaceRequestId });
    } catch (error) { await auditAuthFailure('workspace.setup', res.locals.workspaceRequestId, 'operator'); next(error); }
  });

  router.post('/api/workspace/v1/setup/confirm', authRateLimiter, async (req, res, next) => {
    try {
      const auth = await confirmFirstAdministrator(engine, req.body?.token ?? '', res.locals.workspaceRequestId);
      res.cookie('workspace_session', auth.session, { httpOnly: true, sameSite: 'lax', secure: options.production ?? process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });
      res.status(200).json({ data: { state: 'active', csrf_token: auth.csrf }, request_id: res.locals.workspaceRequestId });
    } catch (error) { await auditAuthFailure('workspace.setup.confirm', res.locals.workspaceRequestId, 'system'); next(error); }
  });

  router.get('/confirm/:token', (req, res) => res.type('html').send(confirmDocument(req.params.token, res.locals.workspaceRequestId, 'confirm')));
  router.get('/recover/:token', (req, res) => res.type('html').send(confirmDocument(req.params.token, res.locals.workspaceRequestId, 'recovery')));
  router.get('/login/redeem/:token', (req, res) => res.type('html').send(confirmDocument(req.params.token, res.locals.workspaceRequestId, 'login')));
  // #68 Task 11: the Agent-tier flag is passed EXPLICITLY. A default-argument
  // read here would make a Brain-tier page depend on the shell's default rather
  // than on this deployment's tier.
  router.get('/invitations/:token', (req, res) => res.type('html').send(invitationDocument(
    req.params.token,
    res.locals.workspaceRequestId,
    process.env.GBRAIN_AGENT_TIER?.trim().toLowerCase() === 'true',
  )));
  router.post('/api/workspace/v1/recovery/redeem', authRateLimiter, async (req, res, next) => {
    try {
      const auth = await redeemWorkspaceRecovery(engine, req.body?.token ?? '', res.locals.workspaceRequestId);
      res.cookie('workspace_session', auth.session, { httpOnly: true, sameSite: 'lax', secure: options.production ?? process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });
      res.json({ data: { state: 'active', csrf_token: auth.csrf }, request_id: res.locals.workspaceRequestId });
    } catch (error) { await auditAuthFailure('workspace.recovery', res.locals.workspaceRequestId, 'operator'); next(error); }
  });

  router.post('/api/workspace/v1/login/redeem', authRateLimiter, async (req, res, next) => {
    try {
      const auth = await redeemWorkspaceLogin(engine, req.body?.token ?? '', res.locals.workspaceRequestId);
      res.cookie('workspace_session', auth.session, { httpOnly: true, sameSite: 'lax', secure: options.production ?? process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });
      res.json({ data: { state: 'active', csrf_token: auth.csrf }, request_id: res.locals.workspaceRequestId });
    } catch (error) { await auditAuthFailure('workspace.login', res.locals.workspaceRequestId, 'system'); next(error); }
  });

  router.post('/api/workspace/v1/login/request', authRateLimiter, async (req, res, next) => {
    const requestId = res.locals.workspaceRequestId;
    try {
      const secret = options.tokenSecret ?? process.env.GBRAIN_WORKSPACE_TOKEN_SECRET;
      if (!secret) throw new Error('Workspace token secret is not configured.');
      try {
        const pending = await requestWorkspaceLogin(engine, req.body?.email ?? '', requestId, secret);
        if (options.deliverConfirmation) {
          // A delivery failure must not change the response: 202 either way
          // keeps the endpoint enumeration-safe, and the failed outbox row is
          // the operator's retry signal (same posture as the setup flow).
          try {
            await options.deliverConfirmation({ email: req.body.email, token: pending.loginToken, purpose: 'login' });
            await engine.executeRaw("UPDATE workspace_email_outbox SET delivery_state='sent' WHERE delivery_key=$1", [pending.deliveryKey]);
          } catch {
            await engine.executeRaw("UPDATE workspace_email_outbox SET delivery_state='failed' WHERE delivery_key=$1", [pending.deliveryKey]);
          }
        }
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'login_identity_not_found') throw error;
      }
      res.status(202).json({ data: { state: 'sign_in_link_requested' }, request_id: requestId });
    } catch (error) { next(error); }
  });

  router.get('/login', (_req, res) => {
    res.type('html').send(loginDocument(res.locals.workspaceRequestId));
  });

  router.post('/api/workspace/v1/invitations', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      if (!options.deliverConfirmation) return res.status(503).json({ error: { code: 'delivery_not_configured', request_id: res.locals.workspaceRequestId } });
      const invitation = await createWorkspaceInvitation(engine, { workspaceId: admin.workspace_id, email: req.body?.email ?? '', role: req.body?.role, sourceAccess: req.body?.source_access, actorMembershipId: admin.membership_id, requestId: res.locals.workspaceRequestId });
      await options.deliverConfirmation({ email: req.body.email, token: invitation.token, purpose: 'invitation' });
      res.status(201).json({ data: { invitation_id: invitation.invitationId, state: 'sent' }, request_id: res.locals.workspaceRequestId });
    } catch (error) { next(error); }
  });

  /**
   * POST /api/workspace/v1/invitations/redeem
   *
   * #68 Task 11: on Agent tier, accepting an invitation IS the moment a Member
   * gains a share of the runtime's files, credentials, browser, memory, and
   * GBrain authority, so the shared-state acknowledgment is required before the
   * single-use token is consumed. The check is `=== true`, not truthiness: a
   * string, a number, or a present-but-false field must not read as consent.
   *
   * The revision is supplied by the SERVER. `AGENT_WARNING_REVISION` is the only
   * value that can ever be recorded, so a browser cannot acknowledge a revision
   * that does not exist yet or re-assert a superseded one, and it lands inside
   * `redeemWorkspaceInvitation`'s own transaction — a Member never exists,
   * even momentarily, without the acknowledgment that let them in.
   */
  router.post('/api/workspace/v1/invitations/redeem', authRateLimiter, async (req, res, next) => {
    try {
      const tierIsAgent = process.env.GBRAIN_AGENT_TIER?.trim().toLowerCase() === 'true';
      if (tierIsAgent && req.body?.agent_warning_ack !== true) {
        return refuseAgentAccess(res, 'agent_warning_required');
      }
      const auth = await redeemWorkspaceInvitation(
        engine, req.body?.token ?? '', req.body?.email ?? '', res.locals.workspaceRequestId,
        tierIsAgent ? AGENT_WARNING_REVISION : undefined,
      );
      res.cookie('workspace_session', auth.session, { httpOnly: true, sameSite: 'lax', secure: options.production ?? process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });
      res.json({ data: { state: 'active', csrf_token: auth.csrf }, request_id: res.locals.workspaceRequestId });
    } catch (error) { next(error); }
  });

  router.get('/api/workspace/v1/memberships', async (req, res, next) => {
    try { const admin = await requireAdministrator(req, res); if (!admin) return; res.json({ data: await listWorkspaceMemberships(engine, admin.workspace_id), request_id: res.locals.workspaceRequestId }); }
    catch (error) { next(error); }
  });

  router.patch('/api/workspace/v1/memberships/:membershipId/role', async (req, res, next) => {
    try { const admin = await requireAdministrator(req, res, true); if (!admin) return; await setWorkspaceMembershipRole(engine, admin.workspace_id, req.params.membershipId, req.body?.role, admin.membership_id, res.locals.workspaceRequestId, req.body?.reason); res.status(204).end(); }
    catch (error) { next(error); }
  });
  router.patch('/api/workspace/v1/memberships/:membershipId/source-access', async (req, res, next) => {
    try { const admin = await requireAdministrator(req, res, true); if (!admin) return; await setWorkspaceMembershipSourceAccess(engine, admin.workspace_id, req.params.membershipId, req.body?.source_access, admin.membership_id, res.locals.workspaceRequestId, req.body?.reason); res.status(204).end(); }
    catch (error) { next(error); }
  });
  /**
   * PATCH /api/workspace/v1/memberships/:membershipId/status — Member
   * disablement is one atomic lifecycle (#68 Task 9): the membership status
   * transition, session revocation, and — on the first active→disabled
   * transition — queuing the shared native-password rotation all commit
   * together inside `setWorkspaceMembershipStatus`.
   *
   * The membership/session mutation has ALREADY committed by the time this
   * handler tries to reconcile the queued rotation. A reconciliation attempt
   * that fails, times out, or finds no runtime configured never rolls back or
   * reactivates the disabled Member — OpenClaw availability is never this
   * Member's problem. The durable worker remains authoritative and will
   * finish the rotation even if this request process exits first.
   */
  router.patch('/api/workspace/v1/memberships/:membershipId/status', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      const result = await setWorkspaceMembershipStatus(
        engine, admin.workspace_id, req.params.membershipId, req.body?.status,
        admin.membership_id, res.locals.workspaceRequestId, req.body?.reason,
      );
      if (result.previousStatus === 'active' && result.status === 'disabled'
        && result.nativeRotationQueued && result.nativeRotationOperationId) {
        const control = agentRuntime();
        const tokenSecret = options.tokenSecret ?? process.env.GBRAIN_WORKSPACE_TOKEN_SECRET;
        let outcome: Awaited<ReturnType<typeof reconcileAgentRuntimeOperation>> | null = null;
        if (control && tokenSecret) {
          try {
            outcome = await reconcileAgentRuntimeOperation(engine, result.nativeRotationOperationId, {
              workerId: `workspace-router-status-${process.pid}`,
              tokenSecret,
              control,
            });
          } catch {
            // An unprovable reconciliation attempt is pending, not a rollback:
            // the disable already committed and the durable worker retries.
            outcome = null;
          }
        }
        if (outcome === 'succeeded') {
          return res.status(200).json({
            data: { status: 'disabled', native_access: 'rotated' },
            request_id: res.locals.workspaceRequestId,
          });
        }
        return res.status(202).json({
          data: { status: 'disabled', native_access: 'rotation_pending' },
          request_id: res.locals.workspaceRequestId,
        });
      }
      res.status(204).end();
    } catch (error) { next(error); }
  });

  // Connected Apps: one live policy per Membership/Connector Client pair.
  // Members see their own pairs; Administrators see every pair, including
  // disabled-Member connections whose effective access is none.
  router.get('/api/workspace/v1/connected-apps', async (req, res, next) => {
    try {
      const member = await requireMember(req, res);
      if (!member) return;
      if (member.role !== 'administrator' && member.role !== 'member') {
        throw new ConnectedAppAccessDeniedError();
      }
      const rows = await listConnectedApps(engine, {
        membershipId: member.membership_id,
        role: member.role,
      });
      res.json({ data: rows.map(connectedAppApiView), request_id: res.locals.workspaceRequestId });
    } catch (error) { next(error); }
  });

  const changeConnectedAppForActor = async (
    actor: { membership_id: string; role: string },
    membershipId: string,
    clientId: string,
    accessLevel: unknown,
    requestId: string,
  ): Promise<ConnectedAppProjection> => {
    if (actor.role !== 'administrator' && actor.role !== 'member') {
      throw new ConnectedAppAccessDeniedError();
    }
    if (actor.role !== 'administrator') {
      return changeConnectedAppAccess(engine, { membershipId, clientId, accessLevel });
    }
    const result = await runProtectedWorkspaceMutation(engine, {
      actor: { kind: 'member', id: actor.membership_id },
      action: 'connected_app.access_level.change',
      target: { type: 'connected_app', id: `${membershipId}:${clientId}` },
      requestId,
    }, transaction => changeConnectedAppAccessInTransaction(transaction, {
      membershipId,
      clientId,
      accessLevel,
    }), {
      eventForResult: changed => ({
        before: connectedAppAuditState(changed.before),
        after: connectedAppAuditState(changed.after),
      }),
    });
    return result.after;
  };

  const revokeConnectedAppForActor = async (
    actor: { membership_id: string; role: string },
    membershipId: string,
    clientId: string,
    requestId: string,
  ): Promise<void> => {
    if (actor.role !== 'administrator' && actor.role !== 'member') {
      throw new ConnectedAppAccessDeniedError();
    }
    if (actor.role !== 'administrator') {
      await revokeConnectedApp(engine, { membershipId, clientId });
      return;
    }
    await runProtectedWorkspaceMutation(engine, {
      actor: { kind: 'member', id: actor.membership_id },
      action: 'connected_app.revoke',
      target: { type: 'connected_app', id: `${membershipId}:${clientId}` },
      requestId,
    }, transaction => revokeConnectedAppInTransaction(transaction, { membershipId, clientId }), {
      eventForResult: previous => ({
        before: connectedAppAuditState(previous),
        after: { membership_id: membershipId, client_id: clientId, revoked: true },
      }),
    });
  };

  router.patch('/api/workspace/v1/connected-apps/:clientId', async (req, res, next) => {
    try {
      const member = await requireMember(req, res, true);
      if (!member) return;
      const changed = await changeConnectedAppForActor(
        member,
        member.membership_id,
        req.params.clientId,
        req.body?.access_level,
        res.locals.workspaceRequestId,
      );
      res.json({ data: connectedAppApiView(changed), request_id: res.locals.workspaceRequestId });
    } catch (error) { next(error); }
  });

  router.delete('/api/workspace/v1/connected-apps/:clientId', async (req, res, next) => {
    try {
      const member = await requireMember(req, res, true);
      if (!member) return;
      await revokeConnectedAppForActor(
        member,
        member.membership_id,
        req.params.clientId,
        res.locals.workspaceRequestId,
      );
      res.json({ data: { revoked: true }, request_id: res.locals.workspaceRequestId });
    } catch (error) { next(error); }
  });

  router.patch('/api/workspace/v1/connected-apps/:membershipId/:clientId', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res, true);
      if (!admin) return;
      const changed = await changeConnectedAppForActor(
        admin,
        req.params.membershipId,
        req.params.clientId,
        req.body?.access_level,
        res.locals.workspaceRequestId,
      );
      res.json({ data: connectedAppApiView(changed), request_id: res.locals.workspaceRequestId });
    } catch (error) { next(error); }
  });

  router.delete('/api/workspace/v1/connected-apps/:membershipId/:clientId', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res, true);
      if (!admin) return;
      await revokeConnectedAppForActor(
        admin,
        req.params.membershipId,
        req.params.clientId,
        res.locals.workspaceRequestId,
      );
      res.json({ data: { revoked: true }, request_id: res.locals.workspaceRequestId });
    } catch (error) { next(error); }
  });

  router.post('/api/workspace/v1/sources', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      if (['local_path', 'path', 'clone_dir', 'cloneDir'].some(field => Object.hasOwn(req.body ?? {}, field))) {
        throw new WorkspaceSourceProvisioningError('filesystem_path_not_allowed', 'filesystem_path_not_allowed');
      }
      const queued = await queueManagedGitSource(engine, {
        workspaceId: admin.workspace_id,
        sourceId: req.body?.source_id ?? '',
        name: req.body?.name ?? '',
        remoteUrl: req.body?.remote_url ?? '',
        expectedCadence: req.body?.expected_cadence ?? '',
        includedInWorkspaceSearch: req.body?.included_in_workspace_search,
        actorMembershipId: admin.membership_id,
        requestId: res.locals.workspaceRequestId,
        idempotencyKey: req.header('idempotency-key') ?? '',
      });
      res.status(202).json({
        data: { source: sourceApiView(queued.source), operation: operationApiView(queued.operation) },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendProvisioningError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/sources', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res); if (!admin) return;
      const sources = req.query.state === 'archived'
        ? await listArchivedManagedGitSources(engine, admin.workspace_id)
        : await listManagedGitSources(engine, admin.workspace_id);
      res.json({ data: sources.map(sourceApiView), request_id: res.locals.workspaceRequestId });
    } catch (error) { next(error); }
  });

  for (const [suffix, mutate] of [
    ['archive', archiveWorkspaceSource],
    ['restore', restoreWorkspaceSource],
  ] as const) {
    router.post(`/api/workspace/v1/sources/:sourceId/${suffix}`, async (req, res, next) => {
      try {
        const admin = await requireAdministrator(req, res, true); if (!admin) return;
        const result = await mutate(engine, {
          workspaceId: admin.workspace_id,
          sourceId: req.params.sourceId,
          actorMembershipId: admin.membership_id,
          requestId: res.locals.workspaceRequestId,
          reason: req.body?.reason,
        });
        res.json({
          data: {
            source_id: result.sourceId,
            lifecycle_state: result.lifecycleState,
            archived_at: result.archivedAt,
            changed: result.changed,
          },
          request_id: res.locals.workspaceRequestId,
        });
      } catch (error) { if (!sendSourceLifecycleError(res, error)) next(error); }
    });
  }

  router.get('/api/workspace/v1/sources/:sourceId/deletion-impact', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res); if (!admin) return;
      const impact = await previewSourceDeletionImpact(engine, {
        workspaceId: admin.workspace_id,
        sourceId: req.params.sourceId,
        actorMembershipId: admin.membership_id,
      });
      res.json({ data: deletionImpactApiView(impact), request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendSourceDeletionError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/sources/:sourceId/permanently-delete', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      const operation = await queueSourcePermanentDeletion(engine, {
        workspaceId: admin.workspace_id,
        sourceId: req.params.sourceId,
        confirmationSourceId: req.body?.confirm_source_id ?? '',
        reason: req.body?.reason ?? '',
        actorMembershipId: admin.membership_id,
        requestId: res.locals.workspaceRequestId,
        idempotencyKey: req.header('idempotency-key') ?? '',
      });
      res.status(202).json({ data: operationApiView(operation), request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendSourceDeletionError(res, error)) next(error); }
  });

  for (const [suffix, type] of [['verify', 'source.verify'], ['synchronize', 'source.sync']] as const) {
    router.post(`/api/workspace/v1/sources/:sourceId/${suffix}`, async (req, res, next) => {
      try {
        const admin = await requireAdministrator(req, res, true); if (!admin) return;
        const operation = await queueSourceMaintenance(engine, {
          workspaceId: admin.workspace_id, sourceId: req.params.sourceId, type,
          actorMembershipId: admin.membership_id, requestId: res.locals.workspaceRequestId,
          idempotencyKey: req.header('idempotency-key') ?? '',
        });
        res.status(202).json({ data: operationApiView(operation), request_id: res.locals.workspaceRequestId });
      } catch (error) { next(error); }
    });
  }

  router.get('/api/workspace/v1/operations/:operationId', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res); if (!admin) return;
      const operation = await getBackgroundOperation(engine, admin.workspace_id, req.params.operationId);
      if (!operation) throw new WorkspaceSourceProvisioningError('operation_not_found', 'operation_not_found');
      res.json({ data: operationApiView(operation), request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendProvisioningError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/operations', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res); if (!admin) return;
      const operations = await listBackgroundOperations(engine, admin.workspace_id);
      res.json({ data: operations.map(operationApiView), request_id: res.locals.workspaceRequestId });
    } catch (error) { next(error); }
  });

  router.post('/api/workspace/v1/operations/:operationId/retry', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      const operation = await retryBackgroundOperation(engine, {
        workspaceId: admin.workspace_id, operationId: req.params.operationId,
        actorMembershipId: admin.membership_id, requestId: res.locals.workspaceRequestId,
      });
      res.status(202).json({ data: operationApiView(operation), request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendProvisioningError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/operations/:operationId/cancel', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      const operation = await cancelBackgroundOperation(engine, {
        workspaceId: admin.workspace_id, operationId: req.params.operationId,
        actorMembershipId: admin.membership_id, requestId: res.locals.workspaceRequestId,
      });
      res.json({ data: operationApiView(operation), request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendProvisioningError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/exports', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      const idempotencyKey = typeof req.body?.idempotency_key === 'string' && req.body.idempotency_key.trim()
        ? req.body.idempotency_key
        : res.locals.workspaceRequestId;
      const view = await requestWorkspaceExport(engine, {
        workspaceId: admin.workspace_id,
        actorMembershipId: admin.membership_id,
        requestId: res.locals.workspaceRequestId,
        idempotencyKey,
      });
      res.status(202).json({ data: exportApiView(view), request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendExportError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/exports', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res); if (!admin) return;
      const views = await listWorkspaceExports(engine, admin.workspace_id);
      res.json({ data: views.map(exportApiView), request_id: res.locals.workspaceRequestId });
    } catch (error) { next(error); }
  });

  router.get('/api/workspace/v1/exports/:exportId', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res); if (!admin) return;
      const view = await getWorkspaceExport(engine, admin.workspace_id, req.params.exportId);
      if (!view) throw new WorkspaceExportError('export_not_found', 'export_not_found');
      res.json({ data: exportApiView(view), request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendExportError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/exports/:exportId/artifact', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res); if (!admin) return;
      const artifact = await retrieveWorkspaceExportArtifact(engine, {
        workspaceId: admin.workspace_id,
        exportId: req.params.exportId,
        actorMembershipId: admin.membership_id,
        requestId: res.locals.workspaceRequestId,
      });
      res.json({
        data: {
          manifest: artifact.manifest,
          checksum: artifact.checksum,
          byte_size: artifact.byteSize,
          expires_at: artifact.expiresAt,
          content: artifact.content,
        },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendExportError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/exports/:exportId/retry', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      const view = await retryWorkspaceExport(engine, {
        workspaceId: admin.workspace_id, exportId: req.params.exportId,
        actorMembershipId: admin.membership_id, requestId: res.locals.workspaceRequestId,
      });
      res.status(202).json({ data: exportApiView(view), request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendExportError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/exports/:exportId/cancel', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      const view = await cancelWorkspaceExport(engine, {
        workspaceId: admin.workspace_id, exportId: req.params.exportId,
        actorMembershipId: admin.membership_id, requestId: res.locals.workspaceRequestId,
      });
      res.json({ data: exportApiView(view), request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendExportError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/knowledge', async (req, res, next) => {
    try {
      const member = await requireMember(req, res); if (!member) return;
      const sortProperty = queryText(req.query.sort);
      const sortDirection = queryText(req.query.direction);
      const result = await listWorkspaceKnowledge(engine, {
        workspaceId: member.workspace_id,
        membershipId: member.membership_id,
        filters: {
          search: queryText(req.query.search),
          source_ids: queryList(req.query.source),
          types: queryList(req.query.type),
          evidence_statuses: queryList(req.query.evidence) as never,
          freshness_states: queryList(req.query.freshness) as never,
        },
        ...(sortProperty || sortDirection ? { sort: { property: sortProperty, direction: sortDirection } as WorkspaceKnowledgeSort } : {}),
        visibleProperties: queryList(req.query.visible) as WorkspaceKnowledgeProperty[] | undefined,
        limit: req.query.limit === undefined ? undefined : Number(queryText(req.query.limit)),
        cursor: queryText(req.query.cursor),
      });
      res.json({ data: result, request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendKnowledgeError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/knowledge/saved-views', async (req, res, next) => {
    try {
      const member = await requireMember(req, res); if (!member) return;
      const views = await listWorkspaceSavedViews(engine, member.workspace_id, member.membership_id);
      res.json({ data: views, request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendKnowledgeError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/knowledge/saved-views', async (req, res, next) => {
    try {
      const member = await requireMember(req, res, true); if (!member) return;
      const view = await createWorkspaceSavedView(engine, {
        workspaceId: member.workspace_id,
        membershipId: member.membership_id,
        name: req.body?.name,
        filters: req.body?.filters,
        sort: req.body?.sort,
        visibleProperties: req.body?.visible_properties,
      });
      res.status(201).json({ data: view, request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendKnowledgeError(res, error)) next(error); }
  });

  router.patch('/api/workspace/v1/knowledge/saved-views/:viewId', async (req, res, next) => {
    try {
      const member = await requireMember(req, res, true); if (!member) return;
      const view = await updateWorkspaceSavedView(engine, {
        workspaceId: member.workspace_id,
        membershipId: member.membership_id,
        viewId: req.params.viewId,
        name: req.body?.name,
        filters: req.body?.filters,
        sort: req.body?.sort,
        visibleProperties: req.body?.visible_properties,
      });
      res.json({ data: view, request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendKnowledgeError(res, error)) next(error); }
  });

  router.delete('/api/workspace/v1/knowledge/saved-views/:viewId', async (req, res, next) => {
    try {
      const member = await requireMember(req, res, true); if (!member) return;
      await deleteWorkspaceSavedView(engine, member.workspace_id, member.membership_id, req.params.viewId);
      res.status(204).end();
    } catch (error) { if (!sendKnowledgeError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/knowledge/saved-views/:viewId/results', async (req, res, next) => {
    try {
      const member = await requireMember(req, res); if (!member) return;
      const result = await openWorkspaceSavedView(engine, {
        workspaceId: member.workspace_id,
        membershipId: member.membership_id,
        viewId: req.params.viewId,
        limit: req.query.limit === undefined ? undefined : Number(queryText(req.query.limit)),
        cursor: queryText(req.query.cursor),
      });
      res.json({ data: result, request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendKnowledgeError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/search', async (req, res, next) => {
    try {
      const member = await requireMember(req, res); if (!member) return;
      const filters: WorkspaceSearchFilters = {
        ...(req.query.type !== undefined ? { types: queryList(req.query.type) } : {}),
        ...(req.query.evidence !== undefined ? { evidence_statuses: queryList(req.query.evidence) as never } : {}),
        ...(req.query.freshness !== undefined ? { freshness_states: queryList(req.query.freshness) as never } : {}),
      };
      const result = await searchWorkspaceKnowledge(engine, {
        workspaceId: member.workspace_id,
        membershipId: member.membership_id,
        query: queryText(req.query.q) ?? '',
        sourceIds: queryList(req.query.source),
        filters,
        limit: req.query.limit === undefined ? undefined : Number(queryText(req.query.limit)),
        cursor: queryText(req.query.cursor),
      });
      res.json({ data: result, request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendSearchError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/search/sources', async (req, res, next) => {
    try {
      const member = await requireMember(req, res); if (!member) return;
      const sources = await listWorkspaceSearchSources(engine, {
        workspaceId: member.workspace_id,
        membershipId: member.membership_id,
      });
      res.json({ data: sources, request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendSearchError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/ask', async (req, res, next) => {
    try {
      const member = await requireMember(req, res, true); if (!member) return;
      const result = await createWorkspaceAsk(engine, {
        workspaceId: member.workspace_id,
        membershipId: member.membership_id,
        question: req.body?.question,
        sourceIds: Array.isArray(req.body?.source_ids) ? req.body.source_ids : undefined,
      });
      res.status(202).json({ data: result, request_id: res.locals.workspaceRequestId });
      setTimeout(() => {
        void runWorkspaceAsk(engine, result.id, options.askSynthesizer ?? conservativeWorkspaceAskSynthesizer);
      }, 0);
    } catch (error) { if (!sendAskError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/ask/:askResultId', async (req, res, next) => {
    try {
      const member = await requireMember(req, res); if (!member) return;
      const result = await getWorkspaceAsk(engine, {
        workspaceId: member.workspace_id,
        membershipId: member.membership_id,
        askResultId: req.params.askResultId,
      });
      res.json({ data: result, request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendAskError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/ask/:askResultId/cancel', async (req, res, next) => {
    try {
      const member = await requireMember(req, res, true); if (!member) return;
      const result = await cancelWorkspaceAsk(engine, {
        workspaceId: member.workspace_id,
        membershipId: member.membership_id,
        askResultId: req.params.askResultId,
      });
      res.json({ data: result, request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendAskError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/knowledge/pages/:sourceId/:slug', async (req, res, next) => {
    try {
      const member = await requireMember(req, res); if (!member) return;
      const detail = await getWorkspacePage(engine, {
        workspaceId: member.workspace_id,
        membershipId: member.membership_id,
        sourceId: req.params.sourceId,
        slug: req.params.slug,
      });
      if (member.role === 'administrator') {
        // Durable Setup Checklist evidence; never let it break the authorized read.
        try {
          await recordWorkspacePageProvenanceInspection(engine, {
            workspaceId: member.workspace_id,
            membershipId: member.membership_id,
            sourceId: req.params.sourceId,
            slug: req.params.slug,
          });
        } catch { /* The inspection record is best-effort evidence. */ }
      }
      res.json({ data: detail, request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendPageError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/knowledge/pages/:sourceId/:slug/versions', async (req, res, next) => {
    try {
      const member = await requireMember(req, res); if (!member) return;
      const versions = await listWorkspacePageVersions(engine, {
        workspaceId: member.workspace_id,
        membershipId: member.membership_id,
        sourceId: req.params.sourceId,
        slug: req.params.slug,
      });
      res.json({ data: { versions }, request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendPageError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/agents', async (req, res, next) => {
    try {
      const member = await requireMember(req, res); if (!member) return;
      const agents = await listWorkspaceAgents(engine, member.workspace_id);
      res.json({ data: agents.map(agentApiView), request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendAgentError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/agents/:agentId', async (req, res, next) => {
    try {
      const member = await requireMember(req, res); if (!member) return;
      const agent = await getWorkspaceAgent(engine, member.workspace_id, req.params.agentId);
      res.json({
        data: {
          ...agentApiView(agent),
          credentials: agent.credentials.map(credential => ({
            credential_id: credential.credentialId,
            type: credential.type,
            created_at: credential.createdAt,
            revoked_at: credential.revokedAt,
            last_used_at: credential.lastUsedAt,
          })),
        },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendAgentError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/agents/:agentId/activity', async (req, res, next) => {
    try {
      const member = await requireMember(req, res); if (!member) return;
      const activity = await listWorkspaceAgentActivity(engine, {
        workspaceId: member.workspace_id,
        agentId: req.params.agentId,
        viewer: {
          membershipId: member.membership_id,
          role: member.role === 'administrator' ? 'administrator' : 'member',
        },
      });
      res.json({
        data: {
          oversight: activity.oversight,
          truncated: activity.truncated,
          entries: activity.entries.map(agentActivityEntryApiView),
        },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendAgentActivityError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/agents', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      const registered = await registerWorkspaceAgent(engine, {
        workspaceId: admin.workspace_id,
        name: req.body?.name ?? '',
        purpose: req.body?.purpose ?? '',
        ownerMembershipId: req.body?.owner_membership_id ?? '',
        scope: req.body?.scope,
        sourceAccess: req.body?.source_access,
        actorMembershipId: admin.membership_id,
        requestId: res.locals.workspaceRequestId,
      });
      res.status(201).json({
        data: {
          agent_id: registered.agentId,
          credential: { credential_id: registered.credential.credentialId, token: registered.credential.token },
        },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendAgentError(res, error)) next(error); }
  });

  router.patch('/api/workspace/v1/agents/:agentId/owner', async (req, res, next) => {
    try { const admin = await requireAdministrator(req, res, true); if (!admin) return; await setWorkspaceAgentOwner(engine, admin.workspace_id, req.params.agentId, req.body?.owner_membership_id ?? '', admin.membership_id, res.locals.workspaceRequestId, req.body?.reason); res.status(204).end(); }
    catch (error) { if (!sendAgentError(res, error)) next(error); }
  });
  router.patch('/api/workspace/v1/agents/:agentId/purpose', async (req, res, next) => {
    try { const admin = await requireAdministrator(req, res, true); if (!admin) return; await setWorkspaceAgentPurpose(engine, admin.workspace_id, req.params.agentId, req.body?.purpose ?? '', admin.membership_id, res.locals.workspaceRequestId, req.body?.reason); res.status(204).end(); }
    catch (error) { if (!sendAgentError(res, error)) next(error); }
  });
  router.patch('/api/workspace/v1/agents/:agentId/scope', async (req, res, next) => {
    try { const admin = await requireAdministrator(req, res, true); if (!admin) return; await setWorkspaceAgentScope(engine, admin.workspace_id, req.params.agentId, req.body?.scope, admin.membership_id, res.locals.workspaceRequestId, req.body?.reason); res.status(204).end(); }
    catch (error) { if (!sendAgentError(res, error)) next(error); }
  });
  router.patch('/api/workspace/v1/agents/:agentId/source-access', async (req, res, next) => {
    try { const admin = await requireAdministrator(req, res, true); if (!admin) return; await setWorkspaceAgentSourceAccess(engine, admin.workspace_id, req.params.agentId, req.body?.source_access, admin.membership_id, res.locals.workspaceRequestId, req.body?.reason); res.status(204).end(); }
    catch (error) { if (!sendAgentError(res, error)) next(error); }
  });
  router.patch('/api/workspace/v1/agents/:agentId/status', async (req, res, next) => {
    try { const admin = await requireAdministrator(req, res, true); if (!admin) return; await setWorkspaceAgentStatus(engine, admin.workspace_id, req.params.agentId, req.body?.status, admin.membership_id, res.locals.workspaceRequestId, req.body?.reason); res.status(204).end(); }
    catch (error) { if (!sendAgentError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/agents/:agentId/credentials/rotate', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      const rotated = await rotateWorkspaceAgentCredential(engine, admin.workspace_id, req.params.agentId, admin.membership_id, res.locals.workspaceRequestId, req.body?.reason);
      res.status(201).json({
        data: { credential_id: rotated.credentialId, token: rotated.token },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendAgentError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/agents/:agentId/credentials/:credentialId/revoke', async (req, res, next) => {
    try {
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      await revokeWorkspaceAgentCredential(engine, admin.workspace_id, req.params.agentId, req.params.credentialId, admin.membership_id, res.locals.workspaceRequestId, req.body?.reason);
      res.status(204).end();
    } catch (error) { if (!sendAgentError(res, error)) next(error); }
  });

  // -------------------------------------------------------------------------
  // #68: the three closed gates in front of the colocated OpenClaw runtime.
  //
  // These are gates, not APIs. Caddy asks them; humans never do. They answer
  // with a status and — for `authorize` — exactly one identity header. They
  // never emit a body, never emit HTML, never redirect, and are never cached,
  // because a cached or redirected gate answer is an authorization decision
  // applied to the wrong request.
  //
  // Nothing here reads an inbound header. The pinned OpenClaw Gateway's
  // `gateway.auth.trustedProxy.requiredHeaders` is a PRESENCE check that never
  // compares the value, so a forged `X-GBrain-OpenClaw-User` that survived to
  // the upstream would be a complete authentication bypass. Caddy deletes the
  // client's copy at the edge; this side simply never consults one, so neither
  // layer alone is load-bearing by accident.
  // -------------------------------------------------------------------------

  /** Agent tier is a deployment fact, read the same way the app shell reads it. */
  const agentTier = () => process.env.GBRAIN_AGENT_TIER?.trim().toLowerCase() === 'true';

  /**
   * The one way a gate answers. `end()` with no argument, so no body can be
   * introduced by a later edit, and `no-store` on every path including refusals.
   */
  const gate = (res: express.Response, status: number, identity?: string): void => {
    res.setHeader('Cache-Control', 'no-store');
    if (identity !== undefined) res.setHeader('X-GBrain-OpenClaw-User', identity);
    res.status(status).end();
  };

  /**
   * The runtime this deployment is entitled to talk to, or null. Both conditions
   * are required: the tier flag alone is a claim, and an injected adapter alone
   * would let a Brain-tier misconfiguration open agent ingress.
   */
  const agentRuntime = (): OpenClawControl | null => {
    if (!agentTier()) return null;
    return options.openClawControl ?? null;
  };

  /**
   * GET /api/workspace/v1/agent/runtime-health — the control plane's readiness
   * proof, and the only one of the three that is not fronted by Caddy.
   *
   * 204 means `control.runtimeHealth()` reached the actual loopback Gateway.
   * Everything else is 503. Nothing about the model, configuration, version, or
   * any secret is disclosed: the control plane needs one bit and gets one bit.
   */
  router.get(AGENT_RUNTIME_HEALTH_PATH, async (_req, res) => {
    const control = agentRuntime();
    if (!control) return gate(res, 503);
    let alive = false;
    try {
      // `=== true` rather than truthiness: an adapter that ever returned a
      // response object, a string, or a status number must not read as alive.
      alive = await control.runtimeHealth() === true;
    } catch {
      // An unprovable runtime is not a proven one.
      alive = false;
    }
    return gate(res, alive ? 204 : 503);
  });

  /**
   * GET /api/workspace/v1/agent/authorize — the browser route's `forward_auth`.
   *
   * Authenticated by the ordinary GBrain session cookie, which Caddy forwards
   * unchanged. Before the shared runtime is ready only an Administrator passes,
   * because they are the one doing the setup and there is nothing for anyone
   * else to reach; afterwards every active Member does. Everyone must have
   * confirmed the CURRENT shared-state warning revision first: sharing one
   * agent's files, credentials, browser, memory and GBrain authority may exceed
   * a Member's own permissions, and that acknowledgment is per-revision.
   */
  router.get(AGENT_AUTHORIZE_PATH, async (req, res, next) => {
    try {
      if (!agentRuntime()) return gate(res, 503);
      // Authentication comes from the session and only the session. Any
      // X-GBrain-OpenClaw-User, X-OpenClaw-Scopes, or forwarded header on this
      // request is ignored — it is never read, so it can never be trusted.
      const member = await sessionMember(req);
      if (!member) return gate(res, 401);
      const confirmed = await hasConfirmedAgentWarning(
        engine, member.workspace_id, member.membership_id, AGENT_WARNING_REVISION,
      );
      if (!confirmed) return gate(res, 403);
      const binding = await loadBinding(engine, member.workspace_id);
      const ready = binding ? readinessFromBinding(binding).ready : false;
      if (!ready && member.role !== 'administrator') return gate(res, 403);
      // The identity is the membership the session proved, and it is the only
      // header this endpoint ever sets.
      return gate(res, 204, member.membership_id);
    } catch (error) { next(error); }
  });

  /**
   * GET /api/workspace/v1/agent/native-ready — the native route's `forward_auth`.
   *
   * Cookie-independent by necessity: a native app or CLI cannot present a GBrain
   * browser session, and its own credential is the shared native password, which
   * this endpoint deliberately never receives (Caddy strips `Authorization` from
   * the gate call only). So this gate proves the RUNTIME, not the caller: the
   * password itself is authenticated by the Gateway one hop later.
   *
   * It answers 204 only when all four hold:
   *   1. overall readiness is true;
   *   2. the desired and applied native-password generations match exactly;
   *   3. a live probe proves the current derived password succeeds; and
   *   4. after the first generation, the previous password is rejected.
   *
   * (4) is what closes ingress when a worker that had already lost its lease
   * changed OpenClaw afterwards: the database would claim the new generation is
   * applied while the runtime still accepts the old one. On any failure it
   * clears `ready_at` and lets the runtime drift reconciler requeue the current
   * rotation — an idempotent write, which matters because Caddy calls this on
   * every native request.
   */
  router.get(AGENT_NATIVE_READY_PATH, async (_req, res, next) => {
    try {
      const control = agentRuntime();
      if (!control) return gate(res, 503);
      const secret = options.tokenSecret ?? process.env.GBRAIN_WORKSPACE_TOKEN_SECRET;
      if (!secret) return gate(res, 503);
      // The bound runtime is per-deployment and there is exactly one, read the
      // same way the drift reconciler reads it.
      const workspaceId = await resolveBoundWorkspaceId(engine);
      if (!workspaceId) return gate(res, 503);
      const binding = await loadBinding(engine, workspaceId);
      if (!binding) return gate(res, 503);

      const closeIngress = async () => {
        // Idempotent, and safe to repeat: it only ever clears. The reconciler
        // owns the repair; this endpoint owns only the refusal.
        await clearBindingReadiness(engine, workspaceId);
        return gate(res, 503);
      };

      if (!readinessFromBinding(binding).ready) return closeIngress();
      const generation = Number(binding.native_password_generation);
      // Exact equality, and a real generation. `>=` or a truthiness check here
      // would let a stale applied generation pass as proof.
      //
      // Redundant with `readinessFromBinding` today — its `generationProven`
      // already demands `verified === desired` — and deliberately kept, for the
      // same reason `advanceNativePasswordGenerationInTransaction` keeps its
      // redundant reset: it is the guard that still holds if that comparator is
      // ever loosened, and this endpoint is the last gate before ingress opens.
      if (!Number.isSafeInteger(generation) || generation < 1
        || Number(binding.native_password_applied_generation) !== generation) {
        return closeIngress();
      }

      let current: string;
      let previous: string | null;
      try {
        current = deriveAgentNativePassword(secret, workspaceId, generation);
        previous = generation > 1 ? deriveAgentNativePassword(secret, workspaceId, generation - 1) : null;
      } catch {
        return closeIngress();
      }
      try {
        if (await control.verifyNativePassword(current) !== true) return closeIngress();
        if (previous !== null && await control.verifyNativePasswordRejected(previous) !== true) {
          return closeIngress();
        }
      } catch {
        return closeIngress();
      }
      return gate(res, 204);
    } catch (error) { next(error); }
  });

  // -------------------------------------------------------------------------
  // #68 Task 8 — the Agent customer APIs.
  //
  // These are the surfaces a human uses, as opposed to the three machine gates
  // above. Every one of them is closed by conjunction, never by presence: a
  // status projection that omits a field is not a status projection that proves
  // one, and each guard below is a separate AND, not an early success.
  //
  // Nothing here ever emits a credential ID, a password hash, a generation
  // counter, or an upstream OpenClaw error string. The single secret any of
  // them returns — the shared native password — leaves through exactly one
  // endpoint, in a JSON body, under `no-store`, and never through a URL, a
  // redirect, an audit event, or a rendered page.
  // -------------------------------------------------------------------------

  /**
   * Brain tier does not have these resources, so it must not distinguish
   * between "not entitled" and "not there": both are the ordinary Workspace
   * not-found envelope. This runs BEFORE authentication on every customer
   * route, so a Brain-tier deployment cannot be probed for agent state at all.
   */
  const agentTierAvailable = (res: express.Response): boolean => {
    if (agentTier()) return true;
    sendWorkspaceError(res, new WorkspaceHttpError('not_found', 'agent'));
    return false;
  };

  /**
   * The one place a customer-facing agent URL is built.
   *
   * The origin comes from configuration and nothing else. Deriving it from the
   * request `Host`/`Origin`/`X-Forwarded-Host` would let any caller who can
   * reach the port choose the host a shared password is handed out for, which
   * is a credential-exfiltration primitive, not a convenience. An origin that
   * is absent, unparseable, not HTTPS, or carries userinfo, a path, a query, or
   * a fragment is refused rather than repaired.
   */
  const nativeClientUrl = (): string | null => {
    const configured = options.allowedOrigin ?? process.env.GBRAIN_WORKSPACE_BASE_URL;
    if (!configured || typeof configured !== 'string') return null;
    let parsed: URL;
    try { parsed = new URL(configured); } catch { return null; }
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.search || parsed.hash) return null;
    if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
    return `wss://${parsed.host}${AGENT_CLIENT_BASE_PATH}/`;
  };

  /** Read one provider without ever letting an upstream fault reach the client. */
  const providerView = async (
    control: OpenClawControl | null,
    provider: OpenClawProviderId,
    required: boolean,
  ) => {
    if (!control) return projectAgentProvider(required, null);
    try {
      return projectAgentProvider(required, await control.getProviderStatus(provider));
    } catch {
      // An unprovable provider is not a working one, and the reason is never
      // the customer's business.
      return projectAgentProvider(required, null);
    }
  };

  const providerApiView = (view: ReturnType<typeof projectAgentProvider>, model?: string) => ({
    required: view.required,
    connected: view.connected,
    ...(model ? { model } : {}),
    limits: {
      status: view.limits.status,
      remaining_percent: view.limits.remainingPercent,
      resets_at: view.limits.resetsAt,
    },
  });

  /**
   * How an Administrator connects the Codex subscription without a VM.
   *
   * GBrain never holds a Codex credential: it is established by the customer's
   * own OAuth device flow INSIDE OpenClaw, which is why `openai` is excluded
   * from the adapter's importable-provider union. The only thing this API can
   * usefully do is point at the native command.
   *
   * The command spelling is verified against the pinned openclaw@2026.7.1-2
   * build, not assumed — this string is shipped instruction text, so a wrong
   * one tells an Administrator to type something that does nothing:
   *   dist/commands-registry.data-BKgJ3WoC.js:301-315 — chat command key
   *     `login`, `textAlias: "/login"`, arg `provider` with
   *     `choices: ["codex", "openai"]`.
   *   dist/provider-auth-login-flow-runtime-Bgx33-w5.js:4-11 — the flow's
   *     `CODEX_LOGIN_METHOD` is `"device-code"` and `codex` is an accepted alias
   *     of the canonical `openai` provider id.
   *   docs/tools/slash-commands.md:205,478 — `/login [codex|openai|openai-codex]`
   *     is owner/admin-only and delivers the device pairing code through a
   *     private chat or the Web UI session, never a group.
   * Task 14 executes it for real on a VM; that run, not this comment, is the
   * end-to-end proof.
   */
  const CODEX_SETUP = {
    setup_path: `${AGENT_BASE_PATH}/`,
    instruction: 'Open Agent, start a chat, and send /login codex. Complete the device-code sign-in in your browser, then return here and run Check Codex.',
  } as const;

  /**
   * Only an UNCONNECTED Codex subscription carries setup copy. Once connected,
   * repeating the instruction would invite an Administrator to re-pair a working
   * subscription, and re-pairing is exactly what invalidates their proofs.
   */
  const codexApiView = (view: ReturnType<typeof projectAgentProvider>) => ({
    ...providerApiView(view, CODEX_DEFAULT_MODEL),
    ...(view.connected ? {} : CODEX_SETUP),
  });

  /**
   * Whether the native password can be handed to THIS Member right now. Every
   * clause is required; the endpoint below re-derives the same facts rather
   * than trusting a cached boolean.
   */
  const nativeAvailability = async (
    member: { workspace_id: string; membership_id: string },
    // The caller has usually just read this; passing the proven fact in avoids
    // asking the same question of the database twice in one request.
    warningConfirmed?: boolean,
  ): Promise<
    { available: true; generation: number } | { available: false; refusal: AgentAccessRefusal }
  > => {
    const confirmed = warningConfirmed ?? await hasConfirmedAgentWarning(
      engine, member.workspace_id, member.membership_id, AGENT_WARNING_REVISION,
    );
    if (!confirmed) return { available: false, refusal: 'agent_warning_required' };
    const binding = await loadBinding(engine, member.workspace_id);
    if (!binding) return { available: false, refusal: 'agent_setup_incomplete' };

    // The rotation check comes BEFORE the general readiness check, and that
    // ordering is the whole point.
    //
    // `generationProven` in agent-readiness.ts already demands
    // `applied === desired` exactly, so readiness subsumes this condition
    // completely. Evaluating readiness first would therefore make
    // `agent_native_rotation_pending` unemittable — a mandated status code no
    // client could ever observe, and a guard no test could distinguish from
    // its own absence. Asking the narrower question first gives a pending
    // rotation its own specific, self-resolving 503 while every other blocker
    // still falls through to the 409s below.
    //
    // The desired generation is what must be settled; `applied` is what a
    // password may be derived from, and the two are only interchangeable
    // because this equality holds.
    const desiredGeneration = Number(binding.native_password_generation);
    const appliedGeneration = Number(binding.native_password_applied_generation);
    if (!Number.isSafeInteger(desiredGeneration) || desiredGeneration < 1
      || appliedGeneration !== desiredGeneration) {
      return { available: false, refusal: 'agent_native_rotation_pending' };
    }

    // Everything else the runtime still owes, reported as the FIRST blocker in
    // canonical readiness order that has a code of its own.
    //
    // The order is explicit rather than a property of `.includes()`, because a
    // grant produces two blockers at once: `setBoundAgentGrant` zeroes
    // `mcp_verified_generation` in the same UPDATE that bumps `access_revision`,
    // so the set immediately after any `PUT /grant` is
    // ['grant_unconfirmed', 'mcp_unverified']. Answering `grant_unconfirmed`
    // there is correct — confirming really is the Administrator's next step —
    // but it is a decision, not an accident of iteration order, and the copy it
    // selects must not promise that confirming is the LAST step.
    const readiness = readinessFromBinding(binding);
    if (!readiness.ready) {
      const specific = readiness.blockers.find(blocker => blocker in BLOCKER_REFUSALS);
      return {
        available: false,
        refusal: (specific && BLOCKER_REFUSALS[specific]) ?? 'agent_setup_incomplete',
      };
    }

    if (!(options.tokenSecret ?? process.env.GBRAIN_WORKSPACE_TOKEN_SECRET)) {
      return { available: false, refusal: 'openclaw_runtime_unavailable' };
    }
    if (!nativeClientUrl()) return { available: false, refusal: 'openclaw_runtime_unavailable' };
    // The APPLIED generation is what the runtime actually accepts, so it is
    // what the password is derived from. It equals the desired generation here
    // only because the guard above proved it.
    return { available: true, generation: appliedGeneration };
  };

  /**
   * GET /api/workspace/v1/agent — the safe setup status every active Member
   * sees. It is a projection, never a disclosure: no credential ID, no password
   * or its generation, no deployment-secret fingerprint, no raw upstream error.
   */
  router.get('/api/workspace/v1/agent', async (req, res, next) => {
    try {
      if (!agentTierAvailable(res)) return;
      const member = await requireMember(req, res); if (!member) return;
      const status = await getAgentAccessStatus(engine, member.workspace_id);
      const confirmed = await hasConfirmedAgentWarning(
        engine, member.workspace_id, member.membership_id, AGENT_WARNING_REVISION,
      );
      const control = agentRuntime();
      const [codex, claude, openrouter] = await Promise.all([
        providerView(control, 'openai', true),
        providerView(control, 'anthropic', true),
        providerView(control, 'openrouter', false),
      ]);
      const native = await nativeAvailability(member, confirmed);
      res.json({
        data: {
          warning: {
            revision: AGENT_WARNING_REVISION,
            confirmed,
            shared_categories: [...AGENT_SHARED_CATEGORIES],
          },
          setup: {
            initialized: status.initialized,
            ready: status.readiness.ready,
            blockers: status.readiness.blockers,
          },
          grant: status.initialized && status.scope && status.sourceAccess ? {
            scope: status.scope,
            source_access: {
              mode: status.sourceAccess.mode,
              source_ids: status.sourceAccess.mode === 'specific' ? status.sourceAccess.sourceIds : [],
            },
            confirmed: grantConfirmed(status),
          } : null,
          providers: {
            codex: codexApiView(codex),
            claude: providerApiView(claude, CLAUDE_FALLBACK_MODEL),
            openrouter: providerApiView(openrouter),
          },
          native: { available: native.available },
          channels: { path: `${AGENT_BASE_PATH}/`, external_sender_warning_required: true },
          backup: { openclaw_included: false },
        },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { next(error); }
  });

  /**
   * POST /api/workspace/v1/agent/warning-ack — one Member acknowledges the
   * shared-state warning.
   *
   * It reads NO revision from the caller. A client-supplied revision would let
   * a Member acknowledge a revision that does not exist yet, or re-assert an
   * old one, and every downstream gate compares against the server constant —
   * so the only value that could ever be recorded is the server's own.
   */
  router.post('/api/workspace/v1/agent/warning-ack', async (req, res, next) => {
    try {
      if (!agentTierAvailable(res)) return;
      const member = await requireMember(req, res, true); if (!member) return;
      await confirmAgentWarning(engine, {
        workspaceId: member.workspace_id,
        membershipId: member.membership_id,
        revision: AGENT_WARNING_REVISION,
      });
      res.status(204).end();
    } catch (error) { next(error); }
  });

  /** POST /api/workspace/v1/agent/initialize — create the one durable Agent. */
  router.post('/api/workspace/v1/agent/initialize', async (req, res, next) => {
    try {
      if (!agentTierAvailable(res)) return;
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      // Idempotent by construction: a second call reloads the winning binding.
      const status = await initializeBoundWorkspaceAgent(engine, {
        workspaceId: admin.workspace_id,
        ownerMembershipId: admin.membership_id,
        actorMembershipId: admin.membership_id,
        requestId: res.locals.workspaceRequestId,
      });
      res.status(200).json({
        data: { initialized: true, ready: status.readiness.ready, blockers: status.readiness.blockers },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendAgentAccessError(res, error) && !sendAgentError(res, error)) next(error); }
  });

  /**
   * PUT /api/workspace/v1/agent/grant — the explicit Scope and Source grant.
   *
   * The Agent starts at Read with No Source Access and only an Administrator
   * widens it, with a reason recorded on the immutable Audit Event. Every call
   * re-locks readiness until the new revision is confirmed below.
   */
  router.put('/api/workspace/v1/agent/grant', async (req, res, next) => {
    try {
      if (!agentTierAvailable(res)) return;
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      const requested = req.body?.source_access;
      const mode = requested?.mode;
      const sourceAccess = mode === 'specific'
        ? { mode: 'specific' as const, sourceIds: Array.isArray(requested?.source_ids) ? requested.source_ids : [] }
        : { mode: mode as 'all' | 'none' };
      const status = await setBoundAgentGrant(engine, {
        workspaceId: admin.workspace_id,
        scope: req.body?.scope,
        sourceAccess: sourceAccess as PrincipalSourceAccess,
        actorMembershipId: admin.membership_id,
        requestId: res.locals.workspaceRequestId,
        reason: req.body?.reason,
      });
      res.status(200).json({
        data: {
          grant: {
            scope: status.scope,
            source_access: {
              mode: status.sourceAccess?.mode ?? 'none',
              source_ids: status.sourceAccess?.mode === 'specific' ? status.sourceAccess.sourceIds : [],
            },
            confirmed: grantConfirmed(status),
          },
          setup: { ready: status.readiness.ready, blockers: status.readiness.blockers },
        },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendAgentAccessError(res, error) && !sendAgentError(res, error)) next(error); }
  });

  /** POST /api/workspace/v1/agent/grant/confirm — the Administrator's sign-off. */
  router.post('/api/workspace/v1/agent/grant/confirm', async (req, res, next) => {
    try {
      if (!agentTierAvailable(res)) return;
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      const status = await confirmBoundAgentGrant(engine, {
        workspaceId: admin.workspace_id,
        actorMembershipId: admin.membership_id,
        requestId: res.locals.workspaceRequestId,
        reason: req.body?.reason,
      });
      res.status(200).json({
        data: { confirmed: true, ready: status.readiness.ready, blockers: status.readiness.blockers },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendAgentAccessError(res, error) && !sendAgentError(res, error)) next(error); }
  });

  // -------------------------------------------------------------------------
  // #68 Task 10 — Administrator provider setup and the live readiness proofs.
  //
  // Three shapes are shared by all four routes and each is load-bearing:
  //
  //  1. The runtime is resolved through `agentRuntime()`, so a Brain-tier
  //     deployment or a missing adapter fails closed BEFORE any binding is read.
  //  2. A credential is read out of the body, passed once, and never placed in
  //     the response, the error, or the Audit Event. The 400 refusals below
  //     therefore describe the SHAPE of the request and never quote its value.
  //  3. Nothing here decides readiness. The domain functions record a proof
  //     under a compare-and-set and recompute `ready_at` themselves; this layer
  //     only reports the resulting status.
  // -------------------------------------------------------------------------

  /** The one place a provider credential is read out of a request body. */
  const providerCredential = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  /** POST /api/workspace/v1/agent/providers/anthropic — the required fallback. */
  router.post(`/api/workspace/v1/agent/providers/anthropic`, async (req, res, next) => {
    try {
      if (!agentTierAvailable(res)) return;
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      const control = agentRuntime();
      if (!control) return refuseAgentAccess(res, 'openclaw_runtime_unavailable');
      const setupToken = providerCredential(req.body?.setup_token);
      if (!setupToken) return refuseAgentAccess(res, 'invalid_provider_credential');
      await importAgentAnthropicCredential(engine, control, {
        workspaceId: admin.workspace_id,
        setupToken,
        actorMembershipId: admin.membership_id,
        requestId: res.locals.workspaceRequestId,
      });
      const status = await getAgentAccessStatus(engine, admin.workspace_id);
      // A credential just crossed this handler; nothing about the answer may be
      // cached, revalidated, or carried onward as a referrer.
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.status(200).json({
        data: {
          provider: 'claude',
          connected: true,
          setup: { ready: status.readiness.ready, blockers: status.readiness.blockers },
        },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendAgentAccessError(res, error) && !sendAgentError(res, error)) next(error); }
  });

  /**
   * POST /api/workspace/v1/agent/providers/openrouter — the OPTIONAL provider.
   *
   * It never appears in a readiness blocker, so the response deliberately does
   * not claim readiness moved. Answering with the unchanged setup state is the
   * point: connecting it must not look like progress toward ready.
   */
  router.post(`/api/workspace/v1/agent/providers/openrouter`, async (req, res, next) => {
    try {
      if (!agentTierAvailable(res)) return;
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      const control = agentRuntime();
      if (!control) return refuseAgentAccess(res, 'openclaw_runtime_unavailable');
      const apiKey = providerCredential(req.body?.api_key);
      if (!apiKey) return refuseAgentAccess(res, 'invalid_provider_credential');
      await importAgentOpenRouterCredential(engine, control, {
        workspaceId: admin.workspace_id,
        apiKey,
        actorMembershipId: admin.membership_id,
        requestId: res.locals.workspaceRequestId,
      });
      const status = await getAgentAccessStatus(engine, admin.workspace_id);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.status(200).json({
        data: {
          provider: 'openrouter',
          connected: true,
          required: false,
          setup: { ready: status.readiness.ready, blockers: status.readiness.blockers },
        },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendAgentAccessError(res, error) && !sendAgentError(res, error)) next(error); }
  });

  /**
   * POST /api/workspace/v1/agent/providers/check — prove one required
   * subscription with a live catalog read and a live Responses call.
   *
   * The accepted vocabulary is exactly the two providers readiness depends on.
   * `openrouter` is refused here even though it is a real provider: it earns no
   * proof, so accepting it would imply a check that can never affect readiness.
   */
  router.post(`/api/workspace/v1/agent/providers/check`, async (req, res, next) => {
    try {
      if (!agentTierAvailable(res)) return;
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      const control = agentRuntime();
      if (!control) return refuseAgentAccess(res, 'openclaw_runtime_unavailable');
      const provider = req.body?.provider;
      if (provider !== 'codex' && provider !== 'claude') {
        return refuseAgentAccess(res, 'invalid_provider');
      }
      const checked = await checkAgentRequiredProvider(engine, control, {
        workspaceId: admin.workspace_id,
        provider,
      });
      const status = await getAgentAccessStatus(engine, admin.workspace_id);
      res.status(200).json({
        data: {
          provider,
          verified: true,
          // The EXACT model that was requested and answered, never an echoed one.
          model: checked.model,
          setup: { ready: status.readiness.ready, blockers: status.readiness.blockers },
        },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendAgentAccessError(res, error) && !sendAgentError(res, error)) next(error); }
  });

  /**
   * POST /api/workspace/v1/agent/answer-proof — prove the CONFIGURED default
   * and fallback chain answers, with no backend model override at all.
   *
   * The body is ignored on purpose: the prompt is a server constant carrying no
   * Workspace content, and accepting a caller-supplied prompt would turn a
   * readiness check into an unaudited way to send arbitrary text to a model.
   */
  router.post(`/api/workspace/v1/agent/answer-proof`, async (_req, res, next) => {
    try {
      if (!agentTierAvailable(res)) return;
      const admin = await requireAdministrator(_req, res, true); if (!admin) return;
      const control = agentRuntime();
      if (!control) return refuseAgentAccess(res, 'openclaw_runtime_unavailable');
      const proved = await proveAgentDefaultAnswer(engine, control, {
        workspaceId: admin.workspace_id,
      });
      const status = await getAgentAccessStatus(engine, admin.workspace_id);
      res.status(200).json({
        data: {
          verified: true,
          // The requested TARGET, which is all that was recorded. The response
          // text is never stored and never returned.
          target: proved.target,
          setup: { ready: status.readiness.ready, blockers: status.readiness.blockers },
        },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendAgentAccessError(res, error) && !sendAgentError(res, error)) next(error); }
  });

  /**
   * POST /api/workspace/v1/agent/native/rotate — Administrator-initiated
   * rotation of the shared native password.
   *
   * The response carries the durable Operation, never the new password: the
   * password is only ever derived at disclosure time from the APPLIED
   * generation, so a rotation that has not landed cannot hand anything out.
   */
  router.post('/api/workspace/v1/agent/native/rotate', async (req, res, next) => {
    try {
      if (!agentTierAvailable(res)) return;
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      const idempotencyKey = typeof req.body?.idempotency_key === 'string' && req.body.idempotency_key.trim()
        ? `native_password.rotate:${req.body.idempotency_key.trim()}`
        : `native_password.rotate:request:${res.locals.workspaceRequestId}`;
      const rotation = await requestNativePasswordRotation(engine, {
        workspaceId: admin.workspace_id,
        actorMembershipId: admin.membership_id,
        requestId: res.locals.workspaceRequestId,
        idempotencyKey,
        reason: req.body?.reason,
      });
      // The generation is deliberately absent from the body: it is a password
      // input, and the client has no use for it.
      res.status(202).json({
        data: { operation_id: rotation.operationId, state: 'queued' },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendAgentAccessError(res, error) && !sendAgentError(res, error)) next(error); }
  });

  /**
   * POST /api/workspace/v1/agent/operations/:operationId/retry — repair one
   * failed current-generation runtime Operation.
   *
   * The generation is NEVER accepted from the client; `retryAgentRuntimeOperation`
   * reads the desired generation from the binding and refuses anything else, so
   * an Operation belonging to a superseded generation cannot be revived.
   */
  router.post('/api/workspace/v1/agent/operations/:operationId/retry', async (req, res, next) => {
    try {
      if (!agentTierAvailable(res)) return;
      const admin = await requireAdministrator(req, res, true); if (!admin) return;
      const retried = await retryAgentRuntimeOperation(engine, {
        workspaceId: admin.workspace_id,
        operationId: req.params.operationId,
        actorMembershipId: admin.membership_id,
        requestId: res.locals.workspaceRequestId,
        reason: req.body?.reason,
      });
      res.status(202).json({
        data: { operation_id: retried.operationId, state: 'queued' },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendAgentAccessError(res, error) && !sendAgentError(res, error)) next(error); }
  });

  /**
   * GET /api/workspace/v1/agent/native-access — the ONE disclosure of the
   * shared native password, to an active Member who has acknowledged the
   * current warning and whose runtime is provably ready.
   *
   * The URL is built from configuration alone. The password is derived, never
   * stored, and appears only in this JSON body.
   */
  router.get('/api/workspace/v1/agent/native-access', async (req, res, next) => {
    try {
      if (!agentTierAvailable(res)) return;
      const member = await requireMember(req, res); if (!member) return;
      const availability = await nativeAvailability(member);
      if (!availability.available) return refuseAgentAccess(res, availability.refusal);
      const url = nativeClientUrl();
      const secret = options.tokenSecret ?? process.env.GBRAIN_WORKSPACE_TOKEN_SECRET;
      if (!url || !secret) return refuseAgentAccess(res, 'openclaw_runtime_unavailable');
      let password: string;
      try {
        password = deriveAgentNativePassword(secret, member.workspace_id, availability.generation);
      } catch {
        return refuseAgentAccess(res, 'openclaw_runtime_unavailable');
      }
      // A credential must not be cached, revalidated, or carried onward as a
      // referrer to whatever the Member opens next.
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.status(200).json({
        data: { url, password, shared: true, warning_revision: AGENT_WARNING_REVISION },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { next(error); }
  });

  const attentionViewer = (member: { membership_id: string; role: string }) => ({
    membershipId: member.membership_id,
    role: member.role === 'administrator' ? 'administrator' as const : 'member' as const,
  });

  router.get('/api/workspace/v1/attention', async (req, res, next) => {
    try {
      const member = await requireMember(req, res); if (!member) return;
      // Reconcile every category's detector state before listing so the queue
      // reflects current verified conditions; a reconciliation failure never
      // blocks the read.
      try {
        await runWorkspaceAttentionDetectors(engine, {
          workspaceId: member.workspace_id, requestId: res.locals.workspaceRequestId,
        });
      } catch { /* The listed items remain the last durable detector state. */ }
      const items = await listWorkspaceAttentionItems(engine, {
        workspaceId: member.workspace_id, viewer: attentionViewer(member),
      });
      res.json({ data: { items: items.map(attentionItemApiView) }, request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendAttentionError(res, error)) next(error); }
  });

  router.get('/api/workspace/v1/attention/:itemId', async (req, res, next) => {
    try {
      const member = await requireMember(req, res); if (!member) return;
      const detail = await getWorkspaceAttentionItem(engine, {
        workspaceId: member.workspace_id, itemId: req.params.itemId, viewer: attentionViewer(member),
      });
      res.json({
        data: {
          ...attentionItemApiView(detail),
          history: detail.history.map(entry => ({
            event: entry.event,
            actor_kind: entry.actorKind,
            actor_id: entry.actorId,
            detail: entry.detail,
            occurred_at: entry.occurredAt,
          })),
        },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendAttentionError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/attention/:itemId/assign', async (req, res, next) => {
    try {
      const member = await requireMember(req, res, true); if (!member) return;
      const item = await assignWorkspaceAttentionItem(engine, {
        workspaceId: member.workspace_id, itemId: req.params.itemId,
        assigneeMembershipId: req.body?.assignee_membership_id,
        viewer: attentionViewer(member), requestId: res.locals.workspaceRequestId,
      });
      res.json({ data: attentionItemApiView(item), request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendAttentionError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/attention/:itemId/start', async (req, res, next) => {
    try {
      const member = await requireMember(req, res, true); if (!member) return;
      const item = await startWorkspaceAttentionProgress(engine, {
        workspaceId: member.workspace_id, itemId: req.params.itemId,
        viewer: attentionViewer(member), requestId: res.locals.workspaceRequestId,
      });
      res.json({ data: attentionItemApiView(item), request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendAttentionError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/attention/:itemId/request-resolution', async (req, res, next) => {
    try {
      const member = await requireMember(req, res, true); if (!member) return;
      const outcome = await requestWorkspaceAttentionResolution(engine, {
        workspaceId: member.workspace_id, itemId: req.params.itemId,
        viewer: attentionViewer(member), requestId: res.locals.workspaceRequestId,
      });
      res.json({
        data: { condition_present: outcome.conditionPresent, item: attentionItemApiView(outcome.item) },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) { if (!sendAttentionError(res, error)) next(error); }
  });

  router.post('/api/workspace/v1/attention/:itemId/dismiss', async (req, res, next) => {
    try {
      const member = await requireMember(req, res, true); if (!member) return;
      const item = await dismissWorkspaceAttentionItem(engine, {
        workspaceId: member.workspace_id, itemId: req.params.itemId, reason: req.body?.reason ?? '',
        viewer: attentionViewer(member), requestId: res.locals.workspaceRequestId,
      });
      res.json({ data: attentionItemApiView(item), request_id: res.locals.workspaceRequestId });
    } catch (error) { if (!sendAttentionError(res, error)) next(error); }
  });

  const redirectLegacyAdministration = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const member = await sessionMember(req);
      if (!member) return res.redirect(303, '/login');
      return res.redirect(303, member.role === 'administrator' ? '/app/settings/members' : '/app');
    } catch (error) { next(error); }
  };
  router.get('/admin', redirectLegacyAdministration);
  router.get('/admin/{*path}', redirectLegacyAdministration);

  const sendAppShell = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      let member = await authenticateWorkspaceSession(engine as Parameters<typeof authenticateWorkspaceSession>[0], cookie(req, 'workspace_session'));
      if (!member) return res.redirect(303, '/login');
      const liveCursor = await engine.executeRaw<{ cursor: string }>(
        `SELECT COALESCE(MAX(event_sequence),0)::text AS cursor
           FROM workspace_change_events WHERE workspace_id=$1`,
        [member.workspace_id],
      );
      // Re-read authorization after the cursor snapshot: a Membership change
      // before the snapshot is reflected in the HTML, while a later change
      // has a greater cursor and is delivered by the live channel.
      member = await authenticateWorkspaceSession(engine as Parameters<typeof authenticateWorkspaceSession>[0], cookie(req, 'workspace_session'));
      if (!member) return res.redirect(303, '/login');
      if (['/app/settings/setup', '/app/settings/members', '/app/settings/sources', '/app/settings/operations', '/app/settings/export'].includes(req.path) && member.role !== 'administrator') return res.status(403).type('html').send(messageDocument('Forbidden', 'Administrator access is required.', 'Return to your account settings.', res.locals.workspaceRequestId));
      // #58 (D3/D4): agent-tier VMs carry GBRAIN_AGENT_TIER=true in
      // workspace.env. #68 Task 11 makes it the tier switch for the whole shell:
      // Agent tier serves the singular shared-Agent destination and Brain tier
      // keeps the plural Agents page it has always had.
      const agentTier = process.env.GBRAIN_AGENT_TIER?.trim().toLowerCase() === 'true';
      // The plural page does not exist on Agent tier; a bookmark, a stale link,
      // or a cached navigation lands on the destination that does.
      if (agentTier && req.path === '/app/agents') return res.redirect(303, '/app/agent');
      const policy = await engine.executeRaw<{ access_mode: string }>("SELECT access_mode FROM workspace_principal_source_policies WHERE principal_kind='member' AND principal_id=$1", [member.membership_id]);
      const homeCanvas = workspacePanelForPath(req.path, agentTier) === null;
      let home: AppHomeContext = {};
      if (homeCanvas) {
        const viewer = {
          membershipId: member.membership_id,
          role: member.role as 'administrator' | 'member',
        };
        if (member.role === 'administrator') {
          const checklist = await getWorkspaceSetupChecklist(engine, member.workspace_id);
          home = { checklist };
          if (checklist.complete) {
            try {
              home.view = await getWorkspaceHome(engine, { workspaceId: member.workspace_id, viewer });
            } catch {
              home.failure = { requestId: res.locals.workspaceRequestId, occurredAt: new Date().toISOString() };
            }
          }
        } else {
          const memberHomeState = await getWorkspaceMemberHomeState(engine, member.workspace_id, member.membership_id);
          home = { memberHomeState };
          if (memberHomeState === 'ready') {
            try {
              home.view = await getWorkspaceHome(engine, { workspaceId: member.workspace_id, viewer });
            } catch {
              home.failure = { requestId: res.locals.workspaceRequestId, occurredAt: new Date().toISOString() };
            }
          }
        }
      }
      res.type('html').send(appDocument(
        member.name,
        member.role as 'administrator' | 'member',
        policy[0]?.access_mode ?? 'none',
        req.path,
        home,
        liveCursor[0]?.cursor ?? '0',
        agentTier,
      ));
    } catch (error) { next(error); }
  };
  router.get('/app', sendAppShell);
  router.get('/app/{*path}', sendAppShell);

  router.get('/api/workspace/v1/status', async (_req, res, next) => {
    try {
      const state = await readWorkspaceFoundationState(engine);
      res.json({
        data: {
          lifecycle_state: state.lifecycleState,
          schema_version: state.schemaVersion,
        },
        request_id: res.locals.workspaceRequestId,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/workspace/v1/session', async (req, res, next) => {
    try {
      const member = await authenticateWorkspaceSession(engine as Parameters<typeof authenticateWorkspaceSession>[0], cookie(req, 'workspace_session'));
      if (!member) return res.status(401).json({ error: { code: 'unauthorized', request_id: res.locals.workspaceRequestId } });
      res.json({ data: { workspace_id: member.workspace_id, workspace_name: member.name, role: member.role, surfaces: [] }, request_id: res.locals.workspaceRequestId });
    } catch (error) { next(error); }
  });

  router.post('/api/workspace/v1/session/revoke', async (req, res, next) => {
    try {
      const revoked = await revokeWorkspaceSession(engine, cookie(req, 'workspace_session'), req.header('x-csrf-token'));
      if (!revoked) return res.status(403).json({ error: { code: 'csrf_or_session_invalid', request_id: res.locals.workspaceRequestId } });
      res.clearCookie('workspace_session', { httpOnly: true, sameSite: 'lax', secure: options.production ?? process.env.NODE_ENV === 'production', path: '/' });
      res.status(204).end();
    } catch (error) { next(error); }
  });

  router.use('/api/workspace', (_req, res) => {
    sendWorkspaceError(
      res,
      new WorkspaceHttpError('not_found'),
    );
  });

  router.use(workspaceSafeErrorHandler);
  return router;
}
