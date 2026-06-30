#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const repo = resolve(process.argv[2] || '.')
const inventoryPath = resolve(repo, process.argv[3] || '.harness-technology-inventory.json')
const specPath = resolve(repo, process.argv[4] || 'project_specs.xml')
const kinds = new Set(['documentation', 'manifest', 'configuration', 'adapter', 'iac'])
const sections = new Set(['technology_stack', 'integrations', 'prerequisites'])
const fail = message => { console.error(message); process.exit(1) }

let inventory
try { inventory = JSON.parse(await readFile(inventoryPath, 'utf8')) } catch (error) { fail(`invalid technology inventory: ${error.message}`) }
if (!Array.isArray(inventory.technologies) || !inventory.technologies.length) fail('technology inventory has no technologies')

for (const technology of inventory.technologies) {
  if (!technology.name || !sections.has(technology.section) || !Array.isArray(technology.evidence) || !technology.evidence.length)
    fail(`invalid technology entry: ${technology.name || '<unnamed>'}`)
  for (const evidence of technology.evidence) {
    if (!evidence.path || !kinds.has(evidence.kind)) fail(`invalid evidence for ${technology.name}`)
    try { await access(resolve(repo, evidence.path)) } catch { fail(`missing evidence for ${technology.name}: ${evidence.path}`) }
  }
}
for (const contradiction of inventory.contradictions || []) {
  if (!contradiction.documentation || !contradiction.implementation || !contradiction.resolution)
    fail('invalid documentation/implementation contradiction')
}

if (process.argv.includes('--inventory-only')) {
  console.log(`ok - ${inventory.technologies.length} evidence-backed technologies inventoried`)
  process.exit(0)
}

let spec
try { spec = await readFile(specPath, 'utf8') } catch (error) { fail(`cannot read specification: ${error.message}`) }
const missing = inventory.technologies.filter(technology => {
  const match = spec.match(new RegExp(`<${technology.section}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${technology.section}>`, 'i'))
  return !match || !match[1].toLowerCase().includes(technology.name.toLowerCase())
})
if (missing.length) fail(`missing technologies: ${missing.map(item => `${item.name} [${item.section}] (${item.evidence.map(e => e.path).join(', ')})`).join('; ')}`)
const unresolved = (inventory.contradictions || []).filter(item => !spec.toLowerCase().includes(item.resolution.toLowerCase()))
if (unresolved.length) fail(`missing contradictions: ${unresolved.map(item => item.resolution).join('; ')}`)
console.log(`ok - ${inventory.technologies.length} discovered technologies documented`)
