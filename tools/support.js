// The address people write to for help with the app (SUPPORT_EMAIL in .env; the server and the demo both read it).
// It is shown on Settings, Help, the sign-in pages, the demo banner, and in the privacy policy and terms. Unset, those
// places point to Send feedback (or, before sign-in, say to contact whoever runs the app) instead.

/** The support address, or null when unset or not a plain address. */
export function supportEmail(env = process.env) {
  const v = String(env.SUPPORT_EMAIL ?? '').trim();
  return /^[^@\s<>"(),;:]+@[^@\s<>"(),;:]+\.[^@\s<>"(),;:]+$/.test(v) ? v : null;
}

/** Markdown with {{supportContact}} filled in: a mailto link, or the fallback words. */
export function withSupport(markdown, email = supportEmail(), fallback = 'contact the person who runs this app') {
  return String(markdown).replaceAll('{{supportContact}}', email ? `email [${email}](mailto:${email})` : fallback);
}
