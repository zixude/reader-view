(() => {
  'use strict';

  const GOOGLE_ENDPOINT = 'https://clients5.google.com/translate_a/t';
  const BLOCK_SELECTOR = 'p, li, blockquote, figcaption, td, th, h1, h2, h3, h4, h5, h6';
  const SKIP_SELECTOR = 'script, style, code, pre, kbd, samp, textarea, input, select, option, [contenteditable="true"]';
  const MAX_BLOCKS = 12;
  const MAX_BATCH_LENGTH = 8000;
  const MAX_GOOGLE_URL_LENGTH = 7000;

  class TranslateEngine {
    constructor({doc, view, prefs, url, controlDocument = doc, notify, request}) {
      this.doc = doc;
      this.view = view;
      this.prefs = prefs;
      this.url = url;
      this.controlDocument = controlDocument;
      this.notify = notify;
      this.request = request || this.#fetch.bind(this);
      this.translated = new WeakSet();
      this.queued = new Set();
      this.pending = [];
      this.running = false;
      this.stopped = false;
      this.lastStartAt = 0;
    }

    async #fetch(url, options) {
      const response = await fetch(url, options);
      let data;
      try {
        data = await response.json();
      }
      catch (e) {}
      return {
        ok: response.ok,
        status: response.status,
        data
      };
    }

    #fail() {
      this.stopped = true;
      this.pending.length = 0;
      this.queued.clear();
      this.view.clearTimeout(this.drainTimer);
      this.observer?.disconnect();
      this.#detachScroll();
      this.notify?.('translate error', 'error');
    }

    #chatEndpoint(baseUrl) {
      const value = baseUrl.replace(/\/+$/, '');
      return value.endsWith('/chat/completions') ? value : value + '/chat/completions';
    }

    #escapeHtml(value) {
      return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    }

    #serializeBlock(block, blockIndex) {
      const segments = block.segments.map((segment, segmentIndex) =>
        `<span data-rv-seg="${segmentIndex}">${this.#escapeHtml(segment.text)}</span>`
      ).join(' ');
      return `<div data-rv-block="${blockIndex}">${segments}</div>`;
    }

    #parseMarkup(markup, blocks) {
      const template = this.doc.createElement('template');
      template.innerHTML = markup;

      return blocks.map((block, blockIndex) => {
        const root = template.content.querySelector(`[data-rv-block="${blockIndex}"]`);
        return block.segments.map((segment, segmentIndex) => {
          const output = root?.querySelector(`[data-rv-seg="${segmentIndex}"]`);
          return output ? output.textContent : null;
        });
      });
    }

    #googleUrl(markups) {
      const endpoint = new URL(GOOGLE_ENDPOINT);
      endpoint.searchParams.set('client', 'dict-chrome-ex');
      endpoint.searchParams.set('sl', 'auto');
      endpoint.searchParams.set('tl', 'zh-CN');
      markups.forEach(markup => endpoint.searchParams.append('q', markup));
      return endpoint;
    }

    async #translateGoogle(blocks) {
      const output = Array(blocks.length);
      let indexes = [];
      let markups = [];

      const flush = async () => {
        if (indexes.length === 0) {
          return;
        }
        const response = await this.request(this.#googleUrl(markups).href);
        if (!response.ok || !Array.isArray(response.data)) {
          throw new Error('Google Translate request failed');
        }
        indexes.forEach((blockIndex, responseIndex) => {
          const markup = response.data[responseIndex]?.[0];
          output[blockIndex] = typeof markup === 'string' ?
            this.#parseMarkup(markup, [blocks[blockIndex]])[0] :
            blocks[blockIndex].segments.map(() => null);
        });
        indexes = [];
        markups = [];
      };

      for (let index = 0; index < blocks.length; index += 1) {
        const markup = this.#serializeBlock(blocks[index], 0);
        const candidate = [...markups, markup];
        if (markups.length && this.#googleUrl(candidate).href.length > MAX_GOOGLE_URL_LENGTH) {
          await flush();
        }
        indexes.push(index);
        markups.push(markup);
      }
      await flush();
      return output;
    }

    #apiInput(blocks) {
      return {
        blocks: blocks.map((block, blockIndex) => ({
          id: blockIndex,
          segments: block.segments.map((segment, segmentIndex) => ({
            id: segmentIndex,
            text: segment.text
          }))
        }))
      };
    }

    #parseApiOutput(content, blocks) {
      const value = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const start = value.indexOf('{');
      const end = value.lastIndexOf('}');
      if (start === -1 || end < start) {
        return blocks.map(block => block.segments.map(() => null));
      }

      let json;
      try {
        json = JSON.parse(value.slice(start, end + 1));
      }
      catch (e) {
        return blocks.map(block => block.segments.map(() => null));
      }
      const output = Array.isArray(json.blocks) ? json.blocks : [];
      return blocks.map((block, blockIndex) => {
        const translatedBlock = output.find(item => Number(item.id) === blockIndex);
        const segments = Array.isArray(translatedBlock?.segments) ? translatedBlock.segments : [];
        return block.segments.map((segment, segmentIndex) => {
          const translatedSegment = segments.find(item => Number(item.id) === segmentIndex);
          return typeof translatedSegment?.text === 'string' ? translatedSegment.text : null;
        });
      });
    }

    #reasoningControl(baseUrl, model) {
      let hostname = '';
      try {
        hostname = new URL(baseUrl).hostname;
      }
      catch (e) {}
      if (hostname.includes('openrouter.ai') || model.startsWith('deepseek/')) {
        return {
          reasoning: {
            enabled: false
          }
        };
      }
      if (hostname.includes('deepseek.com') || model === 'deepseek-flash' || model.startsWith('deepseek-v4')) {
        return {
          thinking: {
            type: 'disabled'
          }
        };
      }
      return {};
    }

    async #translateApi(blocks) {
      const baseUrl = this.prefs['translate-api-base-url'];
      const key = this.prefs['translate-api-key'];
      const model = this.prefs['translate-api-model'];
      if (!baseUrl || !key || !model) {
        throw new Error('API Translate is not configured');
      }

      const input = this.#apiInput(blocks);
      const endpoint = this.#chatEndpoint(baseUrl);
      const controls = this.#reasoningControl(baseUrl, model);
      const body = {
        model,
        messages: [{
          role: 'system',
          content: 'You are a professional translation engine. Translate every text field into Simplified Chinese. Use all blocks as shared context for terminology and tone. Preserve every numeric block id and segment id. Return only one valid JSON object with exactly the same shape as the input. Do not explain or add fields.'
        }, {
          role: 'user',
          content: JSON.stringify(input)
        }],
        temperature: 0,
        stream: false,
        ...controls
      };
      const send = payload => this.request(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer ' + key
        },
        body: JSON.stringify(payload)
      });

      let response = await send(body);
      if (response.status === 400 && Object.keys(controls).length) {
        response = await send({
          ...body,
          reasoning: undefined,
          thinking: undefined
        });
      }
      const content = response.data?.choices?.[0]?.message?.content;
      if (!response.ok || typeof content !== 'string') {
        throw new Error('API Translate request failed');
      }
      return this.#parseApiOutput(content, blocks);
    }

    #translate(blocks) {
      if (this.prefs['translate-provider'] === 'api') {
        return this.#translateApi(blocks);
      }
      if (this.prefs['translate-provider'] === 'google') {
        return this.#translateGoogle(blocks);
      }
      return Promise.reject(new Error('Translate provider is not implemented'));
    }

    #targetForNode(node) {
      return node.parentElement.closest(BLOCK_SELECTOR) || node.parentElement;
    }

    #translatableNodes(element) {
      const nodes = [];
      const walker = this.doc.createTreeWalker(element, this.view.NodeFilter.SHOW_TEXT);
      let node;

      while ((node = walker.nextNode())) {
        if (
          this.translated.has(node) === false &&
          node.parentElement?.closest(SKIP_SELECTOR) === null &&
          this.#targetForNode(node) === element &&
          /\p{L}/u.test(node.nodeValue)
        ) {
          nodes.push(node);
        }
      }
      return nodes;
    }

    #createBlock(element) {
      const segments = this.#translatableNodes(element).map(node => {
        const raw = node.nodeValue;
        const text = raw.trim();
        const start = raw.indexOf(text);
        return {
          node,
          raw,
          text,
          prefix: raw.slice(0, start),
          suffix: raw.slice(start + text.length)
        };
      }).filter(segment => segment.text);

      return {
        element,
        segments,
        length: segments.reduce((total, segment) => total + segment.text.length, 0)
      };
    }

    #nextBatch() {
      const batch = [];
      let length = 0;

      while (this.pending.length && batch.length < MAX_BLOCKS) {
        const element = this.pending[0];
        const block = this.#createBlock(element);
        if (block.segments.length === 0) {
          this.pending.shift();
          this.queued.delete(element);
          continue;
        }
        if (batch.length && length + block.length > MAX_BATCH_LENGTH) {
          break;
        }
        this.pending.shift();
        batch.push(block);
        length += block.length;
      }
      return batch;
    }

    #applyBlock(block, output) {
      let complete = Array.isArray(output) && output.length === block.segments.length;

      block.segments.forEach((segment, index) => {
        const translated = output?.[index];
        if (typeof translated !== 'string') {
          complete = false;
          return;
        }
        if (segment.node.isConnected && segment.node.nodeValue === segment.raw) {
          segment.node.nodeValue = segment.prefix + translated + segment.suffix;
          this.translated.add(segment.node);
        }
        else {
          complete = false;
        }
      });
      this.queued.delete(block.element);
      return complete;
    }

    async #drain() {
      if (this.running || this.stopped) {
        return;
      }
      this.running = true;
      let partial = false;

      try {
        while (this.pending.length && this.stopped === false) {
          const blocks = this.#nextBatch();
          if (blocks.length === 0) {
            continue;
          }
          const output = await this.#translate(blocks);
          blocks.forEach((block, index) => {
            partial = this.#applyBlock(block, output[index]) === false || partial;
          });
        }
        if (partial) {
          this.notify?.('translate error', 'error');
        }
      }
      catch (e) {
        this.#fail();
      }
      finally {
        this.running = false;
        if (this.pending.length && this.stopped === false) {
          this.#scheduleDrain();
        }
      }
    }

    #scheduleDrain() {
      this.view.clearTimeout(this.drainTimer);
      this.drainTimer = this.view.setTimeout(() => this.#drain(), 100);
    }

    #queueTarget(target) {
      if (this.queued.has(target) || this.#translatableNodes(target).length === 0) {
        return false;
      }
      this.queued.add(target);
      this.pending.push(target);
      return true;
    }

    #scanViewport() {
      if (this.stopped) {
        return;
      }
      const height = this.view.innerHeight || this.doc.documentElement.clientHeight;
      let queued = false;

      for (const target of this.targets || []) {
        if (target.isConnected === false) {
          continue;
        }
        const rect = target.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < height) {
          queued = this.#queueTarget(target) || queued;
        }
      }
      if (queued) {
        this.#scheduleDrain();
      }
    }

    #attachScroll() {
      this.#detachScroll();
      this.scrollHandler = () => {
        this.view.clearTimeout(this.scrollTimer);
        this.scrollTimer = this.view.setTimeout(() => this.#scanViewport(), 100);
      };
      this.view.addEventListener('scroll', this.scrollHandler, {passive: true});
    }

    #detachScroll() {
      this.view.clearTimeout(this.scrollTimer);
      if (this.scrollHandler) {
        this.view.removeEventListener('scroll', this.scrollHandler);
        this.scrollHandler = undefined;
      }
    }

    #collectTargets() {
      const targets = new Set();
      const roots = [
        this.doc.getElementById('reader-title'),
        this.doc.getElementById('reader-credits'),
        this.doc.getElementById('reader-estimated-time'),
        this.doc.getElementById('published-time'),
        this.doc.getElementById('reader-content'),
        ...this.doc.querySelectorAll('.page')
      ].filter(Boolean);

      for (const root of roots) {
        const walker = this.doc.createTreeWalker(root, this.view.NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (/\p{L}/u.test(node.nodeValue) === false || node.parentElement?.closest(SKIP_SELECTOR)) {
            continue;
          }
          const target = this.#targetForNode(node);
          if (target) {
            targets.add(target);
          }
        }
      }
      return targets;
    }

    start = () => {
      const now = Date.now();
      if (this.running || now - this.lastStartAt < 800) {
        return;
      }
      this.lastStartAt = now;
      this.stopped = false;
      this.pending.length = 0;
      this.queued.clear();
      this.view.clearTimeout(this.drainTimer);
      this.observer?.disconnect();
      this.#detachScroll();

      if (this.prefs['translate-provider'] === 'api' && (
        !this.prefs['translate-api-base-url'] ||
        !this.prefs['translate-api-key'] ||
        !this.prefs['translate-api-model']
      )) {
        this.#fail();
        return;
      }

      this.observer = new this.view.IntersectionObserver(entries => {
        let queued = false;
        for (const entry of entries) {
          if (entry.isIntersecting === false) {
            continue;
          }
          this.observer.unobserve(entry.target);
          queued = this.#queueTarget(entry.target) || queued;
        }
        if (queued) {
          this.#scheduleDrain();
        }
      }, {
        root: null,
        threshold: 0.01
      });

      this.targets = [...this.#collectTargets()];
      for (const target of this.targets) {
        this.observer.observe(target);
      }
      this.#attachScroll();
      this.#scanViewport();
    };

    #matchesAutoHost() {
      if (this.prefs['translate-auto'] === false) {
        return false;
      }
      try {
        const hostname = new URL(this.url).hostname.toLowerCase().replace(/^www\./, '');
        return this.prefs['translate-hosts'].some(host => hostname === host || hostname.endsWith('.' + host));
      }
      catch (e) {
        return false;
      }
    }

    #addControl() {
      const style = this.controlDocument.createElement('style');
      style.id = 'translate-styling';
      style.textContent = `
        #translate-control {
          position: fixed;
          z-index: 2147483647;
          top: 0;
          right: 0;
          width: 144px;
          height: 80px;
          display: grid;
          place-items: center;
          opacity: 0;
          transition: opacity 120ms ease-in-out;
        }
        #translate-control:hover,
        #translate-control:focus-within {
          opacity: 1;
        }
        #translate-control button {
          -webkit-appearance: none;
          appearance: none;
          border: 0;
          border-radius: 4px;
          padding: 8px 12px;
          color: color-mix(in srgb, var(--fg) 72%, transparent);
          background: rgba(255, 255, 255, 0.08);
          box-shadow: none;
          cursor: pointer;
          font: inherit;
        }
      `;
      this.controlDocument.head.appendChild(style);

      this.control = this.controlDocument.createElement('div');
      this.control.id = 'translate-control';
      const button = this.controlDocument.createElement('button');
      button.type = 'button';
      button.textContent = 'translate';
      button.addEventListener('click', event => {
        if (event.detail) {
          button.blur();
        }
        this.start();
      });
      this.control.appendChild(button);
      this.controlDocument.body.appendChild(this.control);
    }

    enable() {
      this.#addControl();
      if (this.#matchesAutoHost()) {
        this.start();
      }
    }

    disable() {
      this.stopped = true;
      this.pending.length = 0;
      this.queued.clear();
      this.view.clearTimeout(this.drainTimer);
      this.observer?.disconnect();
      this.#detachScroll();
      this.control?.remove();
      this.controlDocument.getElementById('translate-styling')?.remove();
    }
  }

  self.TranslateEngine = TranslateEngine;
})();
