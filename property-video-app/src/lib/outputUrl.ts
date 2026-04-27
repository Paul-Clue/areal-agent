/** Stored `jobs.output_url` for finished files on the app server (not DO Spaces). */
export function isLocalOutputUrl(url: string | null): boolean {
  return Boolean(url && url.startsWith('local:'));
}

export function localPathFromOutputUrl(url: string): string {
  return url.slice('local:'.length);
}
