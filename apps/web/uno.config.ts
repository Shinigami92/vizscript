import {
  defineConfig,
  presetIcons,
  presetWind4,
  transformerDirectives,
} from 'unocss';

/** Color scales that light mode mirrors (50 ↔ 950, 100 ↔ 900 …). */
const SWAPPED_COLORS = ['zinc', 'red', 'amber', 'sky', 'purple', 'yellow'];
const SHADES = [
  '50',
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
  '900',
  '950',
];

/**
 * The UI is written for dark mode (`bg-zinc-950`, `text-amber-400` …).
 * Light mode mirrors the scales, so every class keeps its contrast. All
 * shades are declared so plain CSS can use `var(--colors-zinc-300)` too.
 */
function colorSchemeCss(colors: Record<string, unknown>): string {
  const dark: string[] = [];
  const light: string[] = [];
  for (const name of SWAPPED_COLORS) {
    const scale = colors[name] as Record<string, string> | undefined;
    if (!scale) {
      continue;
    }

    for (const [i, shade] of SHADES.entries()) {
      const mirrored = SHADES[SHADES.length - 1 - i] ?? shade;
      dark.push(`--colors-${name}-${shade}:${scale[shade]};`);
      light.push(`--colors-${name}-${shade}:${scale[mirrored]};`);
    }
  }

  return [
    `:root{${dark.join('')}}`,
    `html.light{color-scheme:light;${light.join('')}}`,
  ].join('\n');
}

export default defineConfig({
  presets: [
    presetWind4({ preflights: { reset: true } }),
    presetIcons({ scale: 1.2, extraProperties: { display: 'inline-block' } }),
  ],
  transformers: [transformerDirectives()],
  // Icon class maps live in .ts files too (view and symbol icons).
  content: {
    pipeline: {
      include: [/\.(?:vue|ts|html)(?:$|\?)/],
      exclude: [/node_modules/, /\.d\.ts$/],
    },
  },
  preflights: [
    {
      getCSS: ({ theme }) =>
        colorSchemeCss((theme as { colors: Record<string, unknown> }).colors),
    },
  ],
  shortcuts: {
    btn: 'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
    'btn-primary': 'btn bg-amber-500 text-black hover:bg-amber-400',
    'btn-ghost': 'btn text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100',
    input:
      'w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-amber-500',
    card: 'rounded-xl border border-zinc-800 bg-zinc-900/60',
  },
  theme: {
    font: {
      sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
      mono: 'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
    },
  },
});
