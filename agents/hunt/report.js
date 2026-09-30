// The one report email per run (replaces v1's discovery report and daily summary).
// collectReport() reads the database; renderReport() is pure. Every value is HTML-escaped.
import { escapeHtml as e } from '../../tools/html.js';
import { sendEmail } from '../../tools/google/gmail.js';
import { PROMOTE_AT } from '../discovery/score.js';

const parse = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

/** Gathers everything the report shows for runs started at or after `since` (ISO timestamp). */
export function collectReport(db, { since, promoteAt = PROMOTE_AT }) {
  const runs = db
    .prepare('SELECT id, name, status, cost_usd, calls, summary, started_at FROM runs WHERE started_at >= ? ORDER BY id')
    .all(since)
    .map((r) => ({ ...r, summary: parse(r.summary) }));
  const latest = (name) => [...runs].reverse().find((r) => r.name === name) ?? null;

  const latestScore = `(SELECT %s FROM scores s WHERE s.posting_id = p.id AND s.source IN ('v2', 'v2-rule', 'v1-analysis') ORDER BY s.id DESC LIMIT 1)`;
  const letter = `(SELECT %s FROM artifacts a WHERE a.posting_id = p.id AND a.kind = 'cover_letter' ORDER BY a.id DESC LIMIT 1)`;
  const cols = `p.id, p.company, p.title, p.location, p.url, p.status, p.stage,
      ${latestScore.replace('%s', 'score')} AS score, ${latestScore.replace('%s', 'reason')} AS reason,
      ${latestScore.replace('%s', 'analysis_json')} AS analysis_json,
      ${letter.replace('%s', 'doc_url')} AS letter_url, ${letter.replace('%s', 'flags_json')} AS letter_flags,
      ${letter.replace('%s', 'id')} AS letter_id,
      EXISTS (SELECT 1 FROM artifacts a WHERE a.posting_id = p.id AND a.kind = 'resume_tweaks') AS has_tweaks`;

  const promoted = db
    .prepare(`SELECT ${cols} FROM postings p WHERE p.stage = 'pipeline'
      AND EXISTS (SELECT 1 FROM scores s WHERE s.posting_id = p.id AND s.source = 'v2' AND s.score >= ? AND s.created_at >= ?)
      ORDER BY score DESC, p.id`)
    .all(promoteAt, since)
    .map((p) => ({ ...p, analysis: parse(p.analysis_json), flags: parse(p.letter_flags) ?? [] }));

  const pipeline = db
    .prepare(`SELECT ${cols} FROM postings p WHERE p.stage = 'pipeline' ORDER BY
      CASE p.status WHEN 'offer' THEN 0 WHEN 'interviewing' THEN 1 WHEN 'applied' THEN 2 WHEN 'new' THEN 3 ELSE 4 END, score DESC, p.id`)
    .all()
    .map((p) => ({ ...p, flags: parse(p.letter_flags) ?? [] }));

  const statusCounts = Object.fromEntries(
    db.prepare("SELECT status, COUNT(*) AS n FROM postings WHERE stage = 'pipeline' GROUP BY status").all().map((r) => [r.status, r.n]),
  );
  return {
    since,
    runs,
    discover: latest('discover')?.summary ?? null,
    score: latest('score')?.summary ?? null,
    hunt: latest('hunt')?.summary ?? null,
    archive: latest('archive')?.summary ?? null,
    costUsd: runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0),
    failedSteps: runs.filter((r) => ['failed', 'aborted'].includes(r.status)).map((r) => r.name),
    promoted,
    pipeline,
    statusCounts,
  };
}

const colors = { head: '#1a5276', muted: '#666', good: '#1e8449', warn: '#b9770e', bad: '#c0392b', border: '#e0e0e0' };
const scoreColor = (s) => (s >= 8 ? colors.good : s >= 7 ? '#27ae60' : s >= 5 ? colors.warn : colors.bad);
const section = (title, body) =>
  `<div style="padding:16px 24px;border:1px solid ${colors.border};border-top:none;">` +
  `<h2 style="color:${colors.head};font-size:16px;margin:0 0 10px;">${e(title)}</h2>${body}</div>`;
const link = (url, text) => (url ? `<a href="${e(url)}" style="color:${colors.head};">${e(text)}</a>` : e(text));

/** Renders the report. Returns { subject, html, text } where text is a short plain summary. */
export function renderReport(data, { now = new Date(), promoteAt = PROMOTE_AT } = {}) {
  const dateText = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const newCount = data.discover?.inserted ?? 0;
  const parts = [];

  parts.push(
    `<div style="background:${colors.head};padding:18px 24px;color:#fff;border-radius:6px 6px 0 0;">` +
      `<div style="font-size:20px;font-weight:bold;">Job Agent report</div>` +
      `<div style="font-size:13px;opacity:.85;">${e(dateText)} &middot; run cost $${data.costUsd.toFixed(2)}</div></div>`,
  );

  if (data.failedSteps.length) {
    parts.push(section('Needs attention', `<p style="color:${colors.bad};margin:0;">These steps failed: ${e(data.failedSteps.join(', '))}. Check the run log.</p>`));
  }

  if (data.discover) {
    const d = data.discover;
    const bySource = Object.entries(d.bySource ?? {})
      .map(([s, v]) => `${e(s)}: ${v.new ?? 0} new`)
      .join(' &middot; ');
    const loc = Object.entries(d.locationChecks ?? {}).map(([k, v]) => `${e(k)} ${v}`).join(', ');
    const dist = data.score?.distribution
      ? Object.entries(data.score.distribution).sort(([a], [b]) => b - a).map(([s, n]) => `${e(s)}: ${n}`).join(' &middot; ')
      : 'not scored yet';
    parts.push(section(`${newCount} new postings`, `<p style="margin:0 0 6px;">${bySource || 'No sources ran.'}</p>` +
      `<p style="margin:0 0 6px;color:${colors.muted};">Location: ${loc || 'n/a'}</p>` +
      `<p style="margin:0;color:${colors.muted};">Scores: ${dist}</p>`));
  }

  if (data.promoted.length) {
    const cards = data.promoted
      .map((p) => {
        const letterBit = p.letter_url
          ? link(p.letter_url, 'Cover letter') + (p.flags.length ? ` <span style="color:${colors.bad};">needs review: ${e(p.flags.join('; '))}</span>` : '')
          : p.letter_id
            ? `<span style="color:${colors.warn};">Cover letter written; Doc not saved yet</span>`
            : `<span style="color:${colors.muted};">Cover letter pending</span>`;
        return (
          `<div style="border:1px solid ${colors.border};border-radius:4px;margin:0 0 12px;padding:10px 12px;">` +
          `<div><span style="background:${scoreColor(p.score)};color:#fff;border-radius:10px;padding:1px 8px;font-size:12px;">${e(p.score)} of 10</span> ` +
          `<b>${link(p.url, p.title)}</b> at ${e(p.company)}</div>` +
          `<div style="font-size:12px;color:${colors.muted};margin:4px 0;">${e(p.location ?? 'Location not specified')}</div>` +
          `<div style="font-size:13px;margin:4px 0;">${e(p.reason ?? '')}</div>` +
          (p.analysis?.topTalkingPoint ? `<div style="font-size:13px;margin:4px 0;"><b>Lead with:</b> ${e(p.analysis.topTalkingPoint)}</div>` : '') +
          `<div style="font-size:13px;margin-top:6px;">${letterBit}${p.has_tweaks ? ' &middot; Resume tweaks ready' : ''}</div></div>`
        );
      })
      .join('');
    parts.push(section(`${data.promoted.length} promoted to your pipeline (score ${promoteAt}+)`, cards));
  }

  const counts = ['offer', 'interviewing', 'applied', 'new']
    .filter((s) => data.statusCounts[s])
    .map((s) => `${e(s)}: <b>${data.statusCounts[s]}</b>`)
    .join(' &middot; ');
  const rows = data.pipeline
    .map(
      (p) =>
        `<tr><td style="padding:4px 8px 4px 0;">${link(p.url, p.company)}</td><td style="padding:4px 8px 4px 0;">${e(p.title)}</td>` +
        `<td style="padding:4px 8px 4px 0;color:${p.score != null ? scoreColor(p.score) : colors.muted};">${p.score ?? '-'}</td>` +
        `<td style="padding:4px 8px 4px 0;">${e(p.status)}</td>` +
        `<td style="padding:4px 0;font-size:12px;">${p.letter_url ? (p.flags.length ? `<span style="color:${colors.bad};">letter needs review</span>` : link(p.letter_url, 'letter')) : ''}</td></tr>`,
    )
    .join('');
  parts.push(
    section(
      `Pipeline: ${data.pipeline.length} active`,
      `<p style="margin:0 0 8px;">${counts || 'Empty.'}</p>` +
        (rows ? `<table style="border-collapse:collapse;font-size:13px;width:100%;">${rows}</table>` : ''),
    ),
  );
  if (data.archive?.archived?.length) {
    parts.push(section('Archived', `<p style="margin:0;color:${colors.muted};">${data.archive.archived.length} jobs moved out of the pipeline.</p>`));
  }

  const promotedCount = data.promoted.length;
  const subject = `Job Agent: ${newCount} new, ${promotedCount} promoted | ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  const html = `<div style="max-width:700px;margin:0 auto;font-family:Arial,sans-serif;color:#222;">${parts.join('')}</div>`;
  const text = `${newCount} new postings, ${promotedCount} promoted, ${data.pipeline.length} in pipeline, cost $${data.costUsd.toFixed(2)}`;
  return { subject, html, text };
}

/** Collects, renders and sends the report to `to`. Returns { subject, text, messageId }. */
export async function sendReport({ db, auth, to, since, now = new Date() }) {
  const report = renderReport(collectReport(db, { since }), { now });
  const messageId = await sendEmail(auth, { to, subject: report.subject, html: report.html });
  return { subject: report.subject, text: report.text, messageId };
}
