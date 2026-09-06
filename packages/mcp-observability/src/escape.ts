/** Escapes a value for a double-quoted LogQL or PromQL string, so a label selector cannot be broken out of. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The value escaped and wrapped in double quotes. */
export function quoted(value: string): string {
  return `"${escapeLabelValue(value)}"`;
}
