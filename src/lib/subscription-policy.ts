import type { Workspace, Subscription, Job } from "./domain";
import { AppError } from "./errors";

export const TRIAL_MS = 7 * 86_400_000;
export const BILLING_FRESH_MS = 5 * 60_000;
export interface TrialGrant { startedAt: string | null; endsAt: string | null; consumed: boolean }
export type PaidCapability = "outbound" | "ai" | "enquiries" | "invitations" | "reactivations";
export interface CapabilitySummary {
  allowed: boolean; reason: "demo" | "local" | "trial" | "active" | "trial_expired" | "past_due" | "cancelled" | "verification_required" | "trial_unavailable";
  message: string; checkedAt: string; validUntil?: string;
}
type PolicyWorkspace = Pick<Workspace, "demo" | "subscription" | "trial">;
const time = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
export function subscriptionCapabilities(workspace: PolicyWorkspace, hosted: boolean, now = Date.now()): CapabilitySummary {
  const result = (allowed: boolean, reason: CapabilitySummary["reason"], message: string, until?: number): CapabilitySummary => ({ allowed, reason, message, checkedAt: new Date(now).toISOString(), ...(until !== undefined ? { validUntil: new Date(until).toISOString() } : {}) });
  if (workspace.demo) return result(true, "demo", "Demo workspace · no external delivery.");
  if (!hosted) return result(true, "local", "Local preview · hosted subscription restrictions do not apply.");
  const sub = workspace.subscription;
  if (sub?.status === "past_due" || ["pending", "halted", "paused"].includes(sub?.providerStatus || "")) return result(false, "past_due", "Subscription payment needs attention. Paid features are restricted immediately.");
  if (sub?.status === "cancelled" || ["cancelled", "completed", "expired"].includes(sub?.providerStatus || "")) return result(false, "cancelled", "This subscription has ended. Existing data and billing remain available.");
  if (sub?.providerId && sub.status === "active") {
    const verified = time(sub.verifiedAt), end = time(sub.currentPeriodEnd);
    if (sub.providerStatus === "active" && verified <= now && now < verified + BILLING_FRESH_MS && now < end) return result(true, "active", "Verified active subscription.", Math.min(end, verified + BILLING_FRESH_MS));
    return result(false, "verification_required", "Subscription verification is required before paid features can be used.");
  }
  if (sub?.status === "active") return result(false, "verification_required", "No verified provider subscription is linked.");
  const trial = workspace.trial, start = time(trial?.startedAt), end = time(trial?.endsAt);
  if (!trial || trial.consumed !== false || !Number.isFinite(start) || end - start !== TRIAL_MS || start > now) return result(false, "trial_unavailable", "No eligible trial remains. An administrator can manage Billing.");
  if (now >= end) return result(false, "trial_expired", "Your seven-day trial has ended. Subscribe to restore paid features.");
  return result(true, "trial", "Your institute's seven-day trial is active.", end);
}
export class SubscriptionRestricted extends AppError {
  constructor(public readonly policy: CapabilitySummary) { super(policy.message, policy.reason === "verification_required" ? 503 : 402, "SUBSCRIPTION_RESTRICTED"); }
}
export function assertCapability(workspace: PolicyWorkspace, hosted: boolean, now = Date.now()) {
  const policy = subscriptionCapabilities(workspace, hosted, now);
  if (!policy.allowed) throw new SubscriptionRestricted(policy);
}
export function jobCapability(job: Pick<Job, "kind">): PaidCapability | undefined {
  if (!job.kind || ["followup", "reminder"].includes(job.kind)) return "outbound";
  if (["ai.reply", "appointment.book", "knowledge.index"].includes(job.kind)) return "ai";
}
/** Shared UI affordance and server policy classification; authorization is separate. */
export function actionCapability(workspace: Workspace, action: Record<string, unknown>): PaidCapability | undefined {
  const type = action.type;
  if (type === "lead.create" || type === "lead.import" || type === "intake.import") return "enquiries";
  if (type === "message.send" || type === "campaign.create") return "outbound";
  if (type === "message.suggest") return "ai";
  if (type === "campaign.toggle" && workspace.campaigns.find(item => item.id === action.id)?.status === "paused") return "outbound";
  if (type === "sequence.save" && action.enabled === true) return "outbound";
  if (type === "ai.save" && (action.settings as { mode?: unknown } | undefined)?.mode !== "paused") return "ai";
  if (type === "lead.update" && (action.changes as { humanOwned?: unknown } | undefined)?.humanOwned === false) return "ai";
  if (type === "job.retry") { const job = workspace.jobs.find(item => item.id === action.id); if (job) return jobCapability(job); }
}
export function subscriptionNeedsRefresh(subscription?: Subscription, now = Date.now()) {
  if (!subscription?.providerId || subscription.status === "cancelled") return false;
  const verified = time(subscription.verifiedAt);
  return !Number.isFinite(verified) || verified > now || now >= verified + BILLING_FRESH_MS || (subscription.status === "active" && !(time(subscription.currentPeriodEnd) > now));
}
