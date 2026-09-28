import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Redis from "ioredis";
import { enforceMutationRateLimit } from "../src/lib/mutation-rate-limit";
import { AppError } from "../src/lib/errors";

const request = () => new Request("https://app.example.com/api/workspace", { method: "POST" });
const identity = { kind: "workspace" as const, actorId: "recovery_actor", tenantId: "recovery_tenant" };

test("cached mutation Redis client recovers after initial connect failure and terminal end", async t => {
  const keys = ["NODE_ENV", "DATABASE_URL", "REDIS_URL"] as const;
  const original = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, index) => {
    if (original[index] === undefined) delete process.env[key];
    else Object.assign(process.env, { [key]: original[index] });
  }));
  const redisUrl = new URL("rediss://redis.invalid:6379");
  redisUrl.password = randomBytes(24).toString("hex");
  Object.assign(process.env, {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://fixture@database.invalid/test",
    REDIS_URL: redisUrl.toString(),
  });

  let rejectFirst!: (error: Error) => void;
  const firstConnect = new Promise<void>((_, reject) => { rejectFirst = reject; });
  const clients: Redis[] = [];
  let evaluations = 0;
  let failEvaluation = false;
  t.mock.method(Redis.prototype, "connect", function (this: Redis) {
    clients.push(this);
    if (clients.length === 1) return firstConnect;
    this.status = "ready";
    return Promise.resolve();
  });
  t.mock.method(Redis.prototype, "disconnect", function (this: Redis) {
    this.status = "end";
    this.emit("end");
  });
  t.mock.method(Redis.prototype, "eval", function (this: Redis) {
    assert.equal(this.status, "ready", "evaluation must use a ready client");
    evaluations++;
    if (failEvaluation) throw new Error("private-secret-fixture-error");
    return Promise.resolve([1, 0]);
  });

  const unavailable = (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "RATE_LIMIT_UNAVAILABLE");
    assert.doesNotMatch(error.message, /secret|private|redis\.invalid/);
    return true;
  };

  const failedRequest = request();
  const waiting = [failedRequest, request(), request()].map(req => enforceMutationRateLimit(req, identity));
  const failed = Promise.allSettled(waiting);
  await Promise.resolve();
  assert.equal(clients.length, 1, "concurrent checks share one initial connection");
  rejectFirst(new Error("private-secret-fixture-error"));
  for (const result of await failed) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") unavailable(result.reason);
  }
  assert.equal(evaluations, 0, "failed connection cannot charge a rate budget");
  await assert.rejects(enforceMutationRateLimit(failedRequest, identity), unavailable);
  assert.equal(clients.length, 1, "a repeated Request retains its failed decision");

  await Promise.all(Array.from({ length: 3 }, () => enforceMutationRateLimit(request(), identity)));
  assert.equal(clients.length, 2, "later requests share one replacement connection");
  assert.equal(evaluations, 3);

  clients[0].emit("end");
  await enforceMutationRateLimit(request(), identity);
  assert.equal(clients.length, 2, "late events from the failed client cannot clear its replacement");

  clients[1].status = "end";
  clients[1].emit("end");
  await enforceMutationRateLimit(request(), identity);
  assert.equal(clients.length, 3, "terminal end creates a fresh connection");

  clients[2].status = "end";
  await enforceMutationRateLimit(request(), identity);
  assert.equal(clients.length, 4, "terminal status is recovered even if the event was missed");

  failEvaluation = true;
  const uncertainRequest = request();
  const before = evaluations;
  await assert.rejects(enforceMutationRateLimit(uncertainRequest, identity), unavailable);
  assert.equal(evaluations, before + 1, "an ambiguous evaluation is never retried");
  await assert.rejects(enforceMutationRateLimit(uncertainRequest, identity), unavailable);
  assert.equal(evaluations, before + 1, "the same Request keeps its failed decision");
  failEvaluation = false;
  await enforceMutationRateLimit(request(), identity);
  assert.equal(clients.length, 4, "an evaluation error does not force a new connection");
});
