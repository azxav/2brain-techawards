import { randomBytes } from 'node:crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { SqlExecutor } from './db.ts';
import type { GitHubOAuthAdapter } from './adapters/github.ts';
import { GitHubOAuthError } from './adapters/github.ts';
import { EmbeddingKeyError, type EmbeddingKeyAdapter } from './adapters/openrouter.ts';
import { digestMatches, randomToken } from './tokens.ts';
import {
  authenticateSession,
  countActiveWorkspaces,
  countWorkspacesForOwner,
  createPendingSignup,
  createSession,
  createUser,
  createWorkspaceRecord,
  consumeInviteCode,
  deletePendingSignup,
  findPendingSignup,
  findUserByGithubId,
  findWorkspaceById,
  hasOperatorUser,
  inviteWorkspaceQuota,
  issueInviteCode,
  listInviteCodes,
  listWorkspacesForUser,
  requestLifecycleAction,
  revokeSession,
  SESSION_TTL_DAYS,
  type ControlPlaneUser,
  type LifecycleState,
  type WorkspaceRecord,
} from './store.ts';
import { dashboardPage, deleteWorkspacePage, landingPage, signupPage } from './pages.ts';

export interface ControlPlaneOptions {
  db: SqlExecutor;
  github: GitHubOAuthAdapter;
  /** Immutable GitHub ids eligible to claim the one-time operator bootstrap. */
  operatorGithubIds?: number[];
  /** Defaults to true (fail closed). Set false only for plain-HTTP local runs and tests. */
  secureCookies?: boolean;
  /** Zone the fleet's subdomains are minted under, e.g. "workspaces.example.com". */
  workspaceDomain?: string;
  /** Upper bound on live workspaces. The pilot targets a fleet of ~10-20. */
  fleetCap?: number;
  /**
   * Reads per-workspace embedding spend for the operator's metering view.
   * Absent (local runs, tests that do not exercise it) makes the usage route
   * report the figure as unavailable rather than 500.
   */
  embeddingKeys?: EmbeddingKeyAdapter;
}

/**
 * A subdomain is derived from the name, never supplied: it is a fleet-wide
 * unique DNS label and a certificate subject, not a user-controlled string.
 */
export function deriveSubdomainLabel(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug.length > 0 ? slug : 'workspace';
}

const SESSION_COOKIE = 'cp_session';
const CSRF_COOKIE = 'cp_csrf';
const STATE_COOKIE = 'cp_oauth_state';
const PENDING_COOKIE = 'cp_pending';

type AuthenticatedUser = ControlPlaneUser & { csrfHash: string };

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const value = part.slice(eq + 1).trim();
    try {
      cookies[part.slice(0, eq).trim()] = decodeURIComponent(value);
    } catch {
      // A malformed percent-encoding in one cookie must not 500 the request.
      cookies[part.slice(0, eq).trim()] = value;
    }
  }
  return cookies;
}

/** A single path parameter as a plain string; a repeated one is not a match. */
function pathParam(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  return typeof value === 'string' ? value : '';
}

function apiError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/** Postgres unique_violation. Both engines behind SqlExecutor report it as 23505. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

/** One plain label, then suffixed candidates. Five is far past a real collision. */
const SUBDOMAIN_ATTEMPTS = 5;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CreateRefusal = 'invalid_name' | 'invalid_tier' | 'fleet_cap_reached' | 'invite_quota_reached' | 'subdomain_unavailable';

type CreateOutcome = { outcome: 'created'; workspace: WorkspaceRecord } | { outcome: CreateRefusal };

/** Fail-closed narrowing for the refusal re-render: never echo raw input into the page. */
function narrowTier(rawTier: unknown): 'brain' | 'agent' {
  return rawTier === 'agent' ? 'agent' : 'brain';
}

/** One wording per refusal, so the API and the form cannot describe it differently. */
const REFUSAL: Record<CreateRefusal, { status: number; message: string }> = {
  invalid_name: { status: 400, message: 'Give the workspace a name of 1 to 120 characters, including at least one letter or number.' },
  invalid_tier: { status: 400, message: 'Choose a workspace tier of brain or agent.' },
  fleet_cap_reached: { status: 409, message: 'The fleet is at capacity. Ask the operator to raise the cap.' },
  invite_quota_reached: { status: 409, message: 'Your invite does not allow another workspace. Ask the operator for more.' },
  subdomain_unavailable: { status: 409, message: 'That name is taken. Try a different one.' },
};

/**
 * Shared by the JSON API and the dashboard form, so the caps and the name rules
 * cannot drift apart depending on which one the caller reached for.
 */
async function createWorkspaceForUser(
  db: SqlExecutor,
  user: ControlPlaneUser,
  rawName: unknown,
  rawTier: unknown,
  workspaceDomain: string,
  fleetCap: number,
): Promise<CreateOutcome> {
  const ownerUserId = user.userId;
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (name.length === 0 || name.length > 120 || !/[a-z0-9]/i.test(name)) return { outcome: 'invalid_name' };

  // Deployment tier, not authority: agent tier selects the runtime profile only
  // (#57). The pilot has no entitlement gate. Absent means brain, so existing
  // clients that never heard of tiers keep creating exactly what they always did;
  // anything else unrecognized is refused rather than coerced.
  const tier = rawTier === undefined || rawTier === null || rawTier === '' ? 'brain' : rawTier;
  if (tier !== 'brain' && tier !== 'agent') return { outcome: 'invalid_tier' };

  // Two bounds, not one. The fleet cap protects total spend; the invite quota
  // stops a single invited user claiming every slot under it. The operator
  // signed up without an invite and is bounded by the fleet cap alone.
  if (user.inviteId) {
    const [quota, owned] = await Promise.all([
      inviteWorkspaceQuota(db, user.inviteId),
      countWorkspacesForOwner(db, ownerUserId),
    ]);
    if (owned >= quota) return { outcome: 'invite_quota_reached' };
  }

  // The subdomain is fleet-wide unique, so a name someone already used falls
  // back to a suffixed label. Each candidate gets its own transaction: a unique
  // violation aborts the transaction it happened in, so retrying inside one
  // would run every later statement against a dead transaction.
  const label = deriveSubdomainLabel(name);
  for (let attempt = 0; attempt < SUBDOMAIN_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? label : `${label}-${randomBytes(2).toString('hex')}`;
    try {
      const workspace = await db.transaction(async tx => {
        // Counted inside the insert's transaction, so the window where two
        // creates both read an under-cap count is one statement wide. The cap is
        // a spend bound rather than a correctness invariant: one over under a
        // genuine race is survivable, an unbounded fleet is not.
        if ((await countActiveWorkspaces(tx)) >= fleetCap) return null;
        return createWorkspaceRecord(tx, { ownerUserId, name, subdomain: `${candidate}.${workspaceDomain}`, tier });
      });
      return workspace ? { outcome: 'created', workspace } : { outcome: 'fleet_cap_reached' };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return { outcome: 'subdomain_unavailable' };
}

type LifecycleAction = 'delete' | 'suspend' | 'resume';

interface LifecycleActionSpec {
  /** The in-flight state the request writes. The reconciler settles it. */
  target: 'deleting' | 'suspending' | 'resuming';
  /** States the action is defined for; anything else is refused unchanged. */
  allowedFrom: readonly LifecycleState[];
  /** Suspension is the enforcement lever, so only the operator holds it. */
  operatorOnly: boolean;
  refusal: string;
}

const LIFECYCLE_ACTIONS: Record<LifecycleAction, LifecycleActionSpec> = {
  // Delete is offered from every live state, a provision still in flight
  // included: a workspace wedged part-way through is the one an owner most wants
  // rid of, and teardown releases whatever handles the registry has recorded by
  // the time it runs. Re-requesting a delete already under way is accepted
  // rather than refused, so a double-submitted form does not read as an error.
  delete: {
    target: 'deleting',
    allowedFrom: ['provisioning', 'running', 'suspending', 'suspended', 'resuming', 'failed', 'deleting'],
    operatorOnly: false,
    refusal: 'This workspace cannot be deleted in its current state.',
  },
  suspend: {
    target: 'suspending',
    allowedFrom: ['running'],
    operatorOnly: true,
    refusal: 'Only a running workspace can be suspended.',
  },
  resume: {
    target: 'resuming',
    allowedFrom: ['suspended'],
    operatorOnly: true,
    refusal: 'Only a suspended workspace can be resumed.',
  },
};

export function createControlPlaneApp(options: ControlPlaneOptions): Express {
  const { db, github } = options;
  const operatorGithubIds = new Set((options.operatorGithubIds ?? []).filter(id => Number.isSafeInteger(id) && id > 0));
  const secure = options.secureCookies ?? true;
  const workspaceDomain = options.workspaceDomain ?? 'workspaces.example.com';
  const fleetCap = options.fleetCap ?? 20;
  const embeddingKeys = options.embeddingKeys;

  const baseCookie = { httpOnly: true, sameSite: 'lax' as const, secure, path: '/' };

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const sessionCookieMaxAgeMs = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  const setSessionCookies = (res: Response, session: string, csrf: string): void => {
    res.cookie(SESSION_COOKIE, session, { ...baseCookie, maxAge: sessionCookieMaxAgeMs });
    // Deliberately readable by the page (double-submit CSRF token).
    res.cookie(CSRF_COOKIE, csrf, { ...baseCookie, httpOnly: false, maxAge: sessionCookieMaxAgeMs });
  };

  const clearSessionCookies = (res: Response): void => {
    res.clearCookie(SESSION_COOKIE, baseCookie);
    res.clearCookie(CSRF_COOKIE, { ...baseCookie, httpOnly: false });
  };

  const currentUser = async (req: Request): Promise<AuthenticatedUser | null> => {
    const raw = parseCookies(req)[SESSION_COOKIE];
    if (!raw) return null;
    return authenticateSession(db, raw);
  };

  const csrfMatches = (req: Request, auth: AuthenticatedUser): boolean => {
    const provided = (req.headers['x-csrf-token'] as string | undefined) ?? (req.body as Record<string, unknown> | undefined)?.csrf;
    return typeof provided === 'string' && provided.length > 0 && digestMatches(provided, auth.csrfHash);
  };

  const signIn = async (res: Response, user: ControlPlaneUser): Promise<void> => {
    const { session, csrf } = await createSession(db, user.userId);
    setSessionCookies(res, session, csrf);
    res.redirect(302, '/dashboard');
  };

  // ------------------------------------------------------------------ pages

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/', async (req, res) => {
    const user = await currentUser(req);
    if (user) return res.redirect(302, '/dashboard');
    res.type('html').send(landingPage());
  });

  app.get('/dashboard', async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.redirect(302, '/');
    const workspaces = await listWorkspacesForUser(db, user.userId);
    res.type('html').send(dashboardPage(user, workspaces, parseCookies(req)[CSRF_COOKIE] ?? ''));
  });

  // ------------------------------------------------------------- GitHub auth

  app.get('/auth/github', (_req, res) => {
    const state = randomToken();
    res.cookie(STATE_COOKIE, state, { ...baseCookie, maxAge: 10 * 60 * 1000 });
    res.redirect(302, github.authorizeUrl(state));
  });

  app.get('/auth/github/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const expectedState = parseCookies(req)[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, baseCookie);
    if (!state || !expectedState || state !== expectedState) {
      return apiError(res, 400, 'oauth_state_mismatch', 'The sign-in attempt could not be verified. Start again from the home page.');
    }

    let profile;
    try {
      profile = await github.exchangeCode(code);
    } catch (error) {
      if (error instanceof GitHubOAuthError) {
        return apiError(res, 400, 'oauth_exchange_failed', 'GitHub did not accept the sign-in. Start again from the home page.');
      }
      throw error;
    }

    const existing = await findUserByGithubId(db, profile.githubId);
    if (existing) return signIn(res, existing);

    // One-time operator bootstrap: the configured immutable GitHub id may
    // create the first operator account so that account can issue invites.
    // Once claimed, every other new identity follows the invite-gated path.
    if (operatorGithubIds.has(profile.githubId) && !(await hasOperatorUser(db))) {
      try {
        const operator = await createUser(db, profile, { isOperator: true });
        return signIn(res, operator);
      } catch (error) {
        // The database enforces a single operator claim. Concurrent callbacks
        // for the same identity sign into the winner; a different configured
        // identity that loses the race continues through invite-gated signup.
        const racedUser = await findUserByGithubId(db, profile.githubId);
        if (racedUser) return signIn(res, racedUser);
        if (!(await hasOperatorUser(db))) throw error;
      }
    }

    const pendingToken = await createPendingSignup(db, profile);
    res.cookie(PENDING_COOKIE, pendingToken, { ...baseCookie, maxAge: 30 * 60 * 1000 });
    res.redirect(302, '/signup');
  });

  app.post('/auth/logout', async (req, res) => {
    const user = await currentUser(req);
    if (user && csrfMatches(req, user)) {
      const raw = parseCookies(req)[SESSION_COOKIE];
      if (raw) await revokeSession(db, raw);
    }
    clearSessionCookies(res);
    res.redirect(302, '/');
  });

  // ------------------------------------------------------------------ signup

  app.get('/signup', async (req, res) => {
    const token = parseCookies(req)[PENDING_COOKIE];
    const pending = token ? await findPendingSignup(db, token) : null;
    if (!pending) return res.redirect(302, '/');
    res.type('html').send(signupPage(pending.login));
  });

  // No session CSRF token exists yet at signup time; the httpOnly pending
  // cookie is the credential, and SameSite=Lax keeps cross-site POSTs from
  // carrying it.
  app.post('/signup', async (req, res) => {
    const token = parseCookies(req)[PENDING_COOKIE];
    const pending = token ? await findPendingSignup(db, token) : null;
    if (!pending || !token) {
      return apiError(res, 401, 'signup_session_expired', 'Your signup session expired. Sign in with GitHub again.');
    }

    // Signed up in another tab meanwhile: just sign in.
    const existing = await findUserByGithubId(db, pending.githubId);
    if (existing) {
      await deletePendingSignup(db, token);
      res.clearCookie(PENDING_COOKIE, baseCookie);
      return signIn(res, existing);
    }

    const code = typeof (req.body as Record<string, unknown>).invite_code === 'string' ? ((req.body as Record<string, unknown>).invite_code as string).trim() : '';
    let result;
    try {
      result = await db.transaction(async tx => {
        const redemption = await consumeInviteCode(tx, code);
        if (redemption.outcome !== 'redeemed') return redemption;
        const user = await createUser(tx, pending, { inviteId: redemption.inviteId });
        return { outcome: 'created' as const, user };
      });
    } catch (error) {
      // Concurrent redemption in another tab: the github_id unique constraint
      // rolled us back (invite use not burned). If the account now exists,
      // finish as a plain sign-in instead of a 500.
      const racedUser = await findUserByGithubId(db, pending.githubId);
      if (!racedUser) throw error;
      await deletePendingSignup(db, token);
      res.clearCookie(PENDING_COOKIE, baseCookie);
      return signIn(res, racedUser);
    }

    if (result.outcome === 'invalid') {
      return res.status(400).type('html').send(signupPage(pending.login, 'That invite code is not valid.'));
    }
    if (result.outcome === 'exhausted') {
      return res.status(400).type('html').send(signupPage(pending.login, 'That invite code has been exhausted. Ask the operator for a new one.'));
    }
    if (result.outcome !== 'created') {
      return apiError(res, 500, 'signup_failed', 'Signup failed unexpectedly. Try again.');
    }

    await deletePendingSignup(db, token);
    res.clearCookie(PENDING_COOKIE, baseCookie);
    return signIn(res, result.user);
  });

  // --------------------------------------------------------------------- API

  /** Authenticate an API request, sending the 401 envelope when no session exists. */
  const requireUser = async (req: Request, res: Response): Promise<AuthenticatedUser | null> => {
    const user = await currentUser(req);
    if (!user) apiError(res, 401, 'unauthenticated', 'Sign in first.');
    return user;
  };

  app.get('/api/me', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    res.json({ userId: user.userId, login: user.login, name: user.name, operator: user.isOperator });
  });

  /** The shape both the list and the single-workspace status route return. */
  const workspaceView = (w: WorkspaceRecord) => ({
    workspaceId: w.workspaceId,
    name: w.name,
    subdomain: w.subdomain,
    tier: w.tier,
    lifecycleState: w.lifecycleState,
    provisioningStep: w.provisioningStep,
    setupLink: w.setupLink,
    error: w.provisioningError,
  });

  app.get('/api/workspaces', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaces = await listWorkspacesForUser(db, user.userId);
    res.json({ workspaces: workspaces.map(workspaceView) });
  });

  app.post('/api/workspaces', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!csrfMatches(req, user)) return apiError(res, 403, 'csrf_mismatch', 'Missing or invalid CSRF token.');

    const result = await createWorkspaceForUser(db, user, (req.body ?? {}).name, (req.body ?? {}).tier, workspaceDomain, fleetCap);
    if (result.outcome !== 'created') {
      const refusal = REFUSAL[result.outcome];
      return apiError(res, refusal.status, result.outcome, refusal.message);
    }
    res.status(201).json(workspaceView(result.workspace));
  });

  // The dashboard's own form. Same rules, same caps; only the reply differs.
  app.post('/workspaces', async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.redirect(302, '/');
    if (!csrfMatches(req, user)) return apiError(res, 403, 'csrf_mismatch', 'Missing or invalid CSRF token.');
    const result = await createWorkspaceForUser(db, user, (req.body ?? {}).name, (req.body ?? {}).tier, workspaceDomain, fleetCap);
    if (result.outcome !== 'created') {
      const refusal = REFUSAL[result.outcome];
      const workspaces = await listWorkspacesForUser(db, user.userId);
      return res.status(refusal.status).type('html')
        .send(dashboardPage(
          user,
          workspaces,
          parseCookies(req)[CSRF_COOKIE] ?? '',
          refusal.message,
          narrowTier((req.body ?? {}).tier),
        ));
    }
    res.redirect(302, '/dashboard');
  });

  app.get('/api/workspaces/:workspaceId', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    // Postgres raises on a malformed uuid, which would surface as a 500 for what
    // is really just a request for something that cannot exist.
    if (!UUID_PATTERN.test(req.params.workspaceId)) {
      return apiError(res, 404, 'workspace_not_found', 'No such workspace.');
    }
    const workspace = await findWorkspaceById(db, req.params.workspaceId);
    // A workspace someone else owns is reported as absent, not as forbidden:
    // 403 would confirm the id exists.
    if (!workspace || workspace.ownerUserId !== user.userId || workspace.lifecycleState === 'deleted') {
      return apiError(res, 404, 'workspace_not_found', 'No such workspace.');
    }
    res.json(workspaceView(workspace));
  });

  // -------------------------------------------------------------- lifecycle

  /**
   * Everything a lifecycle request must satisfy before it may write an intent:
   * a CSRF token, a well-formed id, a workspace that exists and that this user
   * is allowed to see, and — for the operator levers — the operator role.
   *
   * A workspace someone else owns is reported absent rather than forbidden, the
   * same rule the status route follows: a 403 would confirm the id exists.
   */
  /**
   * The workspace a request's path names, if this user is allowed to know it
   * exists: their own, or — for the operator — any of them. A workspace that is
   * absent, deleted, or someone else's is one answer, `null`, so no caller can
   * tell those cases apart.
   */
  const visibleWorkspace = async (req: Request, user: ControlPlaneUser): Promise<WorkspaceRecord | null> => {
    // Read through a narrowing helper: some of these routes are registered in a
    // loop and so do not carry the path's parameter types.
    const workspaceId = pathParam(req, 'workspaceId');
    if (!UUID_PATTERN.test(workspaceId)) return null;
    const workspace = await findWorkspaceById(db, workspaceId);
    if (!workspace || workspace.lifecycleState === 'deleted') return null;
    return user.isOperator || workspace.ownerUserId === user.userId ? workspace : null;
  };

  const authorizeLifecycle = async (
    req: Request,
    res: Response,
    action: LifecycleAction,
    spec: LifecycleActionSpec,
  ): Promise<{ user: AuthenticatedUser; workspace: WorkspaceRecord } | null> => {
    const user = await currentUser(req);
    if (!user) {
      apiError(res, 401, 'unauthenticated', 'Sign in first.');
      return null;
    }
    if (!csrfMatches(req, user)) {
      apiError(res, 403, 'csrf_mismatch', 'Missing or invalid CSRF token.');
      return null;
    }
    const workspace = await visibleWorkspace(req, user);
    if (!workspace) {
      apiError(res, 404, 'workspace_not_found', 'No such workspace.');
      return null;
    }
    if (spec.operatorOnly && !user.isOperator) {
      apiError(res, 403, 'operator_required', `Only the operator can ${action} a workspace.`);
      return null;
    }
    return { user, workspace };
  };

  // One route per action rather than a single `:action` parameter, so a path
  // this table does not name can never reach the handler.
  for (const action of Object.keys(LIFECYCLE_ACTIONS) as LifecycleAction[]) {
    const spec = LIFECYCLE_ACTIONS[action];
    app.post(`/api/workspaces/:workspaceId/${action}`, async (req, res) => {
      const authorized = await authorizeLifecycle(req, res, action, spec);
      if (!authorized) return;
      const updated = await requestLifecycleAction(db, authorized.workspace.workspaceId, spec.target, spec.allowedFrom);
      if (!updated) {
        return apiError(
          res,
          409,
          'incompatible_state',
          `${spec.refusal} This one is ${authorized.workspace.lifecycleState}.`,
        );
      }
      // 202, not 200: the intent is recorded, the cloud effects happen on a
      // later tick, and the status route is where the outcome shows up.
      res.status(202).json(workspaceView(updated));
    });
  }

  /**
   * The confirmation page. Deletion is irreversible and the pilot keeps no
   * backups, so the copy names what survives and what does not, and the owner
   * types the workspace name to prove they read it.
   */
  app.get('/workspaces/:workspaceId/delete', async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.redirect(302, '/');
    const workspace = await visibleWorkspace(req, user);
    // An HTML route, so a workspace this user cannot see sends them back to the
    // dashboard rather than answering a page request with a JSON envelope.
    if (!workspace) return res.redirect(302, '/dashboard');
    res.type('html').send(deleteWorkspacePage(workspace, parseCookies(req)[CSRF_COOKIE] ?? ''));
  });

  // The dashboard's own delete. Same rules as the API, plus the typed-name
  // check, which exists only here: an API caller spelled the id out already.
  app.post('/workspaces/:workspaceId/delete', async (req, res) => {
    const spec = LIFECYCLE_ACTIONS.delete;
    const authorized = await authorizeLifecycle(req, res, 'delete', spec);
    if (!authorized) return;
    const { workspace } = authorized;

    const typed = typeof (req.body ?? {}).confirm_name === 'string' ? ((req.body as { confirm_name: string }).confirm_name).trim() : '';
    const csrf = parseCookies(req)[CSRF_COOKIE] ?? '';
    if (typed !== workspace.name) {
      return res.status(400).type('html')
        .send(deleteWorkspacePage(workspace, csrf, 'That is not the workspace name. Type it exactly to confirm.'));
    }

    const updated = await requestLifecycleAction(db, workspace.workspaceId, spec.target, spec.allowedFrom);
    if (!updated) {
      return res.status(409).type('html')
        .send(deleteWorkspacePage(workspace, csrf, `${spec.refusal} This one is ${workspace.lifecycleState}.`));
    }
    res.redirect(302, '/dashboard');
  });

  /**
   * Per-workspace embedding spend — the metering the platform's configuration
   * fee is set from. Operator-only, and fleet-wide rather than owner-scoped:
   * this reads the platform's own account, not the customer's.
   */
  app.get('/api/workspaces/:workspaceId/usage', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!user.isOperator) return apiError(res, 403, 'operator_required', 'Only the operator can read workspace usage.');
    if (!UUID_PATTERN.test(req.params.workspaceId)) {
      return apiError(res, 404, 'workspace_not_found', 'No such workspace.');
    }
    const workspace = await findWorkspaceById(db, req.params.workspaceId);
    if (!workspace) return apiError(res, 404, 'workspace_not_found', 'No such workspace.');

    const view = { workspaceId: workspace.workspaceId, subdomain: workspace.subdomain };
    // A workspace that has not reached the credentials step, or whose key was
    // revoked with it, has no spend to report. That is an answer, not an error.
    if (!embeddingKeys || !workspace.embeddingTokenRef) return res.json({ ...view, embedding: null });
    try {
      const status = await embeddingKeys.readUsage(workspace.embeddingTokenRef);
      if (!status) return res.json({ ...view, embedding: null });
      res.json({ ...view, embedding: { usageUsd: status.usageUsd, limitUsd: status.limitUsd, disabled: status.disabled } });
    } catch (error) {
      // Reporting zero because the provider was unreachable would understate a
      // bill. Say the figure is unavailable instead.
      const detail = error instanceof EmbeddingKeyError ? error.message : 'the usage provider is unavailable';
      apiError(res, 503, 'usage_unavailable', detail);
    }
  });

  app.post('/api/invites', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!csrfMatches(req, user)) return apiError(res, 403, 'csrf_mismatch', 'Missing or invalid CSRF token.');
    if (!user.isOperator) return apiError(res, 403, 'operator_required', 'Only the operator can issue invite codes.');

    const body = (req.body ?? {}) as { maxUses?: unknown; workspaceQuota?: unknown; note?: unknown };
    const maxUses = body.maxUses === undefined ? 1 : Number(body.maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
      return apiError(res, 400, 'invalid_max_uses', 'maxUses must be an integer between 1 and 1000.');
    }
    const workspaceQuota = body.workspaceQuota === undefined ? 1 : Number(body.workspaceQuota);
    if (!Number.isInteger(workspaceQuota) || workspaceQuota < 1 || workspaceQuota > 100) {
      return apiError(res, 400, 'invalid_workspace_quota', 'workspaceQuota must be an integer between 1 and 100.');
    }
    const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;
    const invite = await issueInviteCode(db, { createdBy: user.userId, maxUses, workspaceQuota, note });
    res.status(201).json(invite);
  });

  app.get('/api/invites', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!user.isOperator) return apiError(res, 403, 'operator_required', 'Only the operator can list invite codes.');
    res.json({ invites: await listInviteCodes(db) });
  });

  // ------------------------------------------------------------ safe errors

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[control-plane] unhandled error:', error);
    if (res.headersSent) return;
    apiError(res, 500, 'internal_error', 'Something went wrong.');
  });

  return app;
}
