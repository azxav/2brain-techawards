# Record protected administrative changes as immutable Audit Events

Every protected administrative change creates an immutable Audit Event containing the acting Member or Agent, action, target, timestamp, redacted before and after values, and result. Dismissals, role or access reductions, credential revocation, Source deletion, and other destructive actions require a reason; Audit Events cannot be edited or deleted through the Workspace and remain until Workspace deletion.
