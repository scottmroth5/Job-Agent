// Job sites to skip (Settings, and Skip this site in the job panel): each user's own list with a note per site
// (agents/excluded-sites.ts). The owner's settings file can list sites too; those show here as from the file and are
// changed there. Skipping a site affects jobs found from then on; the saved ones from it are removed only when asked
// (POST .../remove-jobs), and never a job already applied to.
import { OWNER_ID } from '../db/users.ts';
import { addExcludedSite, excludedSites, removeExcludedSite, setExcludedSiteNote, MAX_NOTE } from '../agents/excluded-sites.ts';
import { clearConfigViews, userConfig } from '../agents/user-config.ts';
import { archiveSiteJobs, findListings } from '../agents/hunt/archive.ts';
import { excludedSite } from '../tools/listings.ts';
import type { Database } from '../tools/types.ts';
import type { JobSearchConfig } from '../tools/config.ts';
import type { App, FastifyRequest } from './types.ts';

const anyObject = { type: 'object', additionalProperties: true };
const siteParams = { type: 'object', required: ['site'], properties: { site: { type: 'string', minLength: 3, maxLength: 253, pattern: '^[a-z0-9.-]+$' } } };

export function registerExcludedSiteRoutes(app: App, { db, ownerConfig = null }: { db: Database; ownerConfig?: JobSearchConfig | null }) {
  const uidOf = (req: FastifyRequest) => req.uid ?? OWNER_ID;
  // Sites someone other than the owner listed in their saved search before this list existed (moved in on first change).
  const legacyFor = (uid: number) => (uid === OWNER_ID ? [] : userConfig(db, uid).search.excludedSites ?? []);
  const opts = (uid: number) => ({ legacy: legacyFor(uid) });
  const view = async (uid: number) => {
    const fromFile = uid === OWNER_ID ? ownerConfig?.search?.excludedSites ?? [] : [];
    const sites = excludedSites(db, uid, opts(uid));
    // One pass over the saved jobs: how many cleanup would still remove for each site.
    const counts = new Map<string, number>();
    for (const p of await findListings(db, { search: { excludedSites: [...sites.map((s) => s.site), ...fromFile] } })) {
      const site = excludedSite(p.url, [...sites.map((s) => s.site), ...fromFile]);
      if (site && p.reason.startsWith('excluded site')) counts.set(site, (counts.get(site) ?? 0) + 1);
    }
    return {
      sites: sites.map((s) => ({ ...s, savedJobs: counts.get(s.site) ?? 0 })),
      fromFile: fromFile.map((site) => ({ site, savedJobs: counts.get(site) ?? 0 })),
    };
  };
  const changed = async (uid: number) => {
    clearConfigViews();
    return await view(uid);
  };

  app.get('/api/excluded-sites', { schema: { summary: 'The job sites you skip, with your notes and how many saved jobs each still has', response: { 200: anyObject } } }, async (req) => await view(uidOf(req)));

  app.post<{ Body: { site: string; note?: string } }>(
    '/api/excluded-sites',
    {
      schema: {
        summary: 'Skip a job site (a domain or a link to a job on it), with an optional note; updates the note when it is already listed',
        body: { type: 'object', required: ['site'], additionalProperties: false, properties: { site: { type: 'string', maxLength: 300 }, note: { type: 'string', maxLength: MAX_NOTE } } },
        response: { 201: anyObject },
      },
    },
    async (req, reply) => {
      const uid = uidOf(req);
      const { site } = addExcludedSite(db, uid, req.body, opts(uid));
      return reply.code(201).send({ site, ...await changed(uid) });
    },
  );

  app.patch<{ Params: { site: string }; Body: { note: string } }>(
    '/api/excluded-sites/:site',
    { schema: { summary: "Change a skipped site's note", params: siteParams, body: { type: 'object', required: ['note'], additionalProperties: false, properties: { note: { type: 'string', maxLength: MAX_NOTE } } }, response: { 200: anyObject } } },
    async (req) => {
      const uid = uidOf(req);
      setExcludedSiteNote(db, uid, req.params.site, req.body.note, opts(uid));
      return await changed(uid);
    },
  );

  app.delete<{ Params: { site: string } }>('/api/excluded-sites/:site', { schema: { summary: 'Stop skipping a job site (its jobs are found again from the next run)', params: siteParams, response: { 200: anyObject } } }, async (req) => {
    const uid = uidOf(req);
    removeExcludedSite(db, uid, req.params.site, opts(uid));
    return await changed(uid);
  });

  app.post<{ Params: { site: string } }>(
    '/api/excluded-sites/:site/remove-jobs',
    { schema: { summary: "Remove your saved jobs from a skipped site (archived and marked passed; jobs you applied to are kept)", params: siteParams, response: { 200: anyObject } } },
    async (req, reply) => {
      const uid = uidOf(req);
      const fromFile = uid === OWNER_ID ? ownerConfig?.search?.excludedSites ?? [] : [];
      const listed = excludedSites(db, uid, opts(uid)).some((s) => s.site === req.params.site) || fromFile.includes(req.params.site);
      if (!listed) return reply.code(404).send({ error: 'Skip the site first.' });
      const { archived } = await archiveSiteJobs(db, req.params.site);
      return { removed: archived.length, ...await view(uid) };
    },
  );
}
