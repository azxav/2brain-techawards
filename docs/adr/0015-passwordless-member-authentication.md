# Authenticate Members through email invitations and magic links

2Brain v1 adds durable Member Identity, Workspace Membership, Invitation, and HttpOnly Workspace Session records. Administrators invite Members by email and invitees redeem single-use magic links without passwords; enterprise SSO is deferred, while the existing bootstrap secret remains a local setup and break-glass credential rather than becoming a shared Member login.
