# Evals

Run before changing a model, prompt, schema, or threshold, and record the result here.
Both evals call Claude and cost money.

```
npm run evals                 inbox eval (synthetic cases, about $0.06)
npm run evals -- --all        also the scoring eval (your real cases, about $2)
npm run eval:inbox -- --verbose
npm run eval:score -- --models=claude-haiku-4-5,claude-sonnet-5-5 --max-usd=2
npm run eval:letters -- --models=claude-haiku-4-5,claude-sonnet-5-5 --max-usd=1
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

## Letter fact check (`evals/letters`)

16 synthetic letters (an invented candidate, companies, and postings): 12 with one planted error each (a wrong
title, employer, number, credential, or date) and 4 clean. The eval runs the production verifier and the prompt in
effect. A planted error counts as found when a contradicted or unsupported claim mentions it.

- **Recall:** the share of planted errors found.
- **Clean letters flagged:** clean letters with any contradicted or unsupported claim (the false flag rate).
- **Extra flags:** flagged claims, across all 16 letters, that are not the planted error.

| Date | Model | Prompt | Recall | Clean letters flagged | Extra flags | Cost per letter | Average time |
|---|---|---|---|---|---|---|---|
| 2026-11-03 | claude-haiku-4-5 (chosen) | 7a5c2f783d | 100% (12 of 12) | 1 of 4 (25%) | 1 | $0.0024 | 2.7 s |
| 2026-11-03 | claude-sonnet-5-5 | 7a5c2f783d | 100% (12 of 12) | 1 of 4 (25%) | 9 | $0.0062 | 3.2 s |

**Model choice:** Haiku 4.5. It found every planted error, as Sonnet did, but with one extra flag instead of nine,
at under half the cost. Most of Sonnet's extra flags were "Checkout and payments are where I started my career"
marked unsupported, a framing line rather than a fact. Real knowledge docs are longer than the synthetic one, so
expect about a cent a letter.

**Known false flag (both models): clean-orchard.** "I spent ten years at Bluebird Payments" is true (Senior
Software Engineer 2009 to 2015, then Engineering Manager 2015 to 2019), but both models compared it with one role
and called it contradicted. Tenure summed across roles at one employer is the known weak spot; Dismiss handles it in
the panel. A prompt change for it needs a new run. The cases are few and synthetic, so treat 100% as "no known
misses", not as a guarantee.
