export function isRecordObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object') {
    return false;
  }
  if (value === null) {
    return false;
  }
  return true;
}
