import type { MeResponse, ProviderId } from '@vizscript/api-contract';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, ApiError, setAuthErrorHandler } from '../api/client';
import { useToasts } from '../composables/use-toasts';

export const useSessionStore = defineStore('session', () => {
  const me = ref<MeResponse | null>(null);
  const loaded = ref(false);

  async function load(): Promise<void> {
    try {
      me.value = await api.me();
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        console.error(error);
      }

      me.value = null;
    } finally {
      loaded.value = true;
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (!loaded.value) {
      await load();
    }
  }

  async function login(provider: ProviderId, token: string): Promise<void> {
    me.value = await api.loginWithToken(provider, token);
    loaded.value = true;
  }

  async function logout(): Promise<void> {
    try {
      await api.logout();
    } finally {
      me.value = null;
    }
  }

  // A session or token that stopped working while signed in: signed out,
  // and told why (otherwise the app would quietly act signed out).
  const { show } = useToasts();
  setAuthErrorHandler((code) => {
    if (!me.value) {
      return;
    }

    if (
      code === 'provider_token_invalid' ||
      code === 'provider_token_missing'
    ) {
      show(
        'GitHub no longer accepts your token (it expired or was revoked). Sign in again with a new token.',
        'error'
      );
      void logout().catch(() => undefined);
    } else {
      me.value = null;
      show(
        'Your sign-in has expired. Sign in again to see private repositories and change shared layouts.',
        'error'
      );
    }
  });

  return { me, loaded, load, ensureLoaded, login, logout };
});
