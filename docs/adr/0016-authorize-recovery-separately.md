# Authorize recovery separately from failure classification

Failure classification decides the safe recovery class.
Authorization decides whether that recovery may proceed automatically or requires a durable Input Request response with an exact approved action.
Automatic responses must not impersonate user direction for Attempt exhaustion, blocked Work Items, or cross-host Claim Lease takeover.
