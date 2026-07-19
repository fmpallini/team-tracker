// Minimal ambient declaration for the Get Installed Related Apps API, not
// present in the DOM lib shipped with the project's TypeScript version.
// Chromium-only; src/ui/promo.ts feature-detects before calling it.

interface RelatedApplication {
  platform: string
  url?: string
  id?: string
}

interface Navigator {
  // Property (not method) syntax: extracting this into a local const, as
  // src/ui/promo.ts does, would otherwise trip
  // @typescript-eslint/unbound-method (method torn off its receiver).
  getInstalledRelatedApps?: () => Promise<RelatedApplication[]>
}
