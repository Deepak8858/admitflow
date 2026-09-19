import { productionDatabase } from "./config";
import { hydrateWorkspace, type Workspace } from "./domain";
import { loadPostgresWorkspace, mutatePostgresWorkspace } from "./db/repository";
import * as local from "./local-store";

export const database = local.database;
export const sessionWorkspace = local.sessionWorkspace;
export const endSession = local.endSession;
export const createSession = local.createSession;
export const checkAuthRate = local.checkAuthRate;
export const saveNewWorkspace = local.saveNewWorkspace;
export function createDemo() { const result = local.createDemo(); hydrateWorkspace(result.workspace); return result; }
export function register(...args: Parameters<typeof local.register>) {
  if (productionDatabase()) throw new Error("Use WorkOS to create a production workspace.");
  const result = local.register(...args); hydrateWorkspace(result.workspace); return result;
}
export function login(...args: Parameters<typeof local.login>) {
  if (productionDatabase()) throw new Error("Use WorkOS to sign in.");
  const result = local.login(...args); hydrateWorkspace(result.workspace); return result;
}
export async function loadWorkspace(id: string) {
  return productionDatabase() ? loadPostgresWorkspace(id) : hydrateWorkspace(local.loadWorkspace(id));
}
export async function mutateWorkspace<T>(id: string, action: (workspace: Workspace) => T) {
  if (productionDatabase()) return mutatePostgresWorkspace(id, action);
  return local.mutateWorkspace(id, workspace => { hydrateWorkspace(workspace); const result = action(workspace); workspace.revision = (workspace.revision || 0) + 1; return result; });
}
