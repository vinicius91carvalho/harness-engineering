#!/usr/bin/env node
import {
  selectClaim,
  resumeClaim,
  blockClaim,
  releaseClaim,
  mergeAcquire,
  mergeDo,
  mergeRelease,
  listClaims,
  strike,
  readStrikes,
} from './claim-lease.mjs'

function die(message) {
  process.stderr.write(`claim.sh: ${message}\n`)
  process.exit(1)
}

const [cmd, ...args] = process.argv.slice(2)

switch (cmd) {
  case 'select-claim': {
    const [repo, mode, selector, session] = args
    const result = selectClaim(repo, mode, selector, session)
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`)
    break
  }
  case 'resume': {
    const [repo, selector, session, force] = args
    const result = resumeClaim(repo, selector, session, force)
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`)
    break
  }
  case 'block': {
    const [repo, context] = args
    process.stdout.write(`${blockClaim(repo, context)}\n`)
    break
  }
  case 'release': {
    const [repo, context] = args
    process.stdout.write(`${releaseClaim(repo, context)}\n`)
    break
  }
  case 'merge-acquire': {
    const [repo, session] = args
    const result = mergeAcquire(repo, session)
    if (result.busy) process.exit(1)
    process.stdout.write(`${result.integDir}\n`)
    break
  }
  case 'merge-do': {
    const [repo, context, integ] = args
    const result = mergeDo(repo, context, integ)
    if (result.status === 'clean') {
      process.stdout.write('clean\n')
      process.exit(0)
    }
    if (result.status === 'conflict') {
      process.stdout.write(`conflict in: ${result.integ}\n`)
      for (const path of result.paths) process.stdout.write(`${path}\n`)
      process.exit(2)
    }
    process.stderr.write(`${result.message}\n`)
    process.exit(1)
  }
  case 'merge-release': {
    const [repo, session] = args
    process.stdout.write(`${mergeRelease(repo, session)}\n`)
    break
  }
  case 'list': {
    const [repo] = args
    for (const line of listClaims(repo)) process.stdout.write(`${line}\n`)
    break
  }
  case 'strike': {
    const [repo, key, delta] = args
    strike(repo, key, delta)
    break
  }
  case 'strikes': {
    const [repo] = args
    process.stdout.write(`${JSON.stringify(readStrikes(repo))}\n`)
    break
  }
  default:
    die('usage: claim.sh {select-claim|resume|block|release|merge-acquire|merge-do|merge-release|list|strike|strikes} <repo> ...')
}
