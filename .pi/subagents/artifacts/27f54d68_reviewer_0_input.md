# Task for reviewer

Review the repository at C:/Users/pisce/.pi/agent/git/github.com/pisceslailai/deepseek-kvcache (a Pi coding agent extension that optimizes DeepSeek KV cache usage during compaction).

Files to review:
- deepseek-kvcache.ts (the extension itself, ~200 lines)
- test/dskv-test.mts (e2e test: mock pi + real DeepSeek API three-way comparison)
- package.json (pi package format)
- README.md

Background: pi's default compaction serializes old messages to "[User]: ..." text, which misses DeepSeek's automatic prefix cache. This extension caches the main conversation wire payload (before_provider_request) and takes over compaction (session_before_compact) by reusing that payload verbatim as prefix + appending a summary instruction, so the common prefix hits the cache (~50x cheaper).

Review focus:
1. Correctness: payload cache construction, prefix reuse logic, model-switch guard, fallback paths (any failure must silently fall back to pi default compaction)
2. Type safety and edge cases: structuredClone usage, fetch error handling, abort signal handling, usage mapping (DeepSeek usage -> pi-ai Usage shape)
3. Security: API key handling (only reads Authorization header from pi, never logs it)
4. Test quality: does test/dskv-test.mts actually validate what it claims? Any flaws in the three-way comparison methodology?
5. Package hygiene: package.json pi.extensions declaration, peerDependencies, README accuracy

Output a structured review: findings by severity (critical / major / minor / nit), each with file:line reference and concrete fix suggestion. End with an overall verdict (approve / approve-with-changes / reject).

Be strict but fair: this is a real published extension. Do not invent issues; verify each finding against the actual code.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```