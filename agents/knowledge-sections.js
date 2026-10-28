// The knowledge doc's sections: what each user writes about themselves in Settings, and what every score, letter,
// resume tweak, and meeting prep reads. The default prompts refer to sections by number (Section 5: Job Targets,
// Section 6: Cover Letter Rules), so the numbers and titles here are part of that contract: change them only with
// the prompts. The draft builder writes this structure, Settings checks for it, and Help teaches it.

export const KNOWLEDGE_SECTIONS = [
  { n: 1, title: 'Summary', hint: 'Your level, field, and years, and what you are known for, in three or four sentences.' },
  { n: 2, title: 'Experience', hint: 'Role by role, newest first: title, company or kind of company, years, and two to four results with numbers.' },
  { n: 3, title: 'Strengths', hint: 'What you do best, each with proof.' },
  { n: 4, title: 'Stories', hint: 'Two or three accomplishments you would tell in an interview: the situation, what you did, the result.' },
  {
    n: 5,
    title: 'Job Targets',
    hint: 'The roles, level, industries, company stage, places, and pay you want; what is not a fit; and how to position yourself for each kind of role. Scoring weighs this section most.',
  },
  { n: 6, title: 'Cover Letter Rules', hint: 'How letters and resume tweaks should sound: tone, length, words to avoid, and facts never to claim.' },
  { n: 7, title: 'Other', hint: 'Education, certifications, languages, and anything else useful.' },
];

/** The headings in the form the prompts name them: "## 5. Job Targets". */
export const sectionHeading = (s) => `## ${s.n}. ${s.title}`;

/** A blank knowledge doc to fill in: every heading with a line saying what goes there. */
export function knowledgeTemplate() {
  return KNOWLEDGE_SECTIONS.map((s) => `${sectionHeading(s)}\n[${s.hint}]`).join('\n\n');
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z]+/g, ' ').trim();

/**
 * Which sections a knowledge doc has, by heading: "## 5. Job Targets", "Section 5: Job Targets", or just "Job Targets"
 * on a line of its own. Returns [{ n, title, found }]; found is false for a section whose title never heads a line.
 */
export function sectionCheck(text) {
  const headings = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l.length <= 60)
    .map((l) => norm(l.replace(/^#+\s*/, '').replace(/^section\s*/i, '').replace(/^\d+\s*[.:)\-]?\s*/, '')));
  return KNOWLEDGE_SECTIONS.map((s) => ({ n: s.n, title: s.title, found: headings.includes(norm(s.title)) }));
}

/** The sections, as the draft builder's instructions list them. */
export function sectionsForInstructions() {
  return KNOWLEDGE_SECTIONS.map((s) => `   ${sectionHeading(s)} (${s.hint})`).join('\n');
}
