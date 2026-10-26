// Screen layouts the owner arranges: today the Home page's tile order. Saved on the server (app_settings
// layout:<area>) so the order follows you to every device. The UI applies it with web/src/layout.js arranged().
import { getSetting, setSetting } from '../db/settings.js';

/** Each area's items in their default order. web/src/components/HomePage.jsx draws a tile for each home key. */
export const LAYOUT_AREAS = { home: ['jobs', 'inbox', 'funnel', 'activity', 'admin', 'add'] };

const key = (area) => `layout:${area}`;

/** The saved order for each area (null when never arranged), keeping only items the area still has. */
export function getLayout(db) {
  const out = {};
  for (const [area, items] of Object.entries(LAYOUT_AREAS)) {
    let saved = null;
    try {
      saved = JSON.parse(getSetting(db, key(area)) ?? 'null');
    } catch {
      saved = null;
    }
    out[area] = Array.isArray(saved) ? saved.filter((k) => items.includes(k)) : null;
  }
  return out;
}

export function registerLayoutRoutes(app, { db }) {
  for (const [area, items] of Object.entries(LAYOUT_AREAS)) {
    app.put(
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
        if (order.length) setSetting(db, key(area), JSON.stringify(order));
        else db.prepare('DELETE FROM app_settings WHERE key = ?').run(key(area));
        return { order: getLayout(db)[area] };
      },
    );
  }
}
