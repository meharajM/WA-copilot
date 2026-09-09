import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAccountSpecificRequest, isAllowlistedSupportIntent, isPromptInjection, isSensitiveSupportTopic } from '../../src/main/services/AutonomyDecision'

type EvaluationCase = {
  name: string
  input: string
  allowlisted: boolean
  sensitive?: boolean
  injection?: boolean
  accountSpecific?: boolean
}

const cases = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/autonomy-evaluation-cases.json'), 'utf8')) as EvaluationCase[]

describe('autonomy evaluation matrix', () => {
  it('covers every required scenario category', () => {
    expect(new Set(cases.map(item => item.name))).toEqual(new Set(['common FAQ', 'missing knowledge', 'contradictory answer', 'unsupported multilingual', 'follow-up', 'sensitive refund', 'prompt injection', 'account-specific order']))
  })

  for (const item of cases) {
    it(`matches expected policy signals for ${item.name}`, () => {
      expect(isAllowlistedSupportIntent(item.input)).toBe(item.allowlisted)
      if (item.sensitive !== undefined) expect(isSensitiveSupportTopic(item.input)).toBe(item.sensitive)
      if (item.injection !== undefined) expect(isPromptInjection(item.input)).toBe(item.injection)
      if (item.accountSpecific !== undefined) expect(isAccountSpecificRequest(item.input)).toBe(item.accountSpecific)
    })
  }
})
