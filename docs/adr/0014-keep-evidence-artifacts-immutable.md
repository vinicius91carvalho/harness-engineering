# Keep Evidence Artifacts immutable

Evidence Artifacts are create-only, scoped by project, run, context, Attempt, and kind, and referenced by digest from Workflow Journals and Defect Reports.
Overwrite of an existing path is a hard failure.
This preserves proof across retries, sibling projects, and Goal Review reopenings.
