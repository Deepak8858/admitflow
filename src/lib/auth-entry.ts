export type AuthEntryMode = "signup" | "login";

export interface AuthEntryState {
  email?: string;
  error?: string;
  fieldError?: string;
}

export type AuthEntryAction = (previous: AuthEntryState, formData: FormData) => Promise<AuthEntryState>;
