// __APP_ORIGIN__ is the site origin, not pkg.homepage's /team-tracker/ subpath:
// the manifest's top-level "id" ("/") resolves against the manifest URL as an
// absolute-path reference, so Chrome's actually-computed app identity for every
// install to date is the origin root (verified via DevTools Application panel
// "Computed App Id"), not the subpath. The related_applications self-entry
// in pwa/manifest.json must match that already-installed identity exactly or
// getInstalledRelatedApps() never matches.
export function computeAppOrigin(homepage) {
  return homepage ? `${new URL(homepage).origin}/` : ''
}
