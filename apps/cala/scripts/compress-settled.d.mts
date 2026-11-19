export function compressSettled(
  status: { source: string; final: boolean; pending: number } | null | undefined,
  expectedSource: 'discover' | 'replay',
): boolean;
