import { config } from "dotenv";
config({ path: ".env.local" });
import { Worker } from "bullmq";
import { QUEUE_NAME, queueConnection, workQueue, dispatchOutbox, runQueuedJob } from "../src/lib/db/outbox";
import { recoverPaymentEvents } from "../src/lib/db/payment-inbox";
import { reconcileSubscriptions } from "../src/lib/providers/billing";
import { safeErrorClass, safeJobName } from "./operational-diagnostics";
import { sweepIntakeRetention } from "../src/lib/db/intake-retention";

const queue = workQueue();
const worker = new Worker(QUEUE_NAME, job => runQueuedJob(job), { connection: queueConnection(), concurrency: 5 });
worker.on("error", error => console.error("Worker connection error", safeErrorClass(error)));
worker.on("failed", (job, error) => console.error("Worker job failed", job?.id, safeJobName(job?.name), safeErrorClass(error)));
let running: Promise<void> | undefined, closing = false;
function dispatch() {
  if (running || closing) return;
  running = dispatchOutbox(queue).then(() => undefined).catch(error => { console.error("Outbox dispatch failed", safeErrorClass(error)); }).finally(() => { running = undefined; });
}
let paymentRecovery: Promise<void> | undefined, paymentAfter: string | undefined;
function recoverPayments() {
  if (paymentRecovery || closing) return;
  paymentRecovery = recoverPaymentEvents(paymentAfter, 10, 2).then(result => {
    paymentAfter = result.after;
    if (result.tenantFailures) console.error("Payment recovery tenant failures", result.tenantFailures);
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
let intakeCleanup: Promise<void> | undefined, intakeAfter: string | undefined;
function cleanIntake() {
  if (intakeCleanup || closing) return;
  intakeCleanup = sweepIntakeRetention(intakeAfter).then(result => {
    intakeAfter = result.after;
    if (result.failed) console.error("Intake retention failures", result.failed);
    if (result.redacted) console.log("Intake payloads redacted", result.redacted);
  }).catch(() => { console.error("Intake retention unavailable"); }).finally(() => { intakeCleanup = undefined; });
}
const timer = setInterval(dispatch, 5000), paymentTimer = setInterval(recoverPayments, 15000), billingTimer = setInterval(reconcileBilling, 60000), intakeTimer = setInterval(cleanIntake, 60000);
dispatch(); recoverPayments(); reconcileBilling(); cleanIntake();
async function shutdown() {
  if (closing) return;
  closing = true; clearInterval(timer); clearInterval(paymentTimer); clearInterval(billingTimer); clearInterval(intakeTimer);
  await Promise.all([running, paymentRecovery, billingRecovery, intakeCleanup]); await worker.close(); await queue.close(); process.exit(0);
}
process.once("SIGTERM", () => void shutdown()); process.once("SIGINT", () => void shutdown());
