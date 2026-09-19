export interface ProvisioningStatus {
  id: string;
  requestId: string;
  name: string;
  state: "pending" | "continue" | "review_required" | "ready";
  message: string;
  organizationId?: string;
  acknowledged: boolean;
}
