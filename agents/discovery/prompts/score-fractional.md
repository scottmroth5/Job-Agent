Assess how well this fractional engagement fits {{candidateName}}, using the Candidate Knowledge in your instructions (especially Section 5: Job Targets). Weigh how closely the responsibilities match their actual history, not just the title. Use only facts from the Candidate Knowledge; never invent experience. Follow the Section 6 rules for any phrasing about their history.

Fractional roles are part-time engagements the candidate stacks together. The target is {{stackingTarget}} per year across engagements, so judge pay, weekly hours, and whether the engagement can run alongside others, in addition to role fit.

Fit key (use the candidate's strongest areas from the Candidate Knowledge):
- High: strong match to the candidate's core domain and leadership strengths.
- Medium: solid but partial match.
- Stretch: adjacent domain, or a role the candidate could do but that is not a natural fit.
- Poor: little overlap, or a deal breaker (location, pay far below target, hands-on skills the candidate lacks).

{{locationNoteBlock}}Location rules:
1. The candidate's location requirement is remote, or based in {{homeLocations}}. If the location is a specific place that conflicts with that and the posting gives no sign the role can be remote, score no higher than 2 and set locationConcern to "conflict".
2. If the location contains the word "unconfirmed", the real location could not be extracted. Score no higher than 7, set locationConcern to "unverified", and say in the reason that the posting should be checked before applying.
3. Otherwise, score on fit and terms alone and set locationConcern to "none".

Company: {{company}}
Role: {{roleTitle}}
Location: {{jobLocation}}
URL: {{jobUrl}}
{{termsBlock}}
{{jobContentBlock}}Field guidance:
- score: whole number from 1 to 10.
- fit: High, Medium, Stretch, or Poor, using the fit key above.
- reason: one sentence explaining the score.
- whyItFits: two or three sentences tying the engagement's needs to specific parts of the candidate's history.
- caveats: one sentence on the main risks (pay not posted, pre-product, domain mismatch, may be closed, scope unclear). Empty if none.
- rate: pay as stated in the posting (min, max, unit). Use null values and unit "unknown" when the posting does not say; do not estimate.
- hoursPerWeek: weekly hours as stated (min, max). Use null values when the posting does not say.
- roleType: from the posting content or title.
- strengths: up to three specific strengths, each tied to a stated requirement.
- watchOuts: one or two real gaps or risks.
- topTalkingPoint: the single most compelling angle to lead with for this engagement.
- suggestedStatus: "worth_pursuing" or "pass".

Be specific to this posting and reference its actual requirements. No generic advice. Do not use dashes of any kind in any field.
