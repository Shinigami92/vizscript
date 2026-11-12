import type { MeasureText, NodeComment } from '@vizscript/core';

/** Laid out text of a comment bubble above a node. */
export interface BubbleLayout {
  lines: string[];
  width: number;
  height: number;
}

export const BUBBLE_PADDING_X = 8;
export const BUBBLE_PADDING_Y = 5;
export const BUBBLE_LINE_HEIGHT = 16;
/** Gap between the bubble and its node (room for the tail). */
export const BUBBLE_GAP = 9;
/** Padding of a comment box around its nodes. */
export const COMMENT_BOX_PADDING = 16;
/** Height of a comment box title bar. */
export const COMMENT_BOX_HEADER = 28;
/** Room a comment box needs above its topmost nodes. */
export const COMMENT_BOX_TOP = COMMENT_BOX_PADDING + COMMENT_BOX_HEADER;

/**
 * Text shown in a node's bubble: doc comments stop at their first tag
 * (`@param`, `@example`, …) like hover summaries in editors.
 */
export function bubbleText(comment: NodeComment | undefined): string {
  if (!comment) {
    return '';
  }

  const text = comment.text.trim();
  const tag = text.search(/^@\w/m);
  const summary = tag > 0 ? text.slice(0, tag).trim() : '';
  return summary || text;
}

/**
 * Wraps a comment to at most `maxLines` lines of `maxWidth` (text width).
 * Overlong text ends with an ellipsis.
 */
export function layoutBubble(
  text: string,
  measure: MeasureText,
  maxWidth = 260,
  maxLines = 4
): BubbleLayout {
  const lines: string[] = [];
  let truncated = false;
  outer: for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && measure(candidate, 'label') > maxWidth) {
        lines.push(line);
        line = word;
        if (lines.length === maxLines) {
          truncated = true;
          break outer;
        }
      } else {
        line = candidate;
      }
    }

    lines.push(line);
    if (lines.length === maxLines) {
      truncated = true;
      break;
    }
  }

  if (truncated && lines.length === maxLines) {
    const rest = text.split(/\s+/).join(' ');
    const shown = lines.join(' ');
    if (rest.length > shown.length) {
      lines[maxLines - 1] = `${lines[maxLines - 1] ?? ''}…`;
    }
  }

  // Lines that are still too long (one long word) are cut.
  const fitted = lines.map((line) => {
    let result = line;
    while (result.length > 1 && measure(result, 'label') > maxWidth) {
      result = `${result.slice(0, -2)}…`;
    }

    return result;
  });
  const textWidth = Math.max(
    24,
    ...fitted.map((line) => measure(line, 'label'))
  );
  return {
    lines: fitted,
    width: Math.ceil(textWidth + BUBBLE_PADDING_X * 2),
    height: fitted.length * BUBBLE_LINE_HEIGHT + BUBBLE_PADDING_Y * 2,
  };
}
