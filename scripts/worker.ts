import { config } from "dotenv";
config({ path: ".env.local" });
import { Worker } from "bullmq";
import { QUEUE_NAME, queueConnection, workQueue, dispatchOutbox, runQueuedJob } from "../src/lib/db/outbox";
import { recoverPaymentEvents } from "../src/lib/db/payment-inbox";
import { reconcileSubscriptions } from "../src/lib/providers/billing";
import { safeErrorClass } from "./operational-diagnostics";

const queue = workQueue();
const worker = new Worker(QUEUE_NAME, job => runQueuedJob(job.data), { connection: queueConnection(), concurrency: 5 });
worker.on("error", error => console.error("Worker connection error", safeErrorClass(error)));
worker.on("failed", (job, error) => console.error("Worker job failed", job?.id, safeErrorClass(error)));
let running: Promise<void> | undefined, closing = false;
function dispatch() {
  if (running || closing) return;
  running = dispatchOutbox(queue).then(() => undefined).catch(error => { console.error("Outbox dispatch failed", safeErrorClass(error)); }).finally(() => { running = undefined; });
}
let paymentRecovery: Promise<void> | undefined;
function recoverPayments() {
  if (paymentRecovery || closing) return;
  paymentRecovery = recoverPaymentEvents(2).then(result => {
    if (result.selected) console.log("Payment recovery", JSON.stringify(result));
  }).catch(() => { console.error("Payment recovery dispatch failed"); }).finally(() => { paymentRecovery = undefined; });
}
let billingRecovery: Promise<void> | undefined, billingAfter: string | undefined;
function reconcileBilling() {
  if (billingRecovery || closing) return;
  billingRecovery = reconcileSubscriptions(billingAfter).then(result => {
    billingAfter = result.after;
    if (result.failed) console.error("Subscription reconciliation failures", result.failed);
  }).catch(() => { console.error("Subscription reconciliation unavailable"); }).finally(() => { billingRecovery = undefined; });
}
const timer = setInterval(dispatch, 5000), paymentTimer = setInterval(recoverPayments, 15000), billingTimer = setInterval(reconcileBilling, 60000);
dispatch(); recoverPayments(); reconcileBilling();
async function shutdown() {
  if (closing) return;
  closing = true; clearInterval(timer); clearInterval(paymentTimer); clearInterval(billingTimer);
  await Promise.all([running, paymentRecovery, billingRecovery]); await worker.close(); await queue.close(); process.exit(0);
}
process.once("SIGTERM", () => void shutdown()); process.once("SIGINT", () => void shutdown());
