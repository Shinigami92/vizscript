/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  // eslint-disable-next-line @typescript-eslint/ban-types
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare module 'vue-prism-component' {
  import type { FunctionalComponent } from 'vue';
  const _default: FunctionalComponent<{ code?: string; language?: string }>;
  export default _default;
}
