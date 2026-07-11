# Control-host beacon and turn-end backstop

A Control Host must not silently Stop while workers are live or required Control Journal consumers still have unread actionable events.
Soft stop is blocked until workers exit and registered consumers (default: herdr-notify) catch up; after a bounded wait (about 60s) surface an Input Request rather than forcing exit.
Authorized force stop remains a separate recovery path (ADR-0016).
This deepens fail-closed Control Host locality; it does not move execution policy into the Control Host (ADR-0007) and does not replace Claim Lease fences (ADR-0015).
