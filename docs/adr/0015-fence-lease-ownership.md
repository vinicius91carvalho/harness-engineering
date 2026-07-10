# Fence Claim Lease and Supervisor Lease ownership

Claim Lease and Supervisor Lease mutations carry a fencing generation that must match on every write.
Same-host PID checks alone are not sufficient after cross-host takeover.
Stale writers fail closed; Resume and Supervisor takeover mint a new generation.
