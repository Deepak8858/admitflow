import { AppError, assert } from "./errors";
import { hydrateWorkspace, type Workspace, type Role, type Lead, type WorkspaceFile, type Connection } from "./domain";

type Actor = NonNullable<Workspace["actor"]>;
export const permissions: Record<Role, readonly string[]> = {
  owner: ["*"], admin: ["*"],
  counsellor: ["lead.create", "lead.update", "task.save", "task.complete", "message.suggest", "message.send", "message.draft", "message.note", "message.read", "appointment.create", "appointment.status", "appointment.reschedule", "view.save", "file.upload"],
  analyst: ["view.save"],
};
export function can(role: Role, action: string) { return Boolean(Object.hasOwn(permissions, role) && (permissions[role].includes("*") || permissions[role].includes(action))); }
export function assertPermission(role: Role, action: string) {
  if (!can(role, action)) throw new AppError("Your role does not have permission for this action.", 403);
}

/** WorkOS user ID, membership ID, active state and role must all agree. */
export function assertActor(workspace: Pick<Workspace, "id" | "members" | "workosOrganizationId">, actor: Actor) {
  assert(typeof actor.id === "string" && actor.id.length > 0 && typeof actor.name === "string" && typeof actor.email === "string", "Invalid session identity.", 403);
  assert(Object.hasOwn(permissions, actor.role), "This institute role is not supported.", 403);
  if (actor.backend === "local" && actor.role === "owner" && actor.id === workspace.id && !workspace.workosOrganizationId) return;
  assert(actor.backend === "workos" || (actor.backend === "local" && !workspace.workosOrganizationId), "Invalid session identity.", 403);
  const members = (workspace.members || []).filter(member => actor.backend === "workos" ? Boolean(member.workosId) && member.workosId === actor.id : member.id === actor.id);
  const member = members.length === 1 ? members[0] : undefined;
  assert(member && member.status === "active" && member.role === actor.role && (!actor.memberId || actor.memberId === member.id), "Your institute membership has changed. Sign in again.", 403);
  assert(member.name === actor.name && member.email.toLowerCase() === actor.email.toLowerCase(), "Your session identity has changed. Refresh and try again.", 403);
  return member;
}

export function actorOwnerId(workspace: Workspace, actor: Actor) {
  return assertActor(workspace, actor)?.id;
}

export function canAccessLead(workspace: Workspace, actor: Actor, lead: Lead) {
  const member = assertActor(workspace, actor);
  return actor.role !== "counsellor" || Boolean(member && lead.ownerId === member.id);
}

export function assertLeadAccess(workspace: Workspace, actor: Actor, id: unknown) {
  assertActor(workspace, actor);
  const lead = workspace.leads.find(item => typeof id === "string" && item.id === id);
  assert(lead, "Enquiry not found in your workspace.", 404);
  assert(canAccessLead(workspace, actor, lead), "This enquiry is not assigned to you.", 403);
  return lead;
}

export function assertFileAccess(workspace: Workspace, actor: Actor, file: WorkspaceFile, upload = false) {
  assertActor(workspace, actor);
  if (upload) assertPermission(actor.role, "file.upload");
  if (file.leadId) assertLeadAccess(workspace, actor, file.leadId);
  if (actor.role === "analyst") assert(file.purpose === "knowledge" && !file.leadId, "Analysts cannot access applicant files.", 403);
  if (actor.role === "counsellor") {
    assert(upload ? file.purpose === "attachment" && Boolean(file.leadId)
      : (file.purpose === "knowledge" && !file.leadId) || (file.purpose === "attachment" && Boolean(file.leadId)),
    "Counsellor files must be attachments for an assigned enquiry.", 403);
  }
}

export function assertMessageFile(workspace: Workspace, leadId: string, fileId: string, actor?: Actor) {
  const file = workspace.files?.find(item => item.id === fileId);
  assert(file && file.status === "ready", "Attachment is not ready or was not found.", 404);
  assert((file.purpose === "attachment" && file.leadId === leadId) || (file.purpose === "knowledge" && !file.leadId), "This file does not belong to the enquiry.", 403);
  if (actor) assertFileAccess(workspace, actor, file);
  return file;
}

// Positive allowlist: arbitrary provider metadata can contain tokens or object URLs.
const publicMetadata = new Set(["wabaId", "name", "coexistence", "coexistenceVerifiedAt", "templateName", "templateLanguage", "readiness", "verifiedAt", "voiceId", "calendarId", "googleRevocation", "pageId", "pageName", "subscribed", "subscribedFields", "accountId", "mode", "subscriptionStatus", "appId", "tokenExpiresAt", "lastLeadAt", "lastLeadError", "lastLeadErrorAt"]);
export function publicConnection(connection: Connection): Connection {
  return { id: connection.id, service: connection.service, status: connection.status, externalId: connection.externalId, label: connection.label, updatedAt: connection.updatedAt,
    metadata: Object.fromEntries(Object.entries(connection.metadata).filter(([key]) => publicMetadata.has(key))) };
}
export function scopeWorkspace(workspace: Workspace, actor: Actor): Workspace {
  assertActor(workspace, actor);
  const result = hydrateWorkspace(structuredClone(workspace));
  result.actor = { ...actor }; result.userName = actor.name; result.email = actor.email;
  result.connections = result.connections?.map(publicConnection);
  result.files = result.files?.map(file => ({ id: file.id, name: file.name, mime: file.mime, size: file.size, purpose: file.purpose, status: file.status, createdAt: file.createdAt, error: file.error, leadId: file.leadId, finalizedAt: file.finalizedAt }));
  if (actor.role === "analyst") {
    result.files = result.files?.filter(file => file.purpose === "knowledge" && !file.leadId);
    const fileIds = new Set(result.files?.map(file => file.id));
    result.messages.forEach(message => { if (message.fileId && !fileIds.has(message.fileId)) delete message.fileId; });
    result.articles = result.articles.filter(article => !article.fileId || fileIds.has(article.fileId));
  }
  if (actor.role !== "counsellor") return result;
  const memberId = actorOwnerId(workspace, actor);
  result.leads = result.leads.filter(lead => Boolean(memberId) && lead.ownerId === memberId);
  const ids = new Set(result.leads.map(lead => lead.id));
  result.messages = result.messages.filter(message => ids.has(message.leadId));
  result.appointments = result.appointments.filter(appointment => ids.has(appointment.leadId));
  result.activities = result.activities.filter(activity => activity.leadId && ids.has(activity.leadId));
  result.revenue = []; result.refunds = []; result.campaigns = []; result.jobs = [];
  result.tasks = result.tasks?.filter(task => ids.has(task.leadId));
  result.files = result.files?.filter(file => (file.purpose === "knowledge" && !file.leadId) || (file.purpose === "attachment" && Boolean(file.leadId && ids.has(file.leadId))));
  const fileIds = new Set(result.files?.map(file => file.id));
  result.messages.forEach(message => { if (message.fileId && !fileIds.has(message.fileId)) delete message.fileId; });
  result.articles = result.articles.filter(article => !article.fileId || fileIds.has(article.fileId));
  result.subscription = undefined;
  return result;
}

export function authorizeRecordAction(workspace: Workspace, actor: Actor, action: Record<string, unknown>) {
  const member = assertActor(workspace, actor);
  assertPermission(actor.role, String(action.type));
  const type = String(action.type);
  let lead: Lead | undefined;
  if (Object.hasOwn(action, "leadId")) lead = assertLeadAccess(workspace, actor, action.leadId);
  if (["lead.update", "message.read"].includes(type)) lead = assertLeadAccess(workspace, actor, action.id);
  if (["appointment.status", "appointment.reschedule"].includes(type)) {
    const appointment = workspace.appointments.find(item => item.id === action.id);
    assert(appointment, "Appointment not found.", 404);
    lead = assertLeadAccess(workspace, actor, appointment.leadId);
  }
  if (type === "task.complete" || (type === "task.save" && action.id !== undefined)) {
    const task = workspace.tasks?.find(item => item.id === action.id);
    assert(task, "Task not found.", 404);
    // Check the existing record too, before allowing a change of leadId.
    assertLeadAccess(workspace, actor, task.leadId);
  }
  if (action.fileId !== undefined) {
    assert(lead && typeof action.fileId === "string", "Select an enquiry for this attachment.");
    assertMessageFile(workspace, lead.id, action.fileId, actor);
  }
  if (actor.role !== "counsellor") return;
  const changes = action.changes && typeof action.changes === "object" ? action.changes as Record<string, unknown> : undefined;
  for (const assignment of [changes, ["task.save", "appointment.create", "appointment.reschedule"].includes(type) ? action : undefined]) {
    if (!assignment) continue;
    if ((assignment.ownerId !== undefined && assignment.ownerId !== member!.id) || (assignment.owner !== undefined && assignment.owner !== member!.name)) throw new AppError("Ask an administrator to reassign this enquiry or task.", 403);
    if (assignment.owner !== undefined || assignment.ownerId !== undefined) { assignment.ownerId = member!.id; assignment.owner = member!.name; }
  }
  if (type === "lead.create") {
    assert(action.lead && typeof action.lead === "object" && !Array.isArray(action.lead), "Enter the enquiry details.");
    Object.assign(action.lead, { ownerId: member!.id, owner: member!.name });
  }
}
