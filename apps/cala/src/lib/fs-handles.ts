/** File System Access handle helpers shared by the project, recent-projects and export code. */

type PermissionHandle = {
  queryPermission?: (o: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
};

/**
 * `mode` permission on a stored handle, asked for (inside a click) when not already granted. A
 * handle without `requestPermission` (no File System Access permissions) counts as granted.
 */
export async function ensurePermission(
  handle: unknown,
  mode: 'read' | 'readwrite',
): Promise<boolean> {
  const h = handle as PermissionHandle;
  if (typeof h.requestPermission !== 'function') return true;
  if ((await h.queryPermission?.({ mode })) === 'granted') return true;
  return (await h.requestPermission({ mode })) === 'granted';
}
