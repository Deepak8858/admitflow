export const workspacePages = {
  overview: "Overview",
  leads: "Enquiries",
  pipeline: "Admissions pipeline",
  inbox: "Shared inbox",
  appointments: "Counselling",
  recovery: "Recovery campaigns",
  automations: "AI & automations",
  knowledge: "Knowledge base",
  analytics: "Revenue analytics",
  team: "Team & access",
  integrations: "Integrations",
  settings: "Settings",
} as const;

export type WorkspacePage = keyof typeof workspacePages;

export function workspacePage(view: string[]): WorkspacePage | null {
  return view.length === 1 && Object.hasOwn(workspacePages, view[0])
    ? view[0] as WorkspacePage
    : null;
}
