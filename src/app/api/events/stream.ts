export interface WorkspaceStreamOptions {
  workspaceId: string;
  signal: AbortSignal;
  initialRevision: number;
  readRevision: () => Promise<number>;
  validateMembership: () => Promise<boolean>;
  pollMs?: number;
  heartbeatMs?: number;
  lifetimeMs?: number;
}

export function revisionEvent(workspaceId: string, revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid workspace revision.");
  return `id: ${revision}\nevent: change\ndata: ${JSON.stringify({ workspaceId, revision })}\n\n`;
}

/** Dependency-injected so revocation, transport cleanup and revision behavior are testable without a provider. */
export function workspaceEventStream(options: WorkspaceStreamOptions) {
  const { signal, workspaceId, readRevision, validateMembership, initialRevision, pollMs = 5000, heartbeatMs = 15000, lifetimeMs = 55000 } = options;
  let cleanup = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false, revision = initialRevision, validatedAt = Date.now(), heartbeatAt = Date.now();
      let poll: ReturnType<typeof setTimeout> | undefined, lifetime: ReturnType<typeof setTimeout> | undefined;
      const close = (cancelled = false) => {
        if (closed) return;
        closed = true;
        clearTimeout(poll); clearTimeout(lifetime);
        signal.removeEventListener("abort", abort);
        if (!cancelled) controller.close();
      };
      const abort = () => close();
      cleanup = () => close(true);
      const send = (text: string) => {
        if (closed) return;
        // A disconnected/slow consumer must not accumulate an unbounded event queue.
        if ((controller.desiredSize ?? 0) <= 0) { close(); return; }
        controller.enqueue(encoder.encode(text));
      };
      const tick = async () => {
        try {
          const next = await readRevision();
          if (closed) return;
          if (next !== revision || Date.now() - validatedAt >= heartbeatMs) {
            const allowed = await validateMembership();
            if (closed) return;
            if (!allowed) { send('event: revoked\ndata: {"reason":"membership_changed"}\n\n'); close(); return; }
            validatedAt = Date.now();
          }
          if (next !== revision) { send(revisionEvent(workspaceId, next)); revision = next; heartbeatAt = Date.now(); }
          else if (Date.now() - heartbeatAt >= heartbeatMs) { send(": heartbeat\n\n"); heartbeatAt = Date.now(); }
        } catch {
          // A provider/database outage closes the connection for EventSource to retry; it is not a membership revocation.
          close();
        }
        if (!closed) poll = setTimeout(() => void tick(), pollMs);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { close(); return; }
      send(`retry: 3000\n${revisionEvent(workspaceId, revision)}`);
      poll = setTimeout(() => void tick(), pollMs);
      lifetime = setTimeout(() => close(), lifetimeMs);
    },
    cancel() { cleanup(); },
  });
}
