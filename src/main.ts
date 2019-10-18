import Vue from 'vue';
// @ts-ignore
import VueHighlightJS from 'vue-highlightjs';
import 'highlight.js/styles/atom-one-dark.css';
import App from './App.vue';
import './registerServiceWorker';
import router from './router';
import store from './store';

Vue.config.productionTip = false;

Vue.use(VueHighlightJS);

new Vue({
  router,
  store,
  render: (h) => h(App)
}).$mount('#app');
