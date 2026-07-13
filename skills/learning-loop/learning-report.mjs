#!/usr/bin/env node
import {
  scan,
  extractVerdicts,
  clusterDefects,
  recurrenceReport,
  proposeRoutes,
} from './lib/evidence-corpus.mjs'

const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  const value = process.argv[i + 1]
  if (!key?.startsWith('--') || value === undefined) {
    process.stderr.write(`learning-report: invalid argument ${key || ''}\n`)
    process.exit(2)
  }
  options[key.slice(2)] = value
}

const minN = Math.max(1, Number(options.min || 2))
const corpus = await scan({
  repo: options.repo || process.cwd(),
  projectId: options.project || undefined,
  runId: options.run || undefined,
  context: options.context || undefined,
})
const verdicts = extractVerdicts(corpus)
const clusters = clusterDefects(verdicts)
const recurring = recurrenceReport(clusters, minN)
const routes = proposeRoutes(recurring)

process.stdout.write(`${JSON.stringify({
  schema: 'harness-learning-report.v1',
  generatedAt: new Date().toISOString(),
  recurrenceThreshold: minN,
  corpus: {
    roots: corpus.roots,
    count: corpus.count,
    skipped: corpus.skipped,
  },
  recurring,
  routes,
  approvalRequired: true,
}, null, 2)}\n`)
