# Plan repairs between QA attempts

Each failed isolated or integrated QA verdict produces a structured Defect Report, after which the orchestrator creates and persists a Repair Plan before invoking the coding agent again. An Attempt is one coding, isolated-QA, and—when reached—Integrated Verification cycle; after three failed Attempts the Work Item becomes blocked and the user receives the accumulated defect and repair summaries. This costs one planning step per failed QA run but avoids blind retries that discard the evidence gathered by QA.
