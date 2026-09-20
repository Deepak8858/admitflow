import type { Workspace } from "./domain";

/** Millisecond instants only: explicit offset, real calendar, years 0001–9999.
 * PostgreSQL accepts numeric timezone offsets through 15:59. Extra fractional
 * digits are accepted only when zero, so no history is silently rounded. */
export function canonicalInstant(value: unknown): string {
  const invalid = () => new RangeError("Invalid instant: require a finite calendar date, explicit offset and millisecond precision.");
  if (typeof value !== "string") throw invalid();
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!parts) throw invalid();
  const [, year, month, day, hour, minute, second, fraction = "", , sign, offsetHour, offsetMinute] = parts;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || /[1-9]/.test(fraction.slice(3)) || (sign && (Number(offsetHour) > 15 || Number(offsetMinute) > 59))) throw invalid();
  const date = new Date(value), ms = date.getTime();
  if (!Number.isFinite(ms) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) throw invalid();
  return date.toISOString();
}

/** pg and PGlite can return either Date objects or PostgreSQL text output. */
export function driverInstant(value: string | Date): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new RangeError("Invalid database instant.");
    return canonicalInstant(value.toISOString());
  }
  return canonicalInstant(value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

/** Deliberate allowlist: never interpret customer metadata or arbitrary JSON keys. */
export const WORKSPACE_INSTANT_FIELDS = {
  leads: ["nextActionAt", "createdAt", "lastContactAt", "lastInboundAt", "consentAt"],
  messages: ["createdAt", "receivedAt", "statusAt", "dispatchedAt"],
  campaigns: ["createdAt"], jobs: ["dueAt", "lockedAt", "dispatchedAt"],
  appointments: ["startsAt"], revenue: ["recordedAt"], refunds: ["recordedAt"],
  articles: ["updatedAt"], activities: ["createdAt"], tasks: ["dueAt"],
  files: ["createdAt", "finalizedAt"], connections: ["updatedAt"],
} as const;

/** Validate all fields first, preserving nulls/IDs and reporting safe counts only. */
export function normalizeWorkspaceInstants(workspace: Workspace): Workspace {
  const changes: { row: Record<string, unknown>; key: string; value: string }[] = [];
  const invalid = new Map<string, number>();
  function visit(rows: unknown[], fields: readonly string[], label: string) {
    for (const item of rows) {
      const row = item as Record<string, unknown>;
      for (const key of fields) {
        if (row[key] === null || row[key] === undefined) continue;
        try { changes.push({ row, key, value: canonicalInstant(row[key]) }); }
        catch { const name = `${label}.${key}`; invalid.set(name, (invalid.get(name) || 0) + 1); }
      }
    }
  }
  for (const [name, fields] of Object.entries(WORKSPACE_INSTANT_FIELDS)) visit(workspace[name as keyof typeof WORKSPACE_INSTANT_FIELDS] || [], fields, name);
  if (workspace.subscription) visit([workspace.subscription], ["renewsAt", "verifiedAt", "currentPeriodEnd"], "subscription");
  if (workspace.trial) visit([workspace.trial], ["startedAt", "endsAt"], "trial");
  if (invalid.size) throw new RangeError(`Invalid instant counts: ${[...invalid].map(([key, count]) => `${key}=${count}`).join(", ")}.`);
  for (const { row, key, value } of changes) row[key] = value;
  return workspace;
}
