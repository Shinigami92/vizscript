import Ast from '@/views/Ast.vue';
import Code from '@/views/Code.vue';
import Viz from '@/views/Viz.vue';
import type { Router, RouteRecordRaw } from 'vue-router';
import { createRouter, createWebHashHistory } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/code',
    name: 'code',
    component: Code,
  },
  {
    path: '/viz',
    name: 'viz',
    component: Viz,
  },
  {
    path: '/ast',
    name: 'ast',
    component: Ast,
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: 'code',
  },
];

const router: Router = createRouter({
  history: createWebHashHistory(
    import.meta.env.PROD ? '/vizscript/' : undefined,
  ),
  routes,
});

export default router;
