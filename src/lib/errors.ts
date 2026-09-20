export class AppError extends Error {
  constructor(message: string, public status = 400, public code?: string, options?: ErrorOptions) { super(message, options); this.name = "AppError"; }
}
/** Only fixed classifications, numeric status and explicitly reviewed codes may enter logs. */
export function safeErrorDiagnostic(error: unknown) {
  const errorClass = error instanceof AppError ? "AppError" : error instanceof SyntaxError ? "SyntaxError" : error instanceof TypeError ? "TypeError" : error instanceof RangeError ? "RangeError" : error instanceof Error ? "Error" : "Unknown";
  const status = error instanceof AppError && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : undefined;
  const candidate = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
  const code = typeof candidate === "string" && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "SUBSCRIPTION_RESTRICTED"].includes(candidate) ? candidate : undefined;
  return { errorClass, ...(status !== undefined ? { status } : {}), ...(code ? { code } : {}) };
}
export function assert(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new AppError(message, status);
}
