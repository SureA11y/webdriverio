// webdriverio's declarations import URLPattern from urlpattern-polyfill, whose
// global declarations clash with TypeScript 7's DOM library. This gives them the DOM's.
type DomURLPattern = URLPattern;
declare const DomURLPattern: typeof URLPattern;
export { DomURLPattern as URLPattern };
