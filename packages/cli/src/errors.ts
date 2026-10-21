/** The command was used wrongly, or its environment cannot do what was asked (exit code 2). */
export class UsageError extends Error {
  override name = 'UsageError';
}
