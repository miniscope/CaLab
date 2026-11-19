/**
 * Whether a compress status is the final one of the stage that ran: it belongs
 * to that stage's frames (`expectedSource`: 'discover' or 'replay'), the
 * recording ended and no window waits. Pure, so the batch driver can poll it.
 */
export function compressSettled(status, expectedSource) {
  return Boolean(
    status && status.source === expectedSource && status.final === true && status.pending === 0,
  );
}
