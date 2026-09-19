import { AppError } from "../src/lib/errors";

const paymentMessages = new Set([
  "Specify a workspace; replay requires both --receipt and --apply.",
  "PostgreSQL is required.",
  "Choose a payment receipt belonging to this institute.",
  "Payment receipt not found.",
  "This receipt is still being processed.",
]);

/** Only reviewed fixed operator guidance may escape; never print arbitrary provider/DB errors. */
export function safePaymentError(error: unknown): string {
  if (error instanceof AppError && paymentMessages.has(error.message)) return error.message;
  return "Payment inspection/replay failed. Check arguments, database configuration and the receipt's state; no automatic merchant rebind was performed.";
}

const errorClasses = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "EvalError", "AggregateError", "AppError", "ZodError"]);
/** Error.name is mutable too: unknown classes must not become a channel for sensitive data. */
export function safeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  return errorClasses.has(error.name) ? error.name : "Error";
}
