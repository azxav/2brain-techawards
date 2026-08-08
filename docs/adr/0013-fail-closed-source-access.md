# Grant Member Source access explicitly and fail closed

A newly invited Member receives only the Source Access an Administrator explicitly selects: All Sources, Specific Sources, or No Source Access. All Sources includes future Sources, while Specific Sources does not; this prevents newly connected knowledge from becoming visible through an accidental default and keeps Source authorization independent of Workspace role.

ADR-0049 clarifies that the authorization universe is every active Source in the Brain, not only Sources created through the Workspace Managed Git flow. All Sources therefore includes the built-in **Workspace Knowledge** Source and future core Sources; Specific Sources may explicitly grant them. Missing policy and inactive Sources still fail closed.
