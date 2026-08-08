/**
 * The one error type every bound-Agent access module raises. It lives in its own
 * module so the readiness evaluator, the native-password derivation, the binding
 * store, and the runtime-operation queue can all share it without any of them
 * having to import each other.
 */
export class AgentAccessError extends Error {
  constructor(readonly code:
    | 'agent_binding_not_found'
    | 'agent_password_secret_required'
    | 'agent_password_secret_changed'
    | 'idempotency_conflict'
    | 'invalid_agent_password_generation'
    | 'invalid_runtime_operation'
    // #68 Task 10 — Administrator provider setup and the model proofs. Every
    // one of these is already safe to show a customer: none carries provider,
    // plan, account, or upstream error text.
    | 'required_model_unavailable'
    | 'provider_import_failed'
    | 'model_check_failed'
    | 'answer_proof_failed'
    | 'proof_superseded') {
    super(code);
    this.name = 'AgentAccessError';
  }
}
