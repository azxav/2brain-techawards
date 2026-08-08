import { expect, test } from 'bun:test';
import {
  WORKSPACE_ATTENTION_CONDITION_POLICY,
  workspaceAttentionActionAllowed,
  workspaceAttentionCategoryFor,
  workspaceAttentionMemberVisibility,
  type WorkspaceAttentionCategory,
  type WorkspaceAttentionConditionType,
} from '../src/workspace/attention.ts';

// Pure policy tests: category mapping and lifecycle behavior hold without a
// database, so a detector can never invent a category or transition.

test('every condition type maps to its designed category', () => {
  const expected: Record<WorkspaceAttentionConditionType, WorkspaceAttentionCategory> = {
    'source.verification_failure': 'source_health',
    'source.synchronization_failure': 'source_health',
    'knowledge.missing_evidence': 'knowledge_quality',
    'agent.repeated_authorization_failure': 'agent_access',
    'agent.admin_scope_review': 'agent_access',
    'automation.runtime_stalled': 'automation_health',
    'automation.operation_failure': 'automation_health',
  };
  for (const [conditionType, category] of Object.entries(expected)) {
    expect(workspaceAttentionCategoryFor(conditionType as WorkspaceAttentionConditionType)).toBe(category);
  }
  // The policy map is closed: no extra condition types exist.
  expect(Object.keys(WORKSPACE_ATTENTION_CONDITION_POLICY).sort()).toEqual(Object.keys(expected).sort());
});

test('Source-specific verification and synchronization failures never map to Automation health', () => {
  expect(workspaceAttentionCategoryFor('source.verification_failure')).not.toBe('automation_health');
  expect(workspaceAttentionCategoryFor('source.synchronization_failure')).not.toBe('automation_health');
});

test('each condition type declares the resource type its episode dedupes on', () => {
  expect(WORKSPACE_ATTENTION_CONDITION_POLICY['source.verification_failure'].resourceType).toBe('source');
  expect(WORKSPACE_ATTENTION_CONDITION_POLICY['knowledge.missing_evidence'].resourceType).toBe('page');
  expect(WORKSPACE_ATTENTION_CONDITION_POLICY['agent.repeated_authorization_failure'].resourceType).toBe('agent');
  expect(WORKSPACE_ATTENTION_CONDITION_POLICY['agent.admin_scope_review'].resourceType).toBe('agent');
  expect(WORKSPACE_ATTENTION_CONDITION_POLICY['automation.runtime_stalled'].resourceType).toBe('runtime');
  expect(WORKSPACE_ATTENTION_CONDITION_POLICY['automation.operation_failure'].resourceType).toBe('orchestration');
});

test('Member visibility follows the resource type, failing closed for non-Source resources', () => {
  expect(workspaceAttentionMemberVisibility('source')).toBe('by_source');
  expect(workspaceAttentionMemberVisibility('page')).toBe('by_page_source');
  expect(workspaceAttentionMemberVisibility('agent')).toBe('administrator_only');
  expect(workspaceAttentionMemberVisibility('runtime')).toBe('administrator_only');
  expect(workspaceAttentionMemberVisibility('orchestration')).toBe('administrator_only');
  // Unknown resource types stay invisible to Members rather than leaking.
  expect(workspaceAttentionMemberVisibility('anything-else')).toBe('administrator_only');
});

test('lifecycle actions are permitted only from active statuses', () => {
  expect(workspaceAttentionActionAllowed('open', 'assign')).toBe(true);
  expect(workspaceAttentionActionAllowed('open', 'start_progress')).toBe(true);
  expect(workspaceAttentionActionAllowed('open', 'request_resolution')).toBe(true);
  expect(workspaceAttentionActionAllowed('open', 'dismiss')).toBe(true);
  expect(workspaceAttentionActionAllowed('in_progress', 'assign')).toBe(true);
  expect(workspaceAttentionActionAllowed('in_progress', 'start_progress')).toBe(false);
  expect(workspaceAttentionActionAllowed('in_progress', 'request_resolution')).toBe(true);
  expect(workspaceAttentionActionAllowed('in_progress', 'dismiss')).toBe(true);
  for (const action of ['assign', 'start_progress', 'request_resolution', 'dismiss'] as const) {
    expect(workspaceAttentionActionAllowed('resolved', action)).toBe(false);
    expect(workspaceAttentionActionAllowed('dismissed', action)).toBe(false);
  }
});
