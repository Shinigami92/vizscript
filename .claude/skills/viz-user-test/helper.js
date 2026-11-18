// Injected into the page (page.addInitScript): finds nodes, pins and inline
// values of the graph by the labels of its accessible DOM
// (`[data-ui=graph-a11y]`), so clicks and drags hit what was meant.
// Everything but `code()` works with production builds too.
(() => {
  const root = () => document.querySelector('[data-ui=graph-a11y]');
  const label = (el) => el.getAttribute('aria-label') ?? '';
  const center = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  /** What's on top of a point: null for the graph canvas. */
  const coverAt = (x, y) => {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
      return 'outside the window';
    }

    const hit = document.elementFromPoint(x, y);
    if (hit?.closest('[data-ui=graph-canvas]') && hit.tagName === 'CANVAS') {
      return null;
    }

    return (
      hit?.closest('[data-ui]')?.getAttribute('data-ui') ??
      hit?.tagName ??
      'nothing'
    );
  };
  const matches = (text, query) =>
    query instanceof RegExp ? query.test(text) : text === query;
  const pick = (list, query, what) => {
    const exact = list.filter((el) => matches(label(el), query));
    // A string also matches the start of a label ("arg0" → "arg0, number, input").
    const found =
      exact.length > 0 || query instanceof RegExp
        ? exact
        : list.filter((el) => label(el).startsWith(`${query},`));
    if (found.length === 1) {
      return found[0];
    }

    const names = list.map(label);
    throw new Error(
      found.length === 0
        ? `no ${what} "${query}"; there are: ${names.join(' | ')}`
        : `${found.length} ${what}s match "${query}": ${found.map(label).join(' | ')}; use a node id or a RegExp`
    );
  };
  const node = (query) => {
    const nodes = [...root().querySelectorAll('[data-node-id]')];
    const byId = nodes.find((el) => el.dataset.nodeId === query);
    return byId ?? pick(nodes, query, 'node');
  };

  window.__viz = {
    /**
     * The whole code of the open file (Monaco renders only the visible
     * lines). Reads the editor through Vue's dev handle: dev server only.
     */
    code() {
      const el = document.querySelector('[data-ui=code-editor]');
      return el?.__vueParentComponent?.setupState.editor?.getValue() ?? null;
    },

    /** One line per node on screen: label @x,y (client), then its parts. */
    nodes({ parts = true, offscreen = false } = {}) {
      return [...root().querySelectorAll('[data-node-id]')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          const on =
            r.right > 0 &&
            r.bottom > 0 &&
            r.left < innerWidth &&
            r.top < innerHeight;
          if (!on && !offscreen) {
            return null;
          }

          const head = `${label(el)} @${Math.round(r.left)},${Math.round(r.top)} [${el.dataset.nodeId}]`;
          return parts
            ? `${head}\n  ${[...el.children].map(label).join('; ')}`
            : head;
        })
        .filter(Boolean)
        .join('\n');
    },

    /**
     * Client point of a node's header, or of one of its parts: a pin
     * ("person", "a, string, input"), "Value of …" or "Add pin". Throws
     * when nothing or several things match; `covered` names what's on top.
     */
    at(nodeQuery, partQuery) {
      const n = node(nodeQuery);
      let p;
      if (partQuery === undefined) {
        const r = n.getBoundingClientRect();
        const zoom = r.height / parseFloat(n.style.height);
        p = {
          x: r.left + Math.min(40 * zoom, r.width / 2),
          y: r.top + 8 * zoom,
        };
      } else {
        p = center(pick([...n.children], partQuery, 'part'));
      }

      return { ...p, covered: coverAt(p.x, p.y) };
    },
  };
})();
