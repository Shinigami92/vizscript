import { createRouter, createWebHistory } from 'vue-router';
import { useSessionStore } from './stores/session';

declare module 'vue-router' {
  interface RouteMeta {
    auth?: boolean;
    fullscreen?: boolean;
  }
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/repos' },
    {
      path: '/login',
      name: 'login',
      component: () => import('./views/LoginView.vue'),
    },
    {
      path: '/playground',
      name: 'playground',
      component: () => import('./views/PlaygroundView.vue'),
      meta: { fullscreen: true },
    },
    {
      path: '/local',
      name: 'local-folders',
      component: () => import('./views/LocalFoldersView.vue'),
    },
    {
      path: '/local/:id/:path(.*)*',
      name: 'local',
      component: () => import('./views/LocalProjectView.vue'),
      meta: { fullscreen: true },
    },
    {
      path: '/repos',
      name: 'repos',
      component: () => import('./views/ReposView.vue'),
    },
    {
      path: '/:provider(github)/:owner/:repo',
      name: 'repo-root',
      component: () => import('./views/RepoRootView.vue'),
    },
    {
      path: '/:provider(github)/:owner/:repo/tree/:ref/:path(.*)*',
      name: 'repo',
      component: () => import('./views/RepoView.vue'),
      meta: { fullscreen: true },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to) => {
  const session = useSessionStore();
  await session.ensureLoaded();
  if (to.meta.auth && !session.me) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }

  if (to.name === 'login' && session.me) {
    return { name: 'repos' };
  }

  return true;
});
