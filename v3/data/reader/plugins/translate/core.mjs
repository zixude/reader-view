/* global config, iframe, args, add */
'use strict';

let engine;

async function enable() {
  await add('./plugins/translate/engine.js', self.TranslateEngine);
  engine = new self.TranslateEngine({
    doc: iframe.contentDocument,
    view: iframe.contentWindow,
    controlDocument: document,
    prefs: config.prefs,
    url: args.get('url'),
    notify: (message, type) => window.notify?.(message, type)
  });
  engine.enable();
}

function disable() {
  engine?.disable();
}

export {
  enable,
  disable
};
