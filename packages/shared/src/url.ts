/**
 * `path` under `base`, keeping whatever path `base` already carries. `new URL(path, base)`
 * drops it when `path` starts with a slash, which is how a portal reached under `/api` — the
 * deployed one is — would have lost its prefix on every call made to it.
 */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
