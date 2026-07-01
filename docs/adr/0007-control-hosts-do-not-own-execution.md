# Control Hosts do not own execution

Optional long-lived agent and mobile surfaces act as Control Hosts: they submit goals, query status, and relay user decisions through a stable harness control interface. Scheduling, resource and quota governance, workers, retries, Run State, and completion remain owned by the harness so each surface cannot develop different execution semantics.
