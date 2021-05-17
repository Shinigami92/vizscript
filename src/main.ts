import 'prismjs';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-typescript';
import 'prismjs/themes/prism-okaidia.css';
import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import store from './store';

createApp(App).use(router).use(store).mount('#app');
