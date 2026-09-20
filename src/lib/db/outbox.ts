import { Queue } from "bullmq";
import { asc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { database } from "./client";
import { organizationRoutes } from "./schema";
import { loadWorkspace, mutateWorkspace } from "../store";
import { processJob, recoverWorkspaceJobs, JOB_LOCK_MS } from "../integrations";
import { assert, safeErrorDiagnostic } from "../errors";
import type { Workspace } from "../domain";

export const QUEUE_NAME = "admitflow";
export function queueConnection() {
  assert(process.env.DATABASE_URL && process.env.REDIS_URL, "The outbox dispatcher requires DATABASE_URL and REDIS_URL.", 503);
  const url = new URL(process.env.REDIS_URL);
  assert(["redis:", "rediss:"].includes(url.protocol) && url.hostname, "Use a redis:// or rediss:// queue URL.", 503);
  return { host: url.hostname, port: Number(url.port || 6379), username: url.username ? decodeURIComponent(url.username) : undefined, password: url.password ? decodeURIComponent(url.password) : undefined, db: Number(url.pathname.slice(1) || 0), maxRetriesPerRequest: null, ...(url.protocol === "rediss:" ? { tls: {} } : {}) };
}
export function workQueue() {
  const queue = new Queue(QUEUE_NAME, { connection: { ...queueConnection(), maxRetriesPerRequest: 2 } });
  queue.on("error", error => console.error("Outbox queue connection error", safeErrorDiagnostic(error)));
  return queue;
}

export async function enqueueWorkspaceJobs(queue: Pick<Queue, "getJob" | "add">, workspace: Workspace) {
  if (workspace.demo) return 0;
  let enqueued = 0;
  for (const job of workspace.jobs.filter(item => item.status === "pending" && Date.parse(item.dueAt) <= Date.now()).slice(0, 100)) {
    const jobId = `${workspace.id}-${job.id}-${job.retryGeneration || 0}-${job.attempts || 0}`;
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (!["failed", "completed"].includes(state)) continue;
      // BullMQ keeps failed IDs. add() alone silently returns the old failed job.
      // Only remove terminal queue entries; never steal an active worker lock.
      await existing.remove();
    }
    await queue.add("execute", { workspaceId: workspace.id, jobId: job.id }, { jobId, attempts: 1, removeOnComplete: true, removeOnFail: { count: 1000 } });
    enqueued++;
  }
  return enqueued;
}
function needsRecovery(workspace: Workspace) {
  return workspace.jobs.some(job => (job.status === "processing" && (!job.lockedAt || !Number.isFinite(Date.parse(job.lockedAt)) || Date.now() - Date.parse(job.lockedAt) >= JOB_LOCK_MS)) || (["accepted", "sent", "demo"].includes(job.status) && job.kind === "ai.reply" && job.payload?.replyPlan && job.payload.planApplied !== "true"))
    || workspace.messages.some(message => message.status === "queued" && Date.now() - Date.parse(message.createdAt) >= JOB_LOCK_MS);
}
/** Routing registry IDs are trusted server state; no caller-selected tenant. */
export async function dispatchOutbox(queue: Pick<Queue, "getJob" | "add">) {
  let after: string | undefined, organizations = 0, enqueued = 0, failed = 0;
  do {
    const routes = await database().select().from(organizationRoutes).where(after ? gt(organizationRoutes.organizationId, after) : undefined).orderBy(asc(organizationRoutes.organizationId)).limit(100);
    if (!routes.length) break;
    for (const route of routes) {
      if (!route.workosId) continue;
      let stage: "load" | "recover" | "enqueue" = "load";
      try {
        let workspace = await loadWorkspace(route.organizationId);
        if (workspace.demo || workspace.workosOrganizationId !== route.workosId) continue;
        stage = "recover";
        if (needsRecovery(workspace)) workspace = (await mutateWorkspace(workspace.id, current => recoverWorkspaceJobs(current))).workspace;
        stage = "enqueue";
        enqueued += await enqueueWorkspaceJobs(queue, workspace); organizations++;
      } catch (error) {
        failed++;
        console.error("Outbox tenant dispatch failed", { organizationId: route.organizationId, stage, ...safeErrorDiagnostic(error) });
      }
    }
    after = routes.at(-1)!.organizationId;
    if (routes.length < 100) break;
  } while (after);
  return { organizations, enqueued, failed };
}
export async function runQueuedJob(data: unknown) {
  const input = z.object({ workspaceId: z.uuid(), jobId: z.uuid() }).parse(data);
  const [route] = await database().select().from(organizationRoutes).where(eq(organizationRoutes.organizationId, input.workspaceId));
  assert(route?.workosId, "This job has no registered institute route.", 403);
  const workspace = await loadWorkspace(route.organizationId);
  assert(!workspace.demo && workspace.workosOrganizationId === route.workosId, "This institute is not enabled for live worker dispatch.", 403);
  return processJob(route.organizationId, input.jobId);
}
