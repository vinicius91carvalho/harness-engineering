# Govern admission host-wide and provider-aware

Every worker admission path (Supervisor tick, Resume, retry, Goal Review, and direct generator) must obtain a Resource Governor grant.
Capacity is the minimum of configured, CPU, memory, swap pressure, load, and provider-scoped quota limits across repositories on the same host.
Reservations carry a resource class and cost, so browser, Goal Review, and compose-build workers can consume more capacity than static or basic coding workers.
Project Supervisors keep local queues; they do not keep private host-wide capacity math.
Zero capacity defers admission without consuming retry Attempts.
