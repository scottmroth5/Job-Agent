// Types for @scottmroth5/agent-core 0.2.3, which ships plain JavaScript. Written from its source and JSDoc
// (src/claude.js, trace.js, store.js); keep in step when the dependency is upgraded. Publishing these from
// Agent-Core itself is a separate, approved release (v3 Phase 2).
declare module '@scottmroth5/agent-core' {
  import type { Database } from 'better-sqlite3';

  export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    webSearches: number;
  }

  export interface SendOptions {
    /** Exact model ID; agent-core never picks one. */
    model: string;
    maxTokens: number;
    /** Sent as one cached text block. */
    system?: string;
    /** A single user message; use this or messages. */
    prompt?: string;
    messages?: unknown[];
    /** JSON Schema; the response is constrained to it and parsed into data. Null or absent: plain text. */
    schema?: object | null;
    thinking?: object;
    effort?: string;
    tools?: unknown[];
    stream?: boolean;
    betas?: string[];
    fallbacks?: unknown;
    maxContinuations?: number;
    /** A run from createTracer().startRun(). */
    trace?: Run | null;
    label?: string;
  }

  export interface SendResult {
    text: string;
    content: unknown[];
    /** Parsed JSON when a schema was given, else null. The schema, not this type, decides its shape. */
    data: any;
    stopReason: string;
    usage: Usage;
    /** Null when the model has no pricing entry. */
    costUsd: number | null;
    model: string;
    id: string;
  }

  export interface Claude {
    send(opts: SendOptions): Promise<SendResult>;
  }

  export function createClaude(options?: { apiKey?: string; client?: object; maxRetries?: number; timeoutMs?: number }): Claude;

  export class ClaudeTruncatedError extends Error {
    constructor(result: SendResult);
    result: SendResult;
  }

  export class ClaudeRefusalError extends Error {
    constructor(result: SendResult, stopDetails?: object | null);
    result: SendResult;
    stopDetails: object | null;
  }

  export interface CallInfo {
    label: string | null;
    model: string;
    stopReason: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number | null;
    durationMs: number;
    error: { name: string; message: string } | null;
  }

  export interface Totals {
    status: string;
    calls: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Sum over calls with a known price. */
    costUsd: number;
    unpricedCalls: number;
    durationMs: number;
  }

  export interface Run {
    /** runs.id when persisted. */
    id: number | null;
    recordCall(info: CallInfo): void;
    log(level: 'info' | 'warn' | 'error', msg: string, fields?: object): void;
    /** Idempotent; later calls return the first totals. */
    finish(status?: string, summary?: object | null): Totals;
  }

  export interface Logger {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
  }

  export function createTracer(options?: { store?: { db: Database }; logger?: Logger }): {
    startRun(name: string, meta?: object): Run;
  };

  export interface Migration {
    id: string;
    up: string | ((db: Database) => void);
    foreignKeys?: boolean;
  }

  export interface Store {
    db: Database;
    tx<T>(fn: () => T): T;
    close(): void;
  }

  export function openStore(path: string, options?: { app?: string; migrations?: Migration[] }): Store;
}
