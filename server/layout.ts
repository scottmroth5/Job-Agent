// Screen layouts each user arranges: today the Home page's tile order. Saved on the server (user_settings
// layout:<area>) so the order follows you to every device. The UI applies it with web/src/layout.js arranged().
import { deleteUserSetting, getUserSetting, setUserSetting } from '../db/settings.ts';
import type { Database } from '../tools/types.ts';
import type { App } from './types.ts';

/** Each area's items in their default order. web/src/components/HomePage.jsx draws a tile for each home key. */
export const LAYOUT_AREAS: Record<string, string[]> = { home: ['jobs', 'inbox', 'funnel', 'activity', 'admin', 'settings', 'help', 'add'] };

const key = (area: string) => `layout:${area}`;

/** The saved order for each area (null when never arranged), keeping only items the area still has. */
export function getLayout(db: Database) {
  const out: Record<string, string[] | null> = {};
  for (const [area, items] of Object.entries(LAYOUT_AREAS)) {
    let saved = null;
    try {
      saved = JSON.parse(getUserSetting(db, key(area)) ?? 'null');
    } catch {
      saved = null;
    }
    out[area] = Array.isArray(saved) ? (saved as string[]).filter((k) => items.includes(k)) : null;
  }
  return out;
}

export function registerLayoutRoutes(app: App, { db }: { db: Database }) {
  for (const [area, items] of Object.entries(LAYOUT_AREAS)) {
    app.put<{ Body: { order: string[] } }>(
      `/api/layout/${area}`,
      {
        schema: {
          summary: `Save the ${area} page's order (an empty list goes back to the default)`,
          body: {
            type: 'object',
            required: ['order'],
            additionalProperties: false,
            properties: { order: { type: 'array', uniqueItems: true, maxItems: items.length, items: { type: 'string', enum: items } } },
          },
          response: { 200: { type: 'object', properties: { order: { type: ['array', 'null'], items: { type: 'string' } } } } },
        },
      },
      async (req) => {
        const { order } = req.body;
        if (order.length) setUserSetting(db, key(area), JSON.stringify(order));
        else deleteUserSetting(db, key(area));
        return { order: getLayout(db)[area] };
      },
    );
  }
}
