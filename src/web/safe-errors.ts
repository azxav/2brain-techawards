import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  ConnectedAppAccessDeniedError,
  ConnectedAppNotFoundError,
  InvalidConnectedAppAccessLevelError,
} from '../workspace/connected-apps.ts';

export const WORKSPACE_REQUEST_ID_HEADER = 'x-request-id';

export interface SafeWorkspaceErrorBody {
  error: {
    code: string;
    message: string;
    recovery: string;
    retryable: boolean;
    request_id: string;
    occurred_at: string;
    resource: string;
  };
}

export class WorkspaceHttpError extends Error {
  constructor(readonly code: WorkspaceErrorCode, readonly resource: WorkspaceErrorResource = 'workspace') {
    super(WORKSPACE_ERROR_CATALOG[code].message);
    this.name = 'WorkspaceHttpError';
  }
}

const WORKSPACE_ERROR_CATALOG = {
  internal_error: {
    status: 500,
    message: '2Brain could not complete that request.',
    recovery: 'Retry the request. If it still fails, give an Administrator the request ID.',
    retryable: true,
  },
  not_found: {
    status: 404,
    message: 'That Workspace resource does not exist.',
    recovery: 'Check the link and try again.',
    retryable: false,
  },
  invalid_token: {
    status: 400,
    message: 'That link or token is invalid or has expired.',
    recovery: 'Request a fresh link and try again.',
    retryable: false,
  },
  invalid_request: {
    status: 400,
    message: 'The request was missing a required field or contained an invalid value.',
    recovery: 'Correct the request body and try again.',
    retryable: false,
  },
  reason_required: {
    status: 400,
    message: 'A reason is required for this protected Workspace mutation.',
    recovery: 'Provide the reason recorded with the immutable Audit Event.',
    retryable: false,
  },
  conflict: {
    status: 409,
    message: 'That change conflicts with the current state of the Workspace.',
    recovery: 'Refresh the Workspace view and try again.',
    retryable: false,
  },
  rate_limited: {
    status: 429,
    message: 'Too many Workspace authentication requests were made.',
    recovery: 'Wait before trying again.',
    retryable: true,
  },
} as const;

export type WorkspaceErrorCode = keyof typeof WORKSPACE_ERROR_CATALOG;
export type WorkspaceErrorResource = 'workspace' | 'login' | 'source' | 'membership' | 'agent' | 'attention' | 'operation' | 'connected_app';

export function isWorkspacePath(path: string): boolean {
  return ['/login', '/setup', '/confirm', '/recover', '/invitations', '/app', '/api/workspace'].some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

export function workspaceRequestContext(requestId: () => string = randomUUID) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isWorkspacePath(req.path)) return next();
    const id = requestId();
    res.locals.workspaceRequestId = id;
    res.setHeader(WORKSPACE_REQUEST_ID_HEADER, id);
    next();
  };
}

function requestIdFor(res: Response): string {
  const value = res.locals.workspaceRequestId;
  return typeof value === 'string' && value ? value : randomUUID();
}

export function sendWorkspaceError(
  res: Response,
  error: WorkspaceHttpError,
): void {
  const requestId = requestIdFor(res);
  res.setHeader(WORKSPACE_REQUEST_ID_HEADER, requestId);
  const code = Object.hasOwn(WORKSPACE_ERROR_CATALOG, error.code)
    ? error.code as WorkspaceErrorCode
    : 'internal_error';
  const catalogEntry = WORKSPACE_ERROR_CATALOG[code];
  const resource: WorkspaceErrorResource = [
    'workspace', 'login', 'source', 'membership', 'agent', 'attention', 'operation', 'connected_app',
  ].includes(error.resource) ? error.resource as WorkspaceErrorResource : 'workspace';
  const body: SafeWorkspaceErrorBody = {
    error: {
      code,
      message: catalogEntry.message,
      recovery: catalogEntry.recovery,
      retryable: catalogEntry.retryable,
      request_id: requestId,
      occurred_at: new Date().toISOString(),
      resource,
    },
  };
  res.status(catalogEntry.status).json(body);
}

/**
 * #51: the workspace auth/membership modules signal refusals as plain
 * `Error(code)` where the message IS the stable internal code. Map exactly
 * those to typed 4xx envelopes; everything else stays internal_error so an
 * arbitrary internal fault can never be reclassified as a client mistake.
 */
const WORKSPACE_REFUSAL_BY_MESSAGE: Record<string, { code: WorkspaceErrorCode; resource: WorkspaceErrorResource }> = {
  invalid_or_expired_token: { code: 'invalid_token', resource: 'workspace' },
  invalid_or_expired_invitation: { code: 'invalid_token', resource: 'membership' },
  invitation_email_mismatch: { code: 'invalid_request', resource: 'membership' },
  invalid_setup_input: { code: 'invalid_request', resource: 'workspace' },
  invalid_invitation_email: { code: 'invalid_request', resource: 'membership' },
  invalid_source_access_grant: { code: 'invalid_request', resource: 'membership' },
  specific_source_access_required: { code: 'invalid_request', resource: 'membership' },
  invalid_membership_role: { code: 'invalid_request', resource: 'membership' },
  invalid_membership_status: { code: 'invalid_request', resource: 'membership' },
  membership_not_found: { code: 'not_found', resource: 'membership' },
  pending_confirmation_not_found: { code: 'not_found', resource: 'workspace' },
  membership_already_exists: { code: 'conflict', resource: 'membership' },
  confirmation_already_completed: { code: 'conflict', resource: 'workspace' },
  workspace_setup_already_completed: { code: 'conflict', resource: 'workspace' },
};

export function workspaceRefusalFromError(error: unknown): WorkspaceHttpError | null {
  if (error instanceof WorkspaceHttpError) return error;
  if (error instanceof ConnectedAppNotFoundError) return new WorkspaceHttpError('not_found', 'connected_app');
  if (error instanceof InvalidConnectedAppAccessLevelError || error instanceof ConnectedAppAccessDeniedError) {
    return new WorkspaceHttpError('invalid_request', 'connected_app');
  }
  if (!(error instanceof Error)) return null;
  // Shared protected-mutation guard (events.ts) — the same substring
  // contract the agent-route mapper already relies on.
  if (error.message.includes('reason is required')) return new WorkspaceHttpError('reason_required');
  const mapped = WORKSPACE_REFUSAL_BY_MESSAGE[error.message];
  return mapped ? new WorkspaceHttpError(mapped.code, mapped.resource) : null;
}

export function workspaceSafeErrorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isWorkspacePath(req.path)) return next(error);
  const refusal = workspaceRefusalFromError(error);
  sendWorkspaceError(res, refusal ?? new WorkspaceHttpError('internal_error'));
}
