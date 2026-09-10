import { createRouter, createWebHistory } from 'vue-router';
import ProfilesView from '@/views/ProfilesView.vue';
import LogsView from '@/views/LogsView.vue';
import LoginView from '@/views/LoginView.vue';
import { useAppStore } from '@/stores/app';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView, meta: { public: true } },
    { path: '/', component: ProfilesView },
    { path: '/profiles', component: ProfilesView },
    { path: '/logs', component: LogsView },
    { path: '/live/:instanceId', component: () => import('@/views/DesktopPlayer.vue') },
    { path: '/desktop/:desktopId', redirect: to => `/live/${to.params.desktopId}` },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to) => {
  const store = useAppStore();
  await store.checkAuthStatus();

  if (store.needAuth) {
    if (to.path === '/login') {
      return store.isAuthenticated ? '/' : true;
    }
    if (!store.isAuthenticated) {
      return '/login';
    }
  } else {
    if (to.path === '/login') {
      return '/';
    }
  }
  return true;
});
