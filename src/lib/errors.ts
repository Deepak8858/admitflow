export class AppError extends Error {
  constructor(message: string, public status = 400, public code?: string) { super(message); this.name = "AppError"; }
}
export function assert(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new AppError(message, status);
}
