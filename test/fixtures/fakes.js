// Typed stand-ins for tests: each returns what it is given, typed as the real thing, so a test can pass only the
// parts the code under test reads (a config with just homeLocations, services with just createBrowser). They change
// nothing at run time; they only tell the type checker that a partial value is meant.
/** @import { AppServices } from '../../server/app.ts' */
/** @import { UserConfig } from '../../agents/user-config.ts' */
/** @import { Claude, SendOptions, SendResult } from '@scottmroth5/agent-core' */
/** @import { Http } from '../../tools/http.ts' */
/** @import { JobItem } from '../../agents/discovery/types.ts' */

/**
 * Every field optional, at any depth; functions stay as they are.
 * @template T
 * @typedef {T extends (...args: never[]) => unknown ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T} DeepPartial
 */

/**
 * A config with only the fields a test needs.
 * @param {DeepPartial<UserConfig>} config
 * @returns {UserConfig}
 */
export const fakeConfig = (config) => /** @type {UserConfig} */ (config);

/**
 * buildApp's services with only the ones a test needs.
 * @param {DeepPartial<AppServices>} services
 * @returns {AppServices}
 */
export const fakeServices = (services) => /** @type {AppServices} */ (services);

/**
 * A Claude client whose send answers with only the result fields a test needs.
 * @param {(opts: SendOptions) => Promise<Partial<SendResult>>} send
 * @returns {Claude}
 */
export const fakeClaude = (send) => /** @type {Claude} */ ({ send });

/**
 * What a fake email sender receives (server/notices.ts and server/alerts.ts send this shape).
 * @typedef {{ to: string; subject: string; text: string; replyTo?: string }} SentEmail
 */

/**
 * One object from a JSON response, in a callback over res.json() (which is untyped): its fields are unknown, and the
 * asserts compare them as they are. A test that needs a field's type gives that type instead.
 * @typedef {Record<string, unknown>} JsonRow
 */

/**
 * An http client with only the calls a test answers (get, sleep, ...).
 * @param {Partial<Http>} http
 * @returns {Http}
 */
export const fakeHttp = (http) => /** @type {Http} */ (http);

/**
 * A found job with only the fields a test sets; the code fills the rest as it would for a real one.
 * @param {Partial<JobItem>} item
 * @returns {JobItem}
 */
export const fakeItem = (item) => /** @type {JobItem} */ (item);
