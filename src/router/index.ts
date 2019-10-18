import Ast from '@/views/Ast.vue';
import Code from '@/views/Code.vue';
import Viz from '@/views/Viz.vue';
import Vue from 'vue';
import VueRouter from 'vue-router';

Vue.use(VueRouter);

const routes = [
  {
    path: '/code',
    name: 'code',
    component: Code
  },
  {
    path: '/viz',
    name: 'viz',
    component: Viz
  },
  {
    path: '/ast',
    name: 'ast',
    component: Ast
  },
  {
    path: '*',
    redirect: 'code'
  }
];

const router = new VueRouter({
  mode: 'history',
  base: process.env.BASE_URL,
  routes
});

export default router;
