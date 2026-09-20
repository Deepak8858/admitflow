import type { Message } from "./domain";

export function indexInboxMessages(messages: readonly Message[]) {
  const byLead = new Map<string, Message[]>();
  const leadIds = new Set<string>();
  const latest = new Map<string, Message>();
  for (const message of messages) {
    leadIds.add(message.leadId);
    if (message.status === "draft") continue;
    const thread = byLead.get(message.leadId) || [];
    thread.push(message); byLead.set(message.leadId, thread);
  }
  for (const [leadId, thread] of byLead) {
    thread.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    for (let index = thread.length - 1; index >= 0; index--) {
      const message = thread[index]!;
      if (message.direction !== "internal") { latest.set(leadId, message); break; }
    }
  }
  return { byLead, leadIds, latest };
}
