/** Read an API object without allowing an HTML gateway response to hide its HTTP status. */
export async function readJsonBody<T extends object>(response: Response, fallback: string): Promise<T> {
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    if (response.ok) throw new Error(fallback);
    return {} as T;
  }
  return body as T;
}

export async function readJsonResponse<T extends object>(response: Response, fallback: string): Promise<T> {
  const body = await readJsonBody<T & { error?: unknown }>(response, fallback);
  if (!response.ok) throw new Error(typeof body.error === "string" && body.error.trim() ? body.error : fallback);
  return body;
}
