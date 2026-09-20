/** CDK CLI values are strings; cdk.json/programmatic context can contain booleans. */
export function highAvailabilityContext(value: unknown): boolean {
  if (value === undefined || value === false || value === "false") return false;
  if (value === true || value === "true") return true;
  throw new Error('highAvailability must be a boolean or the string "true" or "false".');
}
