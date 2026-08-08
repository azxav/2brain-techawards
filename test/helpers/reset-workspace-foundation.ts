import type { BrainEngine } from '../../src/core/engine.ts';

export async function resetWorkspaceFoundationForTest(
  engine: Pick<BrainEngine, 'executeRaw'>,
): Promise<void> {
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_retention_jobs');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_exports');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_ask_results');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_notifications');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_attention_item_history');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_attention_items');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_condition_episodes');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_page_provenance_inspections');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_agent_runtime_operations');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_agent_warning_confirmations');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_agent_runtime_bindings');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_agent_request_details');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_agent_activity');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_agent_runs');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_agent_credentials');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_agents');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_idempotency_keys');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_source_verification_events');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_source_operation_locks');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_background_operations');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_saved_views');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_sources');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_source_grants');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_principal_source_policies');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_email_outbox');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_sessions');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_invitation_source_grants');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_invitations');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_memberships');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_identities');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_workspaces');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_setup_tokens');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_change_events');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_audit_events');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_runtime_heartbeats');
  await engine.executeRaw('DROP TABLE IF EXISTS workspace_deployments');
  await engine.executeRaw('DROP FUNCTION IF EXISTS workspace_reject_audit_event_mutation()');
}
