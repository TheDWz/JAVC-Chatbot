// Page globals, for the type check only: the scripts index.html loads before renderer.js, and the bridge preload.js
// (desktop) or mobile/main.js (Android) puts on window.
declare const Lib: typeof import('./lib');
declare const marked: typeof import('marked').marked;
// shortcut: the bridge is untyped; describe its methods here if calls to it start going wrong
interface Window { api: any }
