# Register Agents with least-privilege defaults

A newly registered Agent has one accountable Agent Owner, the Read tier, and No Source Access until an Administrator grants All Sources or Specific Sources. Product tiers map cumulatively to backend capabilities: Read grants read operations, Write grants Read plus write operations, and Admin grants Read plus Write plus administrative operations. Admin is never a default, preventing a newly connected non-human client from receiving broad access silently.
