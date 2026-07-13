# Use Shared Runtime Leases for reusable infra

Stable infra containers may be shared between concurrent workers only through a Shared Runtime Lease recorded under the shared Git directory.
The lease records holders, host, PID, worktree, service hints, ports, and a project fingerprint when available.
Preflight and teardown may prune dead holders, but app/API/dashboard containers under active code changes remain private to the Work Item that started them.
Owned runtime manifests record exact private resources so cleanup can stop the right PIDs and containers without dropping shared infra needed by siblings.
