# Use an append-only Control Journal

Supervisor transitions, Control Events, and Input Request lineage are appended to one Control Journal.
Current supervisor status is derived by replay (with optional compaction), not by racing independent `state.json` and JSONL writers.
Malformed or torn tails fail closed instead of erasing history.
Control Hosts remain thin adapters over this journal.
