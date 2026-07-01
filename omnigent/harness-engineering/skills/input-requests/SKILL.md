---
name: input-requests
description: Relay durable workflow Input Requests to the user.
---

When Run State requires `user-guidance`, show the blocking evidence and request
one concrete decision. Persist the answer through the generator's explicit Resume
path; do not infer approval or create a second execution path.
