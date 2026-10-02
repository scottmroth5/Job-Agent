# Evals

Run before changing a model, prompt, schema, or threshold, and record the result here.
Both evals call Claude and cost money.

```
npm run evals                 inbox eval (synthetic cases, about $0.06)
npm run evals -- --all        also the scoring eval (your real cases, about $2)
npm run eval:inbox -- --verbose
npm run eval:score -- --models=claude-haiku-4-5,claude-sonnet-5-5 --max-usd=2
```

## Inbox (`evals/inbox`)

40 synthetic emails (made-up companies and people) against 8 open applications. The eval runs the real
decision code: the pre-filter, the rule cascade, Claude classification, the confidence gate (0.85), and
the injection guard. Each case uses a fresh in-memory database.

- **Pre-filter recall:** the share of job emails kept. **Drop rate:** the share of non-job emails skipped before any Claude call.
- **Match accuracy:** among classified emails, the final link after the gate equals the expected application (null equals null; an email sent to review counts as unlinked).
- **Classification accuracy:** among classified emails, the type equals the expected type.

| Date | Model | Prompt | Pre-filter recall / drop | Match | Classification | Review | By rule | Cost |
|---|---|---|---|---|---|---|---|---|
| 2026-10-02 | claude-haiku-4-5 | 2655b71d1c | 80% / 40% | 100% (0 wrong links) | 94% | 10% | 52% | $0.056 |
| 2026-10-02 | claude-haiku-4-5 | 6580ccaf1d | 80% / 40% | 100% (0 wrong links) | **100%** | 10% | 52% | $0.057 |

**Prompt change (6580ccaf1d):** confirmation now means only "the application was received", and
interview_request includes confirming or rescheduling an interview. This fixed both misses, where an
interview confirmation and a follow-up had been read as confirmations. The cases are few and synthetic,
so treat 100% as "no known failures", not as a guarantee.

**Known gap: the pre-filter.** It drops job emails from senders the agent doesn't know yet: an offer or
interview email straight from a company domain that hasn't been learned (c06, c22, c35), assessment
vendors (c16), and cold recruiter outreach (c11, c30, c39). The domain gap closes over time, because
company domains are learned from matched emails. Cold outreach is by design: only threads you started,
known contacts, known company domains, and job-site domains get through.

## Scoring (`evals/score`)

Real applied and passed jobs from your history (data/evals/score, local only). The metric is pairwise
accuracy: how often an applied job outscores a passed one.

| Date | Model | Pairwise | Promoted at 7+ (applied / passed) |
|---|---|---|---|
| 2026-09-30 | claude-sonnet-5-5 (chosen) | 84% | 56% / 8% |
| 2026-09-30 | claude-haiku-4-5 | 72% | |
| 2026-09-30 | v1 stored scores | 71% | |
