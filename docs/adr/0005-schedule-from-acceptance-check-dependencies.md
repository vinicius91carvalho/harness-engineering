# Schedule from Acceptance Check dependencies

Acceptance Checks may reference stable prerequisite IDs, and Work Items inherit those relationships as an acyclic Dependency Graph. The scheduler claims only Ready Work Items and rejects missing dependencies or cycles before execution. `foundation` remains descriptive, while explicit dependencies avoid both global over-blocking and hidden ordering constraints.
