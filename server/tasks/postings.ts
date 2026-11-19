// The job panel's tasks and Add job (v3 Phase 7: moved here from server/app.ts, whose routes only enqueue them). Each
// handler reads the job again when it runs, as its user.
//
// Add job is two tasks: add, in the browser pool, checks for duplicates, reads the posting, and saves the job; then it
// queues add-score, in the Claude pool, as its child and follows it, so the Activity tab still shows one task with
// every step. The browser worker never needs the Claude key, and the browser is closed before the wait.
import { lookups } from '../../agents/lookups.ts';
import { savePosting, scoreAdded } from '../../agents/manual.ts';
import { scorePostings, DEFAULT_SCORE_MODEL } from '../../agents/discovery/score.ts';
import { generateForPostings } from '../../agents/hunt/generate.ts';
import { resolveDetails } from '../../agents/discovery/details.ts';
import { jobIdFromUrl } from '../../agents/discovery/sources/linkedin.ts';
import * as fractionaljobs from '../../agents/discovery/sources/fractionaljobs.ts';
import { isOnSite } from '../../tools/urls.ts';
import { checkLocation } from '../../tools/location.ts';
import { PROGRESS } from '../../tools/queue/queue.ts';
import type { Http } from '../../tools/http.ts';
import type { PostingsRow } from '../../db/types.ts';
import type { JobItem } from '../../agents/discovery/types.ts';
import type { AddedJob, ManualInput } from '../../agents/manual.ts';
import type { Runtime } from '../runtime.ts';

export function definePostingTasks({ store, config, services, jobs }: Runtime) {
  const { db } = store;
  const needClaude = () => {
    if (!services.claude) throw new Error('AI is not available here.');
    return services.claude;
  };
  const postingOf = async (id: number) => {
    const posting = (await db.prepare('SELECT * FROM postings WHERE id = ? AND user_id = @uid').get(id)) as PostingsRow | undefined;
    if (!posting) throw new Error('That job no longer exists.');
    return posting;
  };

  jobs.define<ManualInput>('add', async (input, { job, step, logger, signal, run, browser, closeBrowser }) => {
    // null only in the demo, which runs no tasks.
    const saved = await savePosting(input, { store, config, http: services.http as Http, browser, run: run ?? undefined, onStep: step });
    await closeBrowser();
    if (!saved.created) return saved;
    const payload: AddedJob = { id: saved.id, writeMaterials: Boolean(input.writeMaterials), pasted: saved.pasted, described: saved.described };
    let child: { id: string };
    try {
      child = await jobs.queue.enqueue('add-score', payload, { userId: job.userId, interactive: job.interactive, requestedBy: job.requestedBy, parentId: job.id });
    } catch (err) {
      throw new Error(`Saved as job #${saved.id}, but it could not be scored: ${(err as Error).message}`, { cause: err });
    }
    // The child's steps become this task's steps; its other lines, this task's output.
    const done = await jobs.follow(child.id, job.userId, {
      signal,
      everyMs: services.queueOptions?.pollMs,
      onLine: (l) => {
        if (l.level === 'step') step(l.text);
        else if (l.level === PROGRESS) step(l.text, { log: false });
        else if (l.level === 'warn') logger.warn(l.text);
        else if (l.level === 'error') logger.error(l.text);
        else logger.info(l.text);
      },
    });
    if (done?.status !== 'done') throw new Error(done?.error ?? `Saved as job #${saved.id}, but scoring did not finish.`);
    const r = (done.result ?? {}) as Awaited<ReturnType<typeof scoreAdded>>;
    return { id: saved.id, created: true, score: r.score, promoted: r.promoted, materials: r.materials };
  }, { browser: true });

  jobs.define<AddedJob>('add-score', async (added, { step, run }) => {
    await postingOf(added.id);
    return scoreAdded(added, { store, config, http: services.http as Http, claude: needClaude(), knowledge: await services.knowledge(), drive: services.drive, run: run ?? undefined, onStep: step });
  });

  jobs.define<{ id: number }>('score', async ({ id }, { step, run }) => {
    await postingOf(id);
    step('Scoring');
    const s = await scorePostings({ store, config, claude: needClaude(), knowledge: await services.knowledge(), model: DEFAULT_SCORE_MODEL, run: run as NonNullable<typeof run>, options: { ids: [id], rescore: true } });
    if (s.failures.length) throw new Error(s.failures[0].error);
    step(s.promoted.includes(id) ? 'Scored and moved to your pipeline' : 'Scored');
    return { scored: s.scored, promoted: s.promoted.includes(id) };
  });

  for (const action of ['write-materials', 'regenerate'] as const) {
    jobs.define<{ id: number }>(action, async ({ id }, { step, run: traced }) => {
      const run = traced as NonNullable<typeof traced>;
      const posting = await postingOf(id);
      const claude = needClaude();
      const lk = await lookups(db);
      if (lk.groupOf('stage', posting.stage) === 'found') await db.prepare('UPDATE postings SET stage = ?, updated_at = ? WHERE id = ? AND user_id = @uid').run(lk.role('stage', 'promote'), new Date().toISOString(), id);
      const hasScore = await db.prepare("SELECT 1 FROM scores WHERE posting_id = ? AND user_id = @uid AND source IN ('v2', 'v2-rule')").get(id);
      const knowledge = await services.knowledge();
      if (!hasScore) {
        step('Scoring first');
        await scorePostings({ store, config, claude, knowledge, model: DEFAULT_SCORE_MODEL, run, options: { ids: [id], rescore: true } });
      }
      step(action === 'regenerate' ? 'Writing new resume tweaks and cover letter' : 'Writing resume tweaks and cover letter');
      const g = await generateForPostings({ store, config, claude, knowledge, drive: services.drive, run, options: { ids: [id], regenerate: action === 'regenerate' } });
      if (g.failures.length) throw new Error(g.failures[0].error);
      step(g.docs ? 'Cover letter saved as a Google Doc' : 'Done');
      return { tweaks: g.tweaks, letters: g.letters, checked: g.checked, claimFlags: g.claimFlags, docs: g.docs, flagged: g.flagged };
    });
  }

  jobs.define<{ id: number }>('refetch', async ({ id }, { step, browser }) => {
    const posting = await postingOf(id);
    step('Fetching the posting text');
    // resolveDetails reads these and fills in the text and fetch fields.
    const item = { url: posting.url, title: posting.title, company: posting.company, location: posting.location, linkedinJobId: jobIdFromUrl(posting.url) } as JobItem;
    if (isOnSite(posting.url, 'fractionaljobs.io', '/jobs/')) item.fetchDetails = (h) => fractionaljobs.fetchPosting(h, posting.url as string); // on the site, so it has a url
    await resolveDetails(item, { http: services.http as Http, browser });
    const ok = item.fetchStatus === 'ok';
    await db.prepare(`UPDATE postings SET fetched_text = COALESCE(@text, fetched_text), fetched_at = CASE WHEN CAST(@text AS TEXT) IS NULL THEN fetched_at ELSE @now END,
        fetch_status = @status, fetch_method = @method, fetch_attempts = fetch_attempts + 1, location = COALESCE(location, @location),
        location_check = @check, updated_at = @now WHERE id = @id AND user_id = @uid`).run({
      id,
      text: ok ? item.description : null,
      status: item.fetchStatus,
      method: item.fetchMethod ?? null,
      location: item.location ?? null,
      check: checkLocation({ location: posting.location ?? item.location, workplace: posting.workplace ?? item.workplace, text: ok ? item.description : posting.fetched_text }, config.search.homeLocations),
      now: new Date().toISOString(),
    });
    step(ok ? 'Posting text updated' : `Could not read the posting (${item.fetchStatus}); paste the description instead`);
    return { fetchStatus: item.fetchStatus };
  }, { browser: true });
}
