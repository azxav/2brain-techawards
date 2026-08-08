import type { BrainEngine } from '../core/engine.ts';

/**
 * The 2Brain control plane starts in its own empty database.  It deliberately
 * does not call BrainEngine.initSchema(): that initializer creates the legacy
 * GBrain projections, including the compatibility `default` source.
 */
export const WORKSPACE_FOUNDATION_SCHEMA_VERSION = 17;

export type WorkspaceRuntimeRole = 'worker' | 'scheduler';

export type WorkspaceFoundationEngine = Pick<
  BrainEngine,
  'kind' | 'executeRaw' | 'transaction'
>;

export interface WorkspaceFoundationState {
  schemaVersion: number;
  lifecycleState: 'uninitialized' | 'active';
}

const FOUNDATION_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS workspace_deployments (
    singleton       BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    schema_version  INTEGER NOT NULL,
    lifecycle_state TEXT NOT NULL DEFAULT 'uninitialized'
      CHECK (lifecycle_state IN ('uninitialized', 'active')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_runtime_heartbeats (
    role              TEXT PRIMARY KEY CHECK (role IN ('worker', 'scheduler')),
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_setup_tokens (
    token_hash TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK (purpose IN ('setup', 'recovery', 'email_confirmation', 'login')),
    email TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_workspaces (
    singleton BOOLEAN NOT NULL DEFAULT TRUE UNIQUE CHECK (singleton),
    workspace_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    setup_completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_identities (
    identity_id TEXT PRIMARY KEY,
    normalized_email TEXT NOT NULL UNIQUE,
    email_confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_memberships (
    membership_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspace_workspaces(workspace_id),
    identity_id TEXT NOT NULL REFERENCES workspace_identities(identity_id),
    role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    UNIQUE (workspace_id, identity_id)
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS workspace_memberships_workspace_membership_idx
    ON workspace_memberships (workspace_id, membership_id)`,

  `CREATE TABLE IF NOT EXISTS workspace_saved_views (
    view_id             TEXT PRIMARY KEY,
    workspace_id        TEXT NOT NULL REFERENCES workspace_workspaces(workspace_id) ON DELETE CASCADE,
    owner_membership_id TEXT NOT NULL,
    target_collection   TEXT NOT NULL DEFAULT 'knowledge' CHECK (target_collection='knowledge'),
    name                TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
    filters             JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters)='object'),
    sort                JSONB NOT NULL CHECK (jsonb_typeof(sort)='object'),
    visible_properties  JSONB NOT NULL CHECK (jsonb_typeof(visible_properties)='array'),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, owner_membership_id)
      REFERENCES workspace_memberships(workspace_id, membership_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS workspace_saved_views_owner_updated_idx
    ON workspace_saved_views (workspace_id, owner_membership_id, updated_at DESC, view_id DESC)`,

  `CREATE TABLE IF NOT EXISTS workspace_invitations (
    invitation_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspace_workspaces(workspace_id),
    normalized_email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
    access_mode TEXT NOT NULL CHECK (access_mode IN ('all', 'specific', 'none')),
    token_hash TEXT NOT NULL UNIQUE,
    invited_by_membership_id TEXT NOT NULL REFERENCES workspace_memberships(membership_id),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_invitation_source_grants (
    invitation_id TEXT NOT NULL REFERENCES workspace_invitations(invitation_id) ON DELETE CASCADE,
    source_id TEXT NOT NULL CHECK (source_id ~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
    PRIMARY KEY (invitation_id, source_id)
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_principal_source_policies (
    principal_kind TEXT NOT NULL CHECK (principal_kind IN ('member', 'agent')),
    principal_id TEXT NOT NULL CHECK (length(principal_id) > 0),
    access_mode TEXT NOT NULL CHECK (access_mode IN ('all', 'specific', 'none')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_kind, principal_id)
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_source_grants (
    principal_kind TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    source_id TEXT NOT NULL
      CHECK (source_id ~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_kind, principal_id, source_id),
    FOREIGN KEY (principal_kind, principal_id)
      REFERENCES workspace_principal_source_policies(principal_kind, principal_id)
      ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_sources (
    source_id                    TEXT PRIMARY KEY
      CHECK (source_id ~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
    workspace_id                 TEXT NOT NULL REFERENCES workspace_workspaces(workspace_id),
    name                         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    remote_url                   TEXT NOT NULL,
    expected_cadence             TEXT NOT NULL
      CHECK (expected_cadence IN ('hourly', 'daily', 'weekly', 'manual')),
    included_in_workspace_search BOOLEAN NOT NULL DEFAULT TRUE,
    provisioning_state           TEXT NOT NULL DEFAULT 'queued'
      CHECK (provisioning_state IN ('queued', 'running', 'completed', 'failed')),
    created_by_membership_id      TEXT NOT NULL REFERENCES workspace_memberships(membership_id),
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, source_id)
  )`,

  `ALTER TABLE workspace_sources DROP CONSTRAINT IF EXISTS workspace_sources_expected_cadence_check`,
  `ALTER TABLE workspace_sources ADD CONSTRAINT workspace_sources_expected_cadence_check
     CHECK (expected_cadence IN ('hourly', 'daily', 'weekly', 'manual'))`,

  `CREATE TABLE IF NOT EXISTS workspace_background_operations (
    operation_id            TEXT PRIMARY KEY,
    workspace_id            TEXT NOT NULL REFERENCES workspace_workspaces(workspace_id),
    operation_type          TEXT NOT NULL CHECK (operation_type IN ('source.provision')),
    initiator_membership_id TEXT NOT NULL REFERENCES workspace_memberships(membership_id),
    resource_type           TEXT NOT NULL,
    resource_id             TEXT NOT NULL,
    state                   TEXT NOT NULL DEFAULT 'queued'
      CHECK (state IN ('queued', 'running', 'completed', 'failed')),
    progress                INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    outcome_summary         TEXT,
    error_code              TEXT,
    error_summary           TEXT,
    retryable               BOOLEAN NOT NULL DEFAULT TRUE,
    cancel_requested        BOOLEAN NOT NULL DEFAULT FALSE,
    cancellation_safe       BOOLEAN NOT NULL DEFAULT TRUE,
    attempt                 INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    max_attempts            INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    idempotency_key         TEXT NOT NULL,
    idempotency_fingerprint TEXT NOT NULL,
    request_id              TEXT NOT NULL,
    lease_owner             TEXT,
    lease_expires_at        TIMESTAMPTZ,
    available_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at              TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, operation_type, idempotency_key),
    FOREIGN KEY (workspace_id, resource_id)
      REFERENCES workspace_sources(workspace_id, source_id)
  )`,

  `ALTER TABLE workspace_background_operations
     DROP CONSTRAINT IF EXISTS workspace_background_operations_operation_type_check`,

  `ALTER TABLE workspace_background_operations
     ADD CONSTRAINT workspace_background_operations_operation_type_check
     CHECK (operation_type IN ('source.provision', 'source.verify', 'source.sync', 'source.permanent_delete'))`,

  `ALTER TABLE workspace_sources ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ`,
  `ALTER TABLE workspace_sources ADD COLUMN IF NOT EXISTS last_verified_revision TEXT`,
  `ALTER TABLE workspace_sources ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ`,
  `ALTER TABLE workspace_sources ADD COLUMN IF NOT EXISTS last_synced_revision TEXT`,
  `ALTER TABLE workspace_sources ADD COLUMN IF NOT EXISTS known_unsynchronized_revision TEXT`,
  `ALTER TABLE workspace_sources ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE workspace_sources ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,
  `ALTER TABLE workspace_sources ADD COLUMN IF NOT EXISTS archived_by_membership_id TEXT
     REFERENCES workspace_memberships(membership_id)`,
  `ALTER TABLE workspace_sources ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE workspace_sources ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
  `ALTER TABLE workspace_sources ADD COLUMN IF NOT EXISTS deleted_by_membership_id TEXT
     REFERENCES workspace_memberships(membership_id)`,
  `ALTER TABLE workspace_background_operations ADD COLUMN IF NOT EXISTS initiator_reason TEXT`,

  `CREATE TABLE IF NOT EXISTS workspace_source_verification_events (
    event_sequence    BIGSERIAL NOT NULL,
    event_id          TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL REFERENCES workspace_workspaces(workspace_id),
    source_id         TEXT NOT NULL,
    operation_id      TEXT NOT NULL UNIQUE REFERENCES workspace_background_operations(operation_id),
    observed_revision TEXT,
    content_state     TEXT CHECK (content_state IN ('unchanged', 'changed')),
    outcome           TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
    error_code        TEXT,
    request_id        TEXT NOT NULL,
    started_at        TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, source_id) REFERENCES workspace_sources(workspace_id, source_id)
  )`,

  `ALTER TABLE workspace_source_verification_events ALTER COLUMN observed_revision DROP NOT NULL`,
  `ALTER TABLE workspace_source_verification_events ALTER COLUMN content_state DROP NOT NULL`,

  // Same reason as workspace_agent_activity: `completed_at` is wall clock, and
  // a backwards step would let a superseded failure outrank the verification
  // that recovered from it.
  `ALTER TABLE workspace_source_verification_events
     ADD COLUMN IF NOT EXISTS event_sequence BIGSERIAL`,

  `CREATE UNIQUE INDEX IF NOT EXISTS workspace_source_verification_events_sequence_idx
    ON workspace_source_verification_events (workspace_id, source_id, event_sequence DESC)`,

  `CREATE TABLE IF NOT EXISTS workspace_source_operation_locks (
    workspace_id TEXT NOT NULL,
    source_id    TEXT NOT NULL,
    owner        TEXT NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (workspace_id, source_id),
    FOREIGN KEY (workspace_id, source_id) REFERENCES workspace_sources(workspace_id, source_id)
  )`,

  `CREATE INDEX IF NOT EXISTS workspace_background_operations_claim_idx
    ON workspace_background_operations (state, available_at, lease_expires_at, created_at)`,

  `CREATE INDEX IF NOT EXISTS workspace_background_operations_retention_idx
    ON workspace_background_operations (completed_at, operation_id)
    WHERE state IN ('completed', 'failed')`,

  `CREATE TABLE IF NOT EXISTS workspace_idempotency_keys (
    workspace_id            TEXT NOT NULL REFERENCES workspace_workspaces(workspace_id),
    scope                   TEXT NOT NULL,
    idempotency_key         TEXT NOT NULL,
    idempotency_fingerprint TEXT NOT NULL,
    resource_id             TEXT NOT NULL,
    operation_id            TEXT NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, scope, idempotency_key)
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_sessions (
    session_hash TEXT PRIMARY KEY,
    membership_id TEXT NOT NULL REFERENCES workspace_memberships(membership_id),
    csrf_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_email_outbox (
    message_id TEXT PRIMARY KEY,
    recipient_email TEXT NOT NULL,
    template TEXT NOT NULL,
    delivery_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending', 'sent', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_audit_events (
    event_id     TEXT PRIMARY KEY,
    actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('member', 'agent', 'operator', 'system')),
    actor_id     TEXT NOT NULL,
    action       TEXT NOT NULL,
    target_type  TEXT NOT NULL,
    target_id    TEXT NOT NULL,
    outcome      TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
    reason       TEXT,
    before_state JSONB NOT NULL,
    after_state  JSONB NOT NULL,
    request_id   TEXT NOT NULL,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `ALTER TABLE workspace_audit_events
     DROP CONSTRAINT IF EXISTS workspace_audit_events_actor_kind_check`,

  `ALTER TABLE workspace_audit_events
     ADD CONSTRAINT workspace_audit_events_actor_kind_check
     CHECK (actor_kind IN ('member', 'agent', 'operator', 'system'))`,

  `CREATE INDEX IF NOT EXISTS workspace_audit_events_occurred_idx
    ON workspace_audit_events (occurred_at DESC, event_id DESC)`,

  `CREATE TABLE IF NOT EXISTS workspace_change_events (
    event_sequence BIGSERIAL NOT NULL,
    event_id      TEXT PRIMARY KEY,
    workspace_id  TEXT,
    actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('member', 'agent', 'operator', 'system')),
    actor_id      TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id   TEXT NOT NULL,
    summary       TEXT NOT NULL,
    request_id    TEXT NOT NULL,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE INDEX IF NOT EXISTS workspace_change_events_occurred_idx
    ON workspace_change_events (occurred_at DESC, event_id DESC)`,

  `ALTER TABLE workspace_change_events
     ADD COLUMN IF NOT EXISTS event_sequence BIGSERIAL`,

  `ALTER TABLE workspace_change_events
     ADD COLUMN IF NOT EXISTS workspace_id TEXT`,

  `CREATE UNIQUE INDEX IF NOT EXISTS workspace_change_events_sequence_idx
     ON workspace_change_events (event_sequence)`,

  `CREATE INDEX IF NOT EXISTS workspace_change_events_workspace_sequence_idx
     ON workspace_change_events (workspace_id, event_sequence)`,

  `ALTER TABLE workspace_change_events
     DROP CONSTRAINT IF EXISTS workspace_change_events_actor_kind_check`,

  `ALTER TABLE workspace_change_events
     ADD CONSTRAINT workspace_change_events_actor_kind_check
     CHECK (actor_kind IN ('member', 'agent', 'operator', 'system'))`,

  `CREATE TABLE IF NOT EXISTS workspace_agents (
    agent_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspace_workspaces(workspace_id),
    name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
    purpose TEXT NOT NULL CHECK (length(btrim(purpose)) BETWEEN 1 AND 240),
    owner_membership_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    scope TEXT NOT NULL DEFAULT 'read' CHECK (scope IN ('read', 'write', 'admin')),
    created_by_membership_id TEXT NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, owner_membership_id)
      REFERENCES workspace_memberships(workspace_id, membership_id),
    FOREIGN KEY (workspace_id, created_by_membership_id)
      REFERENCES workspace_memberships(workspace_id, membership_id)
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_agent_credentials (
    credential_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES workspace_agents(agent_id),
    credential_type TEXT NOT NULL DEFAULT 'api_key' CHECK (credential_type IN ('api_key')),
    token_hash TEXT NOT NULL UNIQUE,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE INDEX IF NOT EXISTS workspace_agent_credentials_agent_idx
    ON workspace_agent_credentials (agent_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS workspace_agent_runs (
    run_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES workspace_agents(agent_id),
    correlation_id TEXT CHECK (correlation_id IS NULL OR length(btrim(correlation_id)) BETWEEN 1 AND 200),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    outcome TEXT CHECK (outcome IN ('succeeded', 'failed', 'cancelled')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE INDEX IF NOT EXISTS workspace_agent_runs_agent_idx
    ON workspace_agent_runs (agent_id, started_at DESC, run_id DESC)`,

  `CREATE INDEX IF NOT EXISTS workspace_agent_runs_retention_idx
    ON workspace_agent_runs (ended_at, run_id) WHERE ended_at IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS workspace_agent_activity (
    activity_sequence BIGSERIAL NOT NULL,
    activity_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES workspace_agents(agent_id),
    run_id TEXT REFERENCES workspace_agent_runs(run_id),
    request_id TEXT,
    operation TEXT NOT NULL CHECK (length(btrim(operation)) BETWEEN 1 AND 120),
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
    source_id TEXT,
    page_slug TEXT,
    relationship TEXT CHECK (relationship IN ('retrieved', 'written', 'cited')),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (page_slug IS NULL OR source_id IS NOT NULL),
    CHECK (relationship IS NULL OR page_slug IS NOT NULL)
  )`,

  `CREATE INDEX IF NOT EXISTS workspace_agent_activity_agent_idx
    ON workspace_agent_activity (agent_id, occurred_at DESC, activity_id DESC)`,

  `CREATE INDEX IF NOT EXISTS workspace_agent_activity_retention_idx
    ON workspace_agent_activity (occurred_at, activity_id)`,

  // `occurred_at` is wall clock, and wall clock steps backwards (NTP
  // correction, VM suspend/resume). Recency questions — "did a success follow
  // the failure streak?" — must be answered from the recorded order instead,
  // so every row carries a monotonic sequence.
  `ALTER TABLE workspace_agent_activity
     ADD COLUMN IF NOT EXISTS activity_sequence BIGSERIAL`,

  `CREATE UNIQUE INDEX IF NOT EXISTS workspace_agent_activity_sequence_idx
    ON workspace_agent_activity (agent_id, activity_sequence DESC)`,

  `CREATE TABLE IF NOT EXISTS workspace_agent_request_details (
    activity_id TEXT PRIMARY KEY REFERENCES workspace_agent_activity(activity_id),
    redacted_detail JSONB NOT NULL,
    full_parameters JSONB,
    full_parameters_expire_at TIMESTAMPTZ,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (full_parameters IS NULL OR full_parameters_expire_at IS NOT NULL)
  )`,

  `CREATE INDEX IF NOT EXISTS workspace_agent_request_details_retention_idx
    ON workspace_agent_request_details (full_parameters_expire_at, activity_id)
    WHERE full_parameters IS NOT NULL`,

  // Agent-tier customer access (ADR-0047). The binding is the singleton link
  // between the Workspace and its one durable bound Agent, and every runtime
  // fact is a desired-generation / verified-generation pair: readiness is false
  // until each verified generation equals its desired generation. Nothing
  // secret is stored — only a non-secret SHA-256 fingerprint of the deployment
  // secret, so a rotation can be recognized without retaining the material.
  `CREATE TABLE IF NOT EXISTS workspace_agent_runtime_bindings (
    workspace_id                       TEXT PRIMARY KEY REFERENCES workspace_workspaces(workspace_id) ON DELETE CASCADE,
    agent_id                           TEXT NOT NULL UNIQUE REFERENCES workspace_agents(agent_id),
    access_revision                    INTEGER NOT NULL DEFAULT 1 CHECK (access_revision > 0),
    access_confirmed_revision          INTEGER NOT NULL DEFAULT 0 CHECK (access_confirmed_revision >= 0),
    mcp_generation                     INTEGER NOT NULL DEFAULT 1 CHECK (mcp_generation > 0),
    mcp_verified_generation            INTEGER NOT NULL DEFAULT 0 CHECK (mcp_verified_generation >= 0),
    mcp_verified_at                    TIMESTAMPTZ,
    model_generation                   INTEGER NOT NULL DEFAULT 1 CHECK (model_generation > 0),
    codex_verified_generation          INTEGER NOT NULL DEFAULT 0 CHECK (codex_verified_generation >= 0),
    codex_verified_model               TEXT,
    codex_verified_at                  TIMESTAMPTZ,
    claude_verified_generation         INTEGER NOT NULL DEFAULT 0 CHECK (claude_verified_generation >= 0),
    claude_verified_model              TEXT,
    claude_verified_at                 TIMESTAMPTZ,
    answer_verified_generation         INTEGER NOT NULL DEFAULT 0 CHECK (answer_verified_generation >= 0),
    answer_verified_target             TEXT,
    answer_verified_at                 TIMESTAMPTZ,
    native_password_generation         INTEGER NOT NULL DEFAULT 1 CHECK (native_password_generation > 0),
    native_password_applied_generation INTEGER NOT NULL DEFAULT 0 CHECK (native_password_applied_generation >= 0),
    native_password_secret_fingerprint TEXT CHECK (
      native_password_secret_fingerprint IS NULL
      OR length(native_password_secret_fingerprint) = 64
    ),
    ready_at                           TIMESTAMPTZ,
    last_error_code                    TEXT,
    created_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                         TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_agent_warning_confirmations (
    workspace_id  TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    revision      TEXT NOT NULL,
    confirmed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, membership_id, revision),
    FOREIGN KEY (workspace_id, membership_id)
      REFERENCES workspace_memberships(workspace_id, membership_id) ON DELETE CASCADE
  )`,

  // The durable, leased, fenced queue for the two crash-recoverable runtime
  // side effects. It deliberately carries no credential, provider, prompt,
  // response, or free-text error column: only a closed safe error code.
  `CREATE TABLE IF NOT EXISTS workspace_agent_runtime_operations (
    operation_id    TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL REFERENCES workspace_workspaces(workspace_id) ON DELETE CASCADE,
    operation_type  TEXT NOT NULL CHECK (operation_type IN ('mcp.configure','native_password.rotate')),
    state           TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed','superseded')),
    generation      INTEGER NOT NULL CHECK (generation > 0),
    credential_id   TEXT REFERENCES workspace_agent_credentials(credential_id),
    idempotency_key TEXT NOT NULL,
    request_id      TEXT NOT NULL,
    attempt         INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    max_attempts    INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
    lease_owner     TEXT,
    lease_token     TEXT,
    lease_expires_at TIMESTAMPTZ,
    idempotency_fingerprint TEXT NOT NULL CHECK (length(idempotency_fingerprint) = 64),
    available_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    safe_error_code TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
      (state = 'running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR
      (state <> 'running' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    ),
    UNIQUE (workspace_id, idempotency_key),
    UNIQUE (workspace_id, operation_type, generation)
  )`,

  `CREATE INDEX IF NOT EXISTS workspace_agent_runtime_operations_claim_idx
    ON workspace_agent_runtime_operations (state, available_at, lease_expires_at, created_at)`,

  `CREATE TABLE IF NOT EXISTS workspace_page_provenance_inspections (
    workspace_id       TEXT NOT NULL REFERENCES workspace_workspaces(workspace_id),
    membership_id      TEXT NOT NULL,
    source_id          TEXT NOT NULL,
    slug               TEXT NOT NULL,
    first_inspected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_inspected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, membership_id, source_id, slug),
    FOREIGN KEY (workspace_id, membership_id)
      REFERENCES workspace_memberships(workspace_id, membership_id)
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_condition_episodes (
    episode_id       TEXT PRIMARY KEY,
    workspace_id     TEXT NOT NULL REFERENCES workspace_workspaces(workspace_id),
    category         TEXT NOT NULL
      CHECK (category IN ('source_health', 'knowledge_quality', 'agent_access', 'automation_health')),
    condition_type   TEXT NOT NULL CHECK (length(btrim(condition_type)) BETWEEN 1 AND 80),
    resource_type    TEXT NOT NULL CHECK (length(btrim(resource_type)) BETWEEN 1 AND 40),
    resource_id      TEXT NOT NULL CHECK (length(btrim(resource_id)) BETWEEN 1 AND 200),
    state            TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'cleared')),
    detected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    cleared_at       TIMESTAMPTZ,
    CHECK (state = 'active' OR cleared_at IS NOT NULL)
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS workspace_condition_episodes_active_idx
    ON workspace_condition_episodes (workspace_id, condition_type, resource_type, resource_id)
    WHERE state = 'active'`,

  `CREATE TABLE IF NOT EXISTS workspace_attention_items (
    item_id                TEXT PRIMARY KEY,
    workspace_id           TEXT NOT NULL REFERENCES workspace_workspaces(workspace_id),
    episode_id             TEXT NOT NULL UNIQUE REFERENCES workspace_condition_episodes(episode_id),
    category               TEXT NOT NULL
      CHECK (category IN ('source_health', 'knowledge_quality', 'agent_access', 'automation_health')),
    condition_type         TEXT NOT NULL CHECK (length(btrim(condition_type)) BETWEEN 1 AND 80),
    resource_type          TEXT NOT NULL CHECK (length(btrim(resource_type)) BETWEEN 1 AND 40),
    resource_id            TEXT NOT NULL CHECK (length(btrim(resource_id)) BETWEEN 1 AND 200),
    summary                TEXT NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 240),
    evidence               JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
    status                 TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open', 'in_progress', 'resolved', 'dismissed')),
    assignee_membership_id TEXT,
    dismiss_reason         TEXT,
    detected_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_verified_at       TIMESTAMPTZ,
    resolved_at            TIMESTAMPTZ,
    dismissed_at           TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (status <> 'dismissed' OR dismiss_reason IS NOT NULL),
    CHECK (status <> 'resolved' OR resolved_at IS NOT NULL),
    FOREIGN KEY (workspace_id, assignee_membership_id)
      REFERENCES workspace_memberships(workspace_id, membership_id)
  )`,

  `CREATE INDEX IF NOT EXISTS workspace_attention_items_queue_idx
    ON workspace_attention_items (workspace_id, status, detected_at DESC, item_id DESC)`,

  `CREATE TABLE IF NOT EXISTS workspace_attention_item_history (
    history_id  TEXT PRIMARY KEY,
    item_id     TEXT NOT NULL REFERENCES workspace_attention_items(item_id),
    event       TEXT NOT NULL CHECK (event IN (
      'detected', 'assigned', 'status_changed', 'resolution_requested',
      'verification_condition_present', 'resolved', 'dismissed', 'episode_cleared'
    )),
    actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('member', 'system')),
    actor_id    TEXT NOT NULL CHECK (length(btrim(actor_id)) > 0),
    detail      JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail)='object'),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE INDEX IF NOT EXISTS workspace_attention_item_history_item_idx
    ON workspace_attention_item_history (item_id, occurred_at, history_id)`,

  `CREATE TABLE IF NOT EXISTS workspace_notifications (
    notification_sequence    BIGSERIAL NOT NULL,
    notification_id          TEXT PRIMARY KEY,
    workspace_id             TEXT NOT NULL REFERENCES workspace_workspaces(workspace_id),
    recipient_membership_id  TEXT NOT NULL,
    event_key                TEXT NOT NULL CHECK (length(btrim(event_key)) BETWEEN 1 AND 200),
    event_type               TEXT NOT NULL CHECK (event_type IN (
      'attention_assigned', 'attention_condition_changed', 'attention_verification_outcome',
      'background_operation_outcome', 'membership_access_changed'
    )),
    target_type              TEXT NOT NULL CHECK (target_type IN ('attention_item', 'background_operation', 'membership')),
    target_id                TEXT NOT NULL CHECK (length(btrim(target_id)) BETWEEN 1 AND 200),
    source_id                TEXT,
    summary                  TEXT NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 160),
    read_at                  TIMESTAMPTZ,
    archived_at              TIMESTAMPTZ,
    expires_at               TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, recipient_membership_id, event_key),
    UNIQUE (notification_sequence),
    FOREIGN KEY (workspace_id, recipient_membership_id)
      REFERENCES workspace_memberships(workspace_id, membership_id)
  )`,

  `CREATE INDEX IF NOT EXISTS workspace_notifications_recipient_idx
    ON workspace_notifications (workspace_id, recipient_membership_id, notification_sequence DESC)
    WHERE archived_at IS NULL`,

  `CREATE INDEX IF NOT EXISTS workspace_notifications_expiry_idx
    ON workspace_notifications (expires_at, notification_sequence)`,

  `CREATE TABLE IF NOT EXISTS workspace_ask_results (
    ask_result_id           TEXT PRIMARY KEY,
    workspace_id            TEXT NOT NULL REFERENCES workspace_workspaces(workspace_id) ON DELETE CASCADE,
    requester_membership_id TEXT NOT NULL,
    question                TEXT NOT NULL CHECK (length(btrim(question)) BETWEEN 1 AND 200),
    selected_source_ids     JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(selected_source_ids)='array'),
    state                   TEXT NOT NULL DEFAULT 'queued' CHECK (state IN (
      'queued','running','answered','not_enough_evidence','cancelled','failed'
    )),
    progress                TEXT NOT NULL DEFAULT 'Question acknowledged',
    searched_sources        JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(searched_sources)='array'),
    authorization_sources   JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(authorization_sources)='array'),
    trust_state             JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(trust_state)='array'),
    citations               JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(citations)='array'),
    answer                   TEXT,
    evidence_gap             TEXT,
    next_action              TEXT,
    cancellation_requested_at TIMESTAMPTZ,
    error_code               TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at               TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
    FOREIGN KEY (workspace_id, requester_membership_id)
      REFERENCES workspace_memberships(workspace_id, membership_id) ON DELETE CASCADE,
    CHECK (state <> 'answered' OR (answer IS NOT NULL AND jsonb_array_length(citations) > 0)),
    CHECK (state <> 'not_enough_evidence' OR (answer IS NULL AND evidence_gap IS NOT NULL AND next_action IS NOT NULL)),
    CHECK (state NOT IN ('cancelled','failed') OR answer IS NULL)
  )`,

  `CREATE INDEX IF NOT EXISTS workspace_ask_results_requester_idx
    ON workspace_ask_results (workspace_id, requester_membership_id, created_at DESC)`,

  `CREATE INDEX IF NOT EXISTS workspace_ask_results_expiry_idx
    ON workspace_ask_results (expires_at, ask_result_id)`,

  // A Workspace Export is a durable Background Operation with its own lifecycle
  // row. It deliberately does NOT ride workspace_background_operations: that
  // table's composite FK requires resource_id to name a real Source, while an
  // export snapshots the whole Workspace. The lease/attempt columns mirror the
  // Source operation so the same Queued->Running->Completed/Failed state machine,
  // cancellation, retry, and expired-lease restart recovery apply. The archive
  // itself is stored checksum-addressed with a bounded expiry.
  `CREATE TABLE IF NOT EXISTS workspace_exports (
    export_id                  TEXT PRIMARY KEY,
    workspace_id               TEXT NOT NULL REFERENCES workspace_workspaces(workspace_id),
    requested_by_membership_id TEXT NOT NULL,
    state                      TEXT NOT NULL DEFAULT 'queued'
      CHECK (state IN ('queued', 'running', 'completed', 'failed')),
    progress                   INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    outcome_summary            TEXT,
    error_code                 TEXT,
    error_summary              TEXT,
    retryable                  BOOLEAN NOT NULL DEFAULT TRUE,
    cancel_requested           BOOLEAN NOT NULL DEFAULT FALSE,
    cancellation_safe          BOOLEAN NOT NULL DEFAULT TRUE,
    attempt                    INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    max_attempts               INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    idempotency_key            TEXT NOT NULL,
    idempotency_fingerprint    TEXT NOT NULL,
    request_id                 TEXT NOT NULL,
    lease_owner                TEXT,
    lease_expires_at           TIMESTAMPTZ,
    available_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    snapshot_at                TIMESTAMPTZ,
    manifest                   JSONB,
    record_counts              JSONB,
    artifact_content           TEXT,
    artifact_checksum          TEXT,
    artifact_byte_size         INTEGER CHECK (artifact_byte_size IS NULL OR artifact_byte_size >= 0),
    expires_at                 TIMESTAMPTZ,
    started_at                 TIMESTAMPTZ,
    completed_at               TIMESTAMPTZ,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, idempotency_key),
    FOREIGN KEY (workspace_id, requested_by_membership_id)
      REFERENCES workspace_memberships(workspace_id, membership_id)
  )`,

  `CREATE INDEX IF NOT EXISTS workspace_exports_claim_idx
    ON workspace_exports (state, available_at, lease_expires_at, created_at)`,

  `CREATE INDEX IF NOT EXISTS workspace_exports_workspace_idx
    ON workspace_exports (workspace_id, created_at DESC, export_id DESC)`,

  `CREATE INDEX IF NOT EXISTS workspace_exports_expiry_idx
    ON workspace_exports (expires_at, export_id)`,

  `CREATE INDEX IF NOT EXISTS workspace_exports_retention_idx
    ON workspace_exports (completed_at, export_id)
    WHERE state IN ('completed', 'failed')`,

  // Retention is a whole-Workspace durable job, so it cannot use
  // workspace_background_operations: that table requires a Source resource.
  // The cutoff is captured on first claim and reused after worker restart so
  // every purge decision and Audit Event describes one deterministic instant.
  `CREATE TABLE IF NOT EXISTS workspace_retention_jobs (
    retention_id           TEXT PRIMARY KEY,
    workspace_id           TEXT NOT NULL REFERENCES workspace_workspaces(workspace_id),
    state                  TEXT NOT NULL DEFAULT 'queued'
      CHECK (state IN ('queued', 'running', 'completed', 'failed')),
    progress               INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    purged_counts          JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(purged_counts)='object'),
    error_code             TEXT,
    error_summary          TEXT,
    retryable              BOOLEAN NOT NULL DEFAULT TRUE,
    attempt                INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    max_attempts           INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    idempotency_key        TEXT NOT NULL,
    request_id             TEXT NOT NULL,
    lease_owner            TEXT,
    lease_expires_at       TIMESTAMPTZ,
    available_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    cutoff_at              TIMESTAMPTZ,
    started_at             TIMESTAMPTZ,
    completed_at           TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, idempotency_key)
  )`,

  `CREATE INDEX IF NOT EXISTS workspace_retention_jobs_claim_idx
    ON workspace_retention_jobs (state, available_at, lease_expires_at, created_at)`,

  `CREATE INDEX IF NOT EXISTS workspace_retention_jobs_workspace_idx
    ON workspace_retention_jobs (workspace_id, created_at DESC, retention_id DESC)`,

  `CREATE INDEX IF NOT EXISTS workspace_retention_jobs_completed_idx
    ON workspace_retention_jobs (completed_at, retention_id)
    WHERE state IN ('completed', 'failed')`,

  `CREATE OR REPLACE FUNCTION workspace_reject_audit_event_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'workspace Audit Events are immutable';
    END;
    $$`,

  `DROP TRIGGER IF EXISTS workspace_audit_events_immutable
    ON workspace_audit_events`,

  `CREATE TRIGGER workspace_audit_events_immutable
    BEFORE UPDATE OR DELETE ON workspace_audit_events
    FOR EACH ROW EXECUTE FUNCTION workspace_reject_audit_event_mutation()`,
] as const;

/**
 * Create the minimal, data-free Workspace foundation.  This is intentionally
 * retry-safe: a partially completed startup can be rerun without importing or
 * transforming data from a legacy GBrain installation.
 */
export async function initializeWorkspaceFoundation(
  engine: WorkspaceFoundationEngine,
): Promise<WorkspaceFoundationState> {
  return engine.transaction(async transaction => {
    // PostgreSQL's `CREATE TABLE IF NOT EXISTS` alone does not serialize two
    // first-start processes. An xact-scoped lock keeps worker and scheduler
    // startup atomic while PGLite retains its native one-process transaction.
    if (engine.kind === 'postgres') {
      await transaction.executeRaw('SELECT pg_advisory_xact_lock(4202401)');
    }
    const deploymentTables = await transaction.executeRaw<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name='workspace_deployments'`,
    );
    let initialized = false;
    if (deploymentTables.length > 0) {
      const deployments = await transaction.executeRaw<{ singleton: boolean }>(
        'SELECT singleton FROM workspace_deployments WHERE singleton=TRUE',
      );
      initialized = deployments.length > 0;
    }
    if (!initialized) await assertCleanStartDatabase(transaction);
    // Keep the DDL in one shared statement set. Both Postgres and PGLite accept
    // this syntax, which is the foundation's schema-parity contract. Execute
    // statements separately because PGLite's raw adapter is single-statement.
    for (const statement of FOUNDATION_TABLES_SQL) {
      await transaction.executeRaw(statement);
    }
    await transaction.executeRaw(
      `INSERT INTO workspace_deployments (singleton, schema_version)
       VALUES (TRUE, $1)
       ON CONFLICT (singleton) DO UPDATE
         SET schema_version = EXCLUDED.schema_version
         WHERE workspace_deployments.schema_version < EXCLUDED.schema_version`,
      [WORKSPACE_FOUNDATION_SCHEMA_VERSION],
    );

    return readWorkspaceFoundationState(transaction);
  });
}

/**
 * Refuse a database that contains legacy or otherwise non-Workspace data
 * before writing anything. Future Workspace tables use the `workspace_`
 * namespace, so a later control-plane migration remains compatible with this
 * first initializer without creating a hole for an omitted legacy table.
 */
async function assertCleanStartDatabase(engine: WorkspaceFoundationEngine): Promise<void> {
  const rows = await engine.executeRaw<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name NOT LIKE 'workspace\\_%' ESCAPE '\\'
      ORDER BY table_name`,
  );
  if (rows.length > 0) {
    throw new Error(
      `2Brain clean start requires a new empty database. Existing public tables found: ${rows.map(row => row.table_name).join(', ')}.`,
    );
  }
}

export async function readWorkspaceFoundationState(
  engine: Pick<BrainEngine, 'executeRaw'>,
): Promise<WorkspaceFoundationState> {
  const rows = await engine.executeRaw<{
    schema_version: number;
    lifecycle_state: WorkspaceFoundationState['lifecycleState'];
  }>(
    `SELECT schema_version, lifecycle_state
       FROM workspace_deployments
      WHERE singleton = TRUE`,
  );
  const state = rows[0];
  if (!state) {
    throw new Error('2Brain Workspace foundation is not initialized. Run the foundation initializer first.');
  }
  return {
    schemaVersion: Number(state.schema_version),
    lifecycleState: state.lifecycle_state,
  };
}

/**
 * Record that an independently deployed process can reach the Workspace
 * database. Slice #2 deliberately records only liveness; job ownership and
 * scheduled product work arrive with their corresponding Workspace features.
 */
export async function recordWorkspaceRuntimeHeartbeat(
  engine: WorkspaceFoundationEngine,
  role: WorkspaceRuntimeRole,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO workspace_runtime_heartbeats (role)
     VALUES ($1)
     ON CONFLICT (role) DO UPDATE
       SET last_heartbeat_at = now()`,
    [role],
  );
}

export interface WorkspaceDeploymentTopology {
  sharedProduction: boolean;
  independentRoles: readonly WorkspaceRuntimeRole[];
}

/**
 * Shared deployments are Postgres-only. PGLite remains a supported one-process
 * development/test engine, but its exclusive file lock is not a safe topology
 * for independently deployed worker and scheduler processes.
 */
export function workspaceDeploymentTopology(
  engine: BrainEngine['kind'],
): WorkspaceDeploymentTopology {
  if (engine === 'postgres') {
    return { sharedProduction: true, independentRoles: ['worker', 'scheduler'] };
  }
  return { sharedProduction: false, independentRoles: [] };
}
