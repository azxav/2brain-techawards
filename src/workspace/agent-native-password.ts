/**
 * The shared native password for the bound OpenClaw runtime. Nothing here is
 * ever persisted in plaintext: the deployment secret, the Workspace, and the
 * generation reproduce the password on demand, and only a non-secret verifier of
 * the deployment secret is stored.
 */
import { createHmac } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { AgentAccessError } from './agent-access-error.ts';
import { requireBinding } from './agent-binding.ts';

/**
 * Derive the shared native password. It is never persisted: the deployment
 * secret, the Workspace, and the generation reproduce it on demand.
 */
export function deriveAgentNativePassword(
  tokenSecret: string,
  workspaceId: string,
  generation: number,
): string {
  if (!tokenSecret) throw new AgentAccessError('agent_password_secret_required');
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new AgentAccessError('invalid_agent_password_generation');
  }
  return createHmac('sha256', tokenSecret)
    .update(`gbrain:openclaw-native:v1:${workspaceId}:${generation}`, 'utf8')
    .digest('base64url');
}

/** A non-secret verifier for the immutable deployment secret. */
function agentPasswordSecretFingerprint(tokenSecret: string): string {
  return createHmac('sha256', tokenSecret)
    .update('gbrain:openclaw-native-secret:v1', 'utf8')
    .digest('hex');
}

/**
 * Compare-and-set the deployment-secret fingerprint before any password is
 * derived or applied. The first native operation pins it; a later mismatch
 * means the deployment secret changed and every derived password would silently
 * differ, so native access fails closed instead.
 */
export async function pinAgentPasswordSecretFingerprint(
  tx: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
  tokenSecret: string,
): Promise<void> {
  if (!tokenSecret) throw new AgentAccessError('agent_password_secret_required');
  const fingerprint = agentPasswordSecretFingerprint(tokenSecret);
  const updated = await tx.executeRaw(
    `UPDATE workspace_agent_runtime_bindings
        SET native_password_secret_fingerprint=$2, updated_at=now()
      WHERE workspace_id=$1
        AND (native_password_secret_fingerprint IS NULL OR native_password_secret_fingerprint=$2)
      RETURNING workspace_id`,
    [workspaceId, fingerprint],
  );
  if (updated[0]) return;
  await requireBinding(tx, workspaceId);
  throw new AgentAccessError('agent_password_secret_changed');
}
