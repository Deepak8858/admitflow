import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createWorkspace } from "./seed";
import { type Workspace, DAY } from "./domain";
import { AppError } from "./errors";
import { normalizeWorkspaceInstants } from "./instants";

const globalStore = globalThis as unknown as { admitflowDb?: DatabaseSync };
export function database() {
  if (globalStore.admitflowDb) return globalStore.admitflowDb;
  const filename = process.env.ADMITFLOW_DB || path.join(process.cwd(), ".data", "admitflow.sqlite");
  mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, password_hash TEXT NOT NULL, workspace_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
  `);
  globalStore.admitflowDb = db;
  return db;
}
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
export function loadWorkspace(id: string): Workspace {
  const row = database().prepare("SELECT data FROM workspaces WHERE id = ?").get(id) as { data: string } | undefined;
  if (!row) throw new AppError("Workspace not found. Sign in again.");
  return normalizeWorkspaceInstants(JSON.parse(row.data) as Workspace);
}
export function saveNewWorkspace(workspace: Workspace) {
  normalizeWorkspaceInstants(workspace);
  database().prepare("INSERT INTO workspaces (id, data) VALUES (?, ?)").run(workspace.id, JSON.stringify(workspace));
}
export function mutateWorkspace<T>(id: string, action: (workspace: Workspace) => T): { workspace: Workspace; result: T } {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const workspace = loadWorkspace(id);
    const result = action(workspace);
    normalizeWorkspaceInstants(workspace);
    db.prepare("UPDATE workspaces SET data = ? WHERE id = ?").run(JSON.stringify(workspace), id);
    db.exec("COMMIT");
    return { workspace, result };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function sessionWorkspace(token?: string) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = database().prepare("SELECT workspace_id FROM sessions WHERE token_hash = ? AND expires_at > ?").get(digest(token), Date.now()) as { workspace_id: string } | undefined;
  return row?.workspace_id || null;
}
export function createSession(workspaceId: string) {
  const token = randomBytes(32).toString("hex");
  database().prepare("INSERT INTO sessions (token_hash, workspace_id, expires_at) VALUES (?, ?, ?)").run(digest(token), workspaceId, Date.now() + 14 * DAY);
  return token;
}
export function endSession(token: string) { database().prepare("DELETE FROM sessions WHERE token_hash = ?").run(digest(token)); }
export function createDemo() { const workspace = createWorkspace(); saveNewWorkspace(workspace); return { workspace, token: createSession(workspace.id) }; }

function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
function passwordMatches(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  return timingSafeEqual(Buffer.from(hash, "hex"), scryptSync(password, salt, 64));
}
const authenticationFailure = () => new AppError("Authentication could not be completed. Please try again.", 400, "AUTHENTICATION_FAILED");
export function register(email: string, password: string, name: string, institute: string) {
  const db = database();
  if (db.prepare("SELECT email FROM users WHERE email = ?").get(email)) throw authenticationFailure();
  const workspace = createWorkspace(false);
  workspace.name = institute; workspace.userName = name; workspace.email = email; workspace.team = [name];
  const hash = passwordHash(password);
  db.exec("BEGIN IMMEDIATE");
  try {
    saveNewWorkspace(workspace);
    try { db.prepare("INSERT INTO users (email, password_hash, workspace_id) VALUES (?, ?, ?)").run(email, hash, workspace.id); }
    catch (error) {
      // A second connection can win after the precheck. Only sanitize the users
      // primary/unique constraint here; unrelated storage errors remain generic 500s.
      const code = error && typeof error === "object" && "errcode" in error ? error.errcode : undefined;
      if (code === 1555 || code === 2067) throw authenticationFailure();
      throw error;
    }
    const token = createSession(workspace.id);
    db.exec("COMMIT");
    return { workspace, token };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function login(email: string, password: string) {
  const row = database().prepare("SELECT password_hash, workspace_id FROM users WHERE email = ?").get(email) as { password_hash: string; workspace_id: string } | undefined;
  // Keep missing-user work comparable to password verification.
  if (!row) { scryptSync(password, "admitflow-missing-user", 64); throw new AppError("Email or password did not match. Please try again."); }
  if (!passwordMatches(password, row.password_hash)) throw new AppError("Email or password did not match. Please try again.");
  return { workspace: loadWorkspace(row.workspace_id), token: createSession(row.workspace_id) };
}
export function checkAuthRate(key: string) {
  const db = database(), now = Date.now();
  const row = db.prepare("SELECT count, reset_at FROM auth_attempts WHERE key = ?").get(key) as { count: number; reset_at: number } | undefined;
  if (row && row.reset_at > now && row.count >= 10) throw new AppError("Too many sign-in attempts. Try again in 15 minutes.");
  db.prepare("INSERT OR REPLACE INTO auth_attempts (key, count, reset_at) VALUES (?, ?, ?)").run(key, row && row.reset_at > now ? row.count + 1 : 1, row && row.reset_at > now ? row.reset_at : now + 15 * 60000);
}
