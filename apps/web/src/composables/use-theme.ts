import type { ColorScheme } from '@vizscript/core';
import type { BasicColorSchema } from '@vueuse/core';
import { createGlobalState, useColorMode } from '@vueuse/core';
import type { ComputedRef, Ref } from 'vue';
import { computed, watch } from 'vue';

/** Also read by the inline script in `index.html` (no flash on load). */
export const COLOR_SCHEME_KEY = 'vizscript:color-scheme';

const THEME_COLORS: Record<ColorScheme, string> = {
  dark: '#161618',
  light: '#f4f4f5',
};

export interface ThemeState {
  /** The user's choice: follow the system, or always light / dark. */
  preference: Ref<BasicColorSchema>;
  /** The scheme in effect. */
  scheme: ComputedRef<ColorScheme>;
}

/**
 * Light or dark mode. Sets the `light` / `dark` class on `<html>`; light
 * mode swaps the color scales (see `uno.config.ts`).
 */
export const useTheme = createGlobalState((): ThemeState => {
  const mode = useColorMode({
    storageKey: COLOR_SCHEME_KEY,
    disableTransition: true,
  });
  const scheme = computed<ColorScheme>(() =>
    mode.state.value === 'light' ? 'light' : 'dark'
  );

  watch(
    scheme,
    (value) => {
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', THEME_COLORS[value]);
    },
    { immediate: true }
  );

  return { preference: mode.store, scheme };
});
