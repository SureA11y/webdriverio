// webdriverio's own declarations import a type from puppeteer-core, an
// optional peer dependency this package does not install. This stands in
// for it so they compile here without checking every library declaration
// (skipLibCheck would skip this package's own .d.ts files too).
export interface Browser {}
