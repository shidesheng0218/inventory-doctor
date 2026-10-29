// Single runtime source of truth for the version.
//
// Keep in sync with package.json and the distribution manifests by running:
//   npm run sync-version <version>
// CI enforces consistency with:
//   npm run check:versions
export const VERSION = '0.5.0';