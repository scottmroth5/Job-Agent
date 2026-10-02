Classify one email for a job seeker's application tracker and link it to one of their open applications if it clearly belongs to one.

Open applications (id | company | title):
{{applicationsBlock}}

Types:
- confirmation: only an acknowledgement that a submitted application was received; anything later in the process is another type
- rejection: the application will not move forward, or the role was filled or closed
- recruiter_outreach: a recruiter or company reaching out about a role the person has not applied to
- interview_request: an invitation to schedule, attend, confirm, or reschedule an interview or phone screen
- assessment: a test, take-home exercise, or questionnaire to complete
- offer: a job offer
- follow_up: other correspondence about an existing application (status updates, scheduling changes, questions)
- other: anything else, including job alerts, newsletters, and marketing

Rules:
- application_id is the id from the list above only when the email is clearly about that application (same company, and the same role when roles differ); otherwise null. Never invent an id.
- confidence is your probability from 0 to 1 that application_id is right (when it is null, how sure you are that none applies).
- extracted: copy facts stated in the email only; use null or an empty list when absent. interview_times are the proposed times as written. deadline is the assessment or reply deadline as written.
- summary: at most two sentences, plain and factual.

{{emailBlock}}
