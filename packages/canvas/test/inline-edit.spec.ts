import type { GraphDocument, MeasureText } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { BUBBLE_GAP } from '../src/bubble';
import { COMMENT_HEADER } from '../src/graph-view-constants';
import { clientRect, commentEdit, literalEdit } from '../src/inline-edit';
import { Scene } from '../src/scene';

const measure: MeasureText = (text) => text.length * 7;

const DOC: GraphDocument = {
  language: 'test',
  diagnostics: [],
  functions: [
    {
      id: 'main',
      name: 'main',
      range: { start: 0, end: 0 },
      nodes: [
        {
          id: 'said',
          kind: 'call',
          category: 'function',
          purity: 'impure',
          title: 'say',
          range: { start: 0, end: 0 },
          path: 'said',
          comment: { text: 'Greets', range: { start: 0, end: 0 } },
          pins: [
            {
              id: 'text',
              name: 'text',
              direction: 'in',
              kind: 'data',
              type: 'string',
              literal: {
                kind: 'string',
                value: 'hi',
                raw: "'hi'",
                editable: true,
              },
            },
          ],
        },
        {
          id: 'quiet',
          kind: 'call',
          category: 'function',
          purity: 'impure',
          title: 'quiet',
          range: { start: 0, end: 0 },
          path: 'quiet',
          pins: [],
        },
      ],
      edges: [],
      comments: [
        {
          id: 'box',
          title: 'Talk',
          range: { start: 0, end: 0 },
          titleRange: { start: 0, end: 0 },
          markers: [
            { start: 0, end: 0 },
            { start: 0, end: 0 },
          ],
          nodes: ['said'],
        },
      ],
    },
  ],
};

function scene(): Scene {
  const s = new Scene(measure);
  s.load(DOC, { said: { x: 100, y: 200 }, quiet: { x: 500, y: 200 } });
  return s;
}

describe('commentEdit', () => {
  it('edits a bubble where it is, at least 220 × 60', () => {
    const s = scene();
    const edit = commentEdit(s, { kind: 'node', nodeId: 'said' });
    expect(edit?.value).toBe('Greets');
    expect(edit?.world).toMatchObject({ x: 100, width: 220, height: 60 });
    expect((edit?.world.y ?? 0) + 60).toBeLessThanOrEqual(200 - BUBBLE_GAP);
  });

  it('makes room above a node without a comment', () => {
    const edit = commentEdit(scene(), { kind: 'node', nodeId: 'quiet' });
    expect(edit).toEqual({
      value: '',
      world: { x: 500, y: 200 - BUBBLE_GAP - 60, width: 220, height: 60 },
    });
  });

  it('edits a comment box title in its header', () => {
    const edit = commentEdit(scene(), { kind: 'box', boxId: 'box' });
    expect(edit?.value).toBe('Talk');
    expect(edit?.world.height).toBe(COMMENT_HEADER);
    expect(commentEdit(scene(), { kind: 'box', boxId: 'nope' })).toBeNull();
  });
});

describe('literalEdit', () => {
  it('edits an unwired value where it is drawn', () => {
    const s = scene();
    const ns = s.nodes.get('said');
    const pg = ns?.geom.pins.get('text');
    if (!ns || !pg) {
      throw new Error('said.text');
    }

    expect(literalEdit(s, ns, pg)).toEqual({
      world: s.literalRect(ns, pg),
      value: 'hi',
      kind: 'string',
    });
  });
});

describe('clientRect', () => {
  it('places a world rectangle in the page', () => {
    expect(
      clientRect(
        { x: 100, y: 50, zoom: 2 },
        { left: 10, top: 20 },
        { x: 110, y: 60, width: 30, height: 5 }
      )
    ).toEqual({ x: 30, y: 40, width: 60, height: 10 });
  });
});
