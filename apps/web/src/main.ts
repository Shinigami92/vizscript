import 'virtual:uno.css';
import './styles.css';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { pruneStored } from './storage/browser-storage';

createApp(App).use(createPinia()).use(router).mount('#app');

// Per-file entries not used for months go, once the page has settled.
setTimeout(() => pruneStored(), 10_000);
