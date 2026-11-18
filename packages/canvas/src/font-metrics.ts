import type { MeasureText, TextStyle } from '@vizscript/core';
import type { Theme } from './theme';

/** The part of a 2D context that measures text. */
export interface TextMeasurer {
  font: string;
  measureText(text: string): { width: number };
}

/** The CSS font of a text style in a theme's font families. */
export function fontOf(
  style: TextStyle,
  theme: Pick<Theme, 'fontFamily' | 'monoFontFamily'>
): string {
  const family = theme.fontFamily;
  switch (style) {
    case 'title': {
      return `600 13px ${family}`;
    }

    case 'subtitle': {
      return `italic 11px ${family}`;
    }

    case 'label': {
      return `12px ${family}`;
    }

    case 'literal': {
      return `12px ${theme.monoFontFamily}`;
    }

    case 'compact': {
      return `600 14px ${family}`;
    }

    case 'glyph': {
      return `700 26px ${family}`;
    }
  }
}

/** Fonts of the canvas and text widths, measured once per style and text. */
export class FontMetrics {
  private readonly cache = new Map<string, number>();
  private families: Pick<Theme, 'fontFamily' | 'monoFontFamily'>;

  public constructor(
    private readonly measurer: TextMeasurer,
    theme: Pick<Theme, 'fontFamily' | 'monoFontFamily'>
  ) {
    this.families = theme;
  }

  /** Follows a theme's fonts; widths are measured again if they differ. */
  public setTheme(theme: Pick<Theme, 'fontFamily' | 'monoFontFamily'>): void {
    if (
      theme.fontFamily !== this.families.fontFamily ||
      theme.monoFontFamily !== this.families.monoFontFamily
    ) {
      this.cache.clear();
    }

    this.families = theme;
  }

  public font(style: TextStyle): string {
    return fontOf(style, this.families);
  }

  public readonly measure: MeasureText = (text, style) => {
    const key = `${style}\u0000${text}`;
    let width = this.cache.get(key);
    if (width === undefined) {
      this.measurer.font = this.font(style);
      width = this.measurer.measureText(text).width;
      this.cache.set(key, width);
    }

    return width;
  };
}
