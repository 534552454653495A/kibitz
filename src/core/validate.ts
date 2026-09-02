/**
 * Runtime validation of UniversalMessage at trust boundaries.
 *
 * Why not just trust TypeScript: messages arrive from the MAIN world as JSON produced by
 * code that reads undocumented Discord internals. When Discord renames a field, the
 * normaliser may emit `author: { name: undefined }` and the UI would render "undefined"
 * instead of failing. The probe (probe/checks.ts) relies on ContractError.path to name
 * exactly which field died, which is what the fix agent needs.
 *
 * Hand-written instead of zod: ~60 lines, zero dependencies in the MAIN-world bundle.
 */
import type { UniversalMessage } from "./types";

export class ContractError extends Error {
  override readonly name = "ContractError";
  constructor(
    /** Dotted path of the offending field, e.g. "author.name". */
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}`);
  }
}

type Rec = Record<string, unknown>;

/** The project's one object guard. Import it; never redefine it at a call site. */
export function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(obj: Rec, key: string, path: string, opts: { optional?: boolean; nonEmpty?: boolean } = {}): void {
  const v = obj[key];
  if (v === undefined) {
    if (opts.optional) return;
    throw new ContractError(`${path}.${key}`, "missing");
  }
  if (typeof v !== "string") throw new ContractError(`${path}.${key}`, `expected string, got ${typeof v}`);
  if (opts.nonEmpty && v.length === 0) throw new ContractError(`${path}.${key}`, "empty");
}

function bool(obj: Rec, key: string, path: string): void {
  if (typeof obj[key] !== "boolean") throw new ContractError(`${path}.${key}`, "expected boolean");
}

function arr(obj: Rec, key: string, path: string): Rec[] {
  const v = obj[key];
  if (!Array.isArray(v)) throw new ContractError(`${path}.${key}`, "expected array");
  v.forEach((item, i) => {
    if (!isRecord(item)) throw new ContractError(`${path}.${key}[${i}]`, "expected object");
  });
  return v as Rec[];
}

const SNOWFLAKE = /^\d{15,22}$/;

export function assertUniversalMessage(value: unknown, path = "message"): asserts value is UniversalMessage {
  if (!isRecord(value)) throw new ContractError(path, "expected object");
  str(value, "platform", path, { nonEmpty: true });
  str(value, "id", path, { nonEmpty: true });
  str(value, "content", path);
  str(value, "createdAt", path, { nonEmpty: true });
  if (Number.isNaN(Date.parse(value.createdAt as string))) {
    throw new ContractError(`${path}.createdAt`, `not an ISO date: ${String(value.createdAt)}`);
  }
  str(value, "editedAt", path, { optional: true });
  str(value, "permalink", path, { optional: true });
  bool(value, "isSystem", path);

  if (!isRecord(value.channel)) throw new ContractError(`${path}.channel`, "expected object");
  str(value.channel, "id", `${path}.channel`, { nonEmpty: true });
  str(value.channel, "name", `${path}.channel`, { optional: true });
  str(value.channel, "guildId", `${path}.channel`, { optional: true });

  if (!isRecord(value.author)) throw new ContractError(`${path}.author`, "expected object");
  str(value.author, "id", `${path}.author`, { nonEmpty: true });
  str(value.author, "name", `${path}.author`, { nonEmpty: true });
  str(value.author, "handle", `${path}.author`, { optional: true });
  bool(value.author, "isBot", `${path}.author`);

  if (value.replyTo !== undefined) {
    if (!isRecord(value.replyTo)) throw new ContractError(`${path}.replyTo`, "expected object");
    str(value.replyTo, "messageId", `${path}.replyTo`, { nonEmpty: true });
  }

  arr(value, "attachments", path).forEach((a, i) => {
    const p = `${path}.attachments[${i}]`;
    str(a, "id", p, { nonEmpty: true });
    str(a, "kind", p, { nonEmpty: true });
    str(a, "name", p);
    str(a, "url", p, { nonEmpty: true });
  });
  arr(value, "embeds", path).forEach((e, i) => {
    const p = `${path}.embeds[${i}]`;
    str(e, "title", p, { optional: true });
    str(e, "description", p, { optional: true });
    arr(e, "fields", p);
  });
  arr(value, "reactions", path).forEach((r, i) => {
    const p = `${path}.reactions[${i}]`;
    str(r, "emoji", p, { nonEmpty: true });
    if (typeof r.count !== "number") throw new ContractError(`${p}.count`, "expected number");
  });
  arr(value, "mentions", path).forEach((m, i) => {
    const p = `${path}.mentions[${i}]`;
    str(m, "id", p, { nonEmpty: true });
    str(m, "name", p, { nonEmpty: true });
  });
}

/** Platform ids are numeric snowflakes on Discord; other platforms may relax this per adapter. */
export function isSnowflake(value: string): boolean {
  return SNOWFLAKE.test(value);
}
