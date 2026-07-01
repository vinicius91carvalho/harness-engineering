# Use durable Input Requests

When execution needs user direction, the harness persists a uniquely identified Input Request and exposes it through a host-neutral control interface; Control Hosts deliver it immediately and submit an idempotent response. Periodic 15-minute messages remain progress summaries rather than the mechanism for detecting blockers, so restarts, missed mobile delivery, or changing Control Hosts cannot lose the pending decision.
