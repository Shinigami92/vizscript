import DOMPurify from 'dompurify';
import type { MarkdownIt } from 'markdown-it';
import markdownIt from 'markdown-it';

/** How links and images of a document are resolved. */
export interface MarkdownEnv {
  /** Returns the URL for a link; `internal` links open inside the app. */
  resolveLink: (href: string) => { href: string; internal: boolean };
  resolveImage: (src: string) => string;
}

/** GitHub style heading anchor: `Quick start!` → `quick-start`. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s_-]/gu, '')
    .replaceAll(/\s/g, '-');
}

function createRenderer(): MarkdownIt {
  const md = markdownIt({ html: true, linkify: true });

  // Source lines on block elements: scroll sync and "jump to line".
  md.core.ruler.push('source_lines', (state) => {
    for (const token of state.tokens) {
      if (token.map && token.nesting !== -1 && token.block) {
        token.attrSet('data-line', String(token.map[0] + 1));
      }
    }
  });

  // Heading ids like GitHub, so `#section` links work.
  md.core.ruler.push('heading_ids', (state) => {
    const seen = new Map<string, number>();
    state.tokens.forEach((token, i) => {
      if (token.type !== 'heading_open') {
        return;
      }

      const base = slugify(state.tokens[i + 1]?.content ?? '') || 'section';
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      token.attrSet('id', count === 0 ? base : `${base}-${count}`);
    });
  });

  // GitHub task lists: `- [x] done`.
  md.core.ruler.push('task_lists', (state) => {
    state.tokens.forEach((token, i) => {
      if (
        token.type !== 'inline' ||
        state.tokens[i - 2]?.type !== 'list_item_open'
      ) {
        return;
      }

      const match = token.content.match(/^\[([ xX])\]\s/);
      const first = token.children?.[0];
      if (!match || first?.type !== 'text') {
        return;
      }

      first.content = first.content.slice(match[0].length);
      const checkbox = new state.Token('html_inline', '', 0);
      checkbox.content = `<input type="checkbox" disabled${match[1] === ' ' ? '' : ' checked'}> `;
      token.children?.unshift(checkbox);
      state.tokens[i - 2]?.attrJoin('class', 'task-list-item');
    });
  });

  return md;
}

let renderer: MarkdownIt | undefined;
/** Resolver of the document being sanitized (DOMPurify hooks are global). */
let currentEnv: MarkdownEnv | undefined;

function installHooks(): void {
  // Links and images are resolved after sanitizing, so this also covers
  // raw HTML like `<img src="docs/logo.png">` in READMEs.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const env = currentEnv;
    if (!env) {
      return;
    }

    if (node.tagName === 'A' && node.hasAttribute('href')) {
      const resolved = env.resolveLink(node.getAttribute('href') ?? '');
      node.setAttribute('href', resolved.href);
      if (resolved.internal) {
        node.setAttribute('data-internal', 'true');
      } else if (/^https?:/i.test(resolved.href)) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    } else if (node.tagName === 'IMG' && node.hasAttribute('src')) {
      node.setAttribute(
        'src',
        env.resolveImage(node.getAttribute('src') ?? '')
      );
      node.setAttribute('loading', 'lazy');
    }
  });
}

/** Renders Markdown to sanitized HTML (raw HTML in the source is allowed). */
export function renderMarkdown(text: string, env: MarkdownEnv): string {
  if (!renderer) {
    renderer = createRenderer();
    installHooks();
  }

  currentEnv = env;
  try {
    return DOMPurify.sanitize(renderer.render(text), {
      ADD_ATTR: ['target'],
      FORBID_TAGS: ['style', 'form'],
    });
  } finally {
    currentEnv = undefined;
  }
}
