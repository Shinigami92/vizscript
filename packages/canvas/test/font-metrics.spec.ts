import { describe, expect, it } from 'vitest';
import { FontMetrics, fontOf } from '../src/font-metrics';
import type { TextMeasurer } from '../src/font-metrics';

const SANS = { fontFamily: 'Sans', monoFontFamily: 'Mono' };

/** Measures 7 px per character in Sans and 8 in other fonts. */
function fakeMeasurer(): TextMeasurer & { calls: string[] } {
  const calls: string[] = [];
  return {
    font: '',
    calls,
    measureText(text: string): { width: number } {
      calls.push(`${this.font}|${text}`);
      return {
        width: text.length * (this.font.endsWith('Sans') ? 7 : 8),
      };
    },
  };
}

describe('fontOf', () => {
  it('uses the mono family only for literals', () => {
    expect(fontOf('title', SANS)).toBe('600 13px Sans');
    expect(fontOf('subtitle', SANS)).toBe('italic 11px Sans');
    expect(fontOf('literal', SANS)).toBe('12px Mono');
    expect(fontOf('glyph', SANS)).toBe('700 26px Sans');
  });
});

describe('FontMetrics', () => {
  it('measures in the style’s font and caches per style and text', () => {
    const measurer = fakeMeasurer();
    const metrics = new FontMetrics(measurer, SANS);
    expect(metrics.measure('abc', 'label')).toBe(21);
    expect(metrics.measure('abc', 'label')).toBe(21);
    expect(metrics.measure('abc', 'literal')).toBe(24);
    expect(measurer.calls).toEqual(['12px Sans|abc', '12px Mono|abc']);
  });

  it('measures again only when a theme changes the fonts', () => {
    const measurer = fakeMeasurer();
    const metrics = new FontMetrics(measurer, SANS);
    metrics.measure('ab', 'label');
    metrics.setTheme({ ...SANS });
    metrics.measure('ab', 'label');
    expect(measurer.calls).toHaveLength(1);

    metrics.setTheme({ fontFamily: 'Serif', monoFontFamily: 'Mono' });
    expect(metrics.font('label')).toBe('12px Serif');
    expect(metrics.measure('ab', 'label')).toBe(16);
    expect(measurer.calls).toHaveLength(2);
  });
});
