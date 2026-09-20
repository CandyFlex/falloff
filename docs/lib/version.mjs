/**
 * version.mjs: the package version, readable from browser-safe code.
 *
 * Providers put it in their User-Agent. Browser-safe modules cannot read
 * package.json, so the value is repeated here and a test keeps the two equal.
 */
export const VERSION = '0.1.0';
export const REPOSITORY = 'https://github.com/CandyFlex/falloff';
