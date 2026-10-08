import type { Register } from 'claude-code'
import { heartbeat } from './heartbeat'
import { memoryProvenance } from './memory-provenance'
import { precommitCheck } from './precommit-check'
import { rulesPersist } from './rules-persist'
import { searchBeforeBuild } from './search-before-build'
import { listenForApprovals, SignOff } from './signoff'
import { testReminder } from './test-reminder'

const list = (v: unknown, fallback: string) => String(v || fallback).split(',').map(s => s.trim()).filter(Boolean)

export const register: Register = (on, options) => {
  const signOff = new SignOff()

  if (options.searchBeforeBuild !== false) {
    searchBeforeBuild(on, {
      researchTools: list(options.researchTools, 'WebSearch, WebFetch, Agent:Explore, Agent:researcher, Agent:scout, Skill:*search*, mcp__*search*, mcp__*fetch*'),
      skipPaths: list(options.searchSkipPaths, '/tmp/, /temp/, /scratchpad/'),
      warnOnly: options.searchWarnOnly === true,
    })
  }
  if (options.testReminder !== false) testReminder(on)
  if (options.precommitCheck !== false) {
    precommitCheck(on, signOff, {
      checksFile: String(options.precommitFile ?? '.claude/precommit').trim(),
      timeoutSeconds: Math.min(600, Math.max(5, Number(options.precommitTimeoutSeconds ?? 120) || 120)),
      blockNoVerify: options.blockNoVerify !== false,
    })
  }
  if (options.rulesPersist !== false) {
    rulesPersist(on, {
      rulesFile: String(options.rulesFile ?? '').trim(),
      subagentRulesFile: String(options.subagentRulesFile ?? '').trim(),
    })
  }
  if (options.memoryProvenance !== false) memoryProvenance(on, list(options.memoryPaths, '/memory/'))

  heartbeat(on, String(options.heartbeatDir ?? '').trim(), 'guardrails-development')
  listenForApprovals(on, signOff, Number(options.approvalMinutes ?? 15) || 15, 'guardrails-development')
}
