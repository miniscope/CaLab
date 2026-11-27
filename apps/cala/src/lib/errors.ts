/** An error's message, or the thrown value as text when it is not an `Error`. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
