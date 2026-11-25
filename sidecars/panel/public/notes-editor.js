/**
 * Hybrid live-preview Markdown notes editor for AGY Todo auxiliary pane.
 * Exposed as window.AGYNotesEditor in classic script tags and CommonJS module.exports in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var api = factory();
    root.AGYNotesEditor = api;
    if (root && root.window && root.window !== root) {
      root.window.AGYNotesEditor = api;
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  return {};
});
