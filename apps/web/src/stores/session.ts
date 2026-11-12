import type { MeResponse, ProviderId } from '@vizscript/api-contract';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, ApiError } from '../api/client';

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

  return { me, loaded, load, ensureLoaded, login, logout };
});
