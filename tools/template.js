/**
 * Fills {{key}} placeholders. Uses split/join rather than replace() so values containing
 * "$" (like "$200k") stay intact. Throws if any placeholder is left unfilled, so a prompt
 * never reaches Claude with a literal {{name}} in it.
 */
export function fillTemplate(template, values) {
  let out = String(template);
  for (const [key, value] of Object.entries(values ?? {})) {
    out = out.split(`{{${key}}}`).join(value == null ? '' : String(value));
  }
  const left = out.match(/\{\{[A-Za-z0-9_]+\}\}/g);
  if (left) throw new Error(`Unfilled template placeholders: ${[...new Set(left)].join(', ')}`);
  return out;
}
