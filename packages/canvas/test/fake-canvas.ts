/**
 * A 2D context that records the texts it fills; every other call does
 * nothing, gradients and measurements return what the canvas would.
 */
export function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  texts: string[];
} {
  const texts: string[] = [];
  const state: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) {
        return target[key];
      }

      switch (key) {
        case 'fillText': {
          return (text: string) => texts.push(text);
        }

        case 'measureText': {
          return (text: string) => ({ width: text.length * 7 });
        }

        case 'createLinearGradient':
        case 'createRadialGradient': {
          return () => ({ addColorStop: () => undefined });
        }

        case 'getLineDash': {
          return () => [];
        }

        default: {
          return () => undefined;
        }
      }
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts };
}
