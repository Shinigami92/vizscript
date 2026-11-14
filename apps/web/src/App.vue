<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import RecentMenu from './components/RecentMenu.vue';
import ShortcutsDialog from './components/ShortcutsDialog.vue';
import ToastHost from './components/ToastHost.vue';
import { useShortcutsDialog } from './composables/use-shortcuts-dialog';
import { useTheme } from './composables/use-theme';
import { useSessionStore } from './stores/session';

const session = useSessionStore();
const route = useRoute();
const router = useRouter();
const fullscreen = computed(() => route.meta.fullscreen === true);
const { preference } = useTheme();
const shortcutsOpen = useShortcutsDialog();

const THEMES = {
  auto: { icon: 'i-mdi-theme-light-dark', label: 'System', next: 'light' },
  light: { icon: 'i-mdi-weather-sunny', label: 'Light', next: 'dark' },
  dark: { icon: 'i-mdi-weather-night', label: 'Dark', next: 'auto' },
} as const;
const theme = computed(() => THEMES[preference.value]);

function cycleTheme(): void {
  preference.value = theme.value.next;
}

const crumbs = computed(() => {
  if (route.name !== 'repo' && route.name !== 'repo-root') {
    return null;
  }

  return { owner: String(route.params.owner), repo: String(route.params.repo) };
});

/** What signing in adds, on the Sign in button. */
const SIGN_IN_TITLE = [
  "Signed out: public repositories only, with GitHub's limit for signed-out use (see the status bar).",
  'Your node moves, recent repositories and unsaved changes are kept in this browser only.',
  'Sign in to open private repositories and share layouts on repositories you can push to.',
].join('\n');

async function logout(): Promise<void> {
  await session.logout();
  await router.push({ name: 'login' });
}
</script>

<template>
  <div data-ui="app" class="flex h-full flex-col">
    <header
      data-ui="app-header"
      class="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-3"
    >
      <RouterLink
        to="/"
        class="flex items-center gap-2 font-semibold tracking-tight"
      >
        <img src="/favicon.svg" alt="" class="h-6 w-6" />
        <span class="hidden sm:inline">vizscript</span>
      </RouterLink>

      <nav
        v-if="crumbs"
        class="flex min-w-0 items-center gap-1 text-sm text-zinc-400"
      >
        <span class="i-mdi-chevron-right shrink-0" />
        <RouterLink to="/repos" class="hover:text-zinc-200">repos</RouterLink>
        <span class="i-mdi-chevron-right shrink-0" />
        <span class="truncate text-zinc-200"
          >{{ crumbs.owner }}/{{ crumbs.repo }}</span
        >
      </nav>
      <nav v-else class="flex items-center gap-1 text-sm">
        <RouterLink
          to="/repos"
          class="btn-ghost px-2"
          active-class="!text-zinc-50"
          >Repositories</RouterLink
        >
        <RouterLink
          to="/local"
          class="btn-ghost px-2"
          active-class="!text-zinc-50"
          >Local</RouterLink
        >
        <RouterLink
          to="/playground"
          class="btn-ghost px-2"
          active-class="!text-zinc-50"
          >Playground</RouterLink
        >
      </nav>

      <div class="ml-auto flex items-center gap-2">
        <button
          type="button"
          class="btn-ghost hidden px-2 sm:inline-flex"
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          aria-haspopup="dialog"
          @click="shortcutsOpen = true"
        >
          <span class="i-mdi-keyboard-outline" />
        </button>
        <button
          type="button"
          class="btn-ghost px-2"
          :title="`Theme: ${theme.label} (click to switch)`"
          :aria-label="`Theme: ${theme.label}`"
          @click="cycleTheme"
        >
          <span :class="theme.icon" />
        </button>
        <RecentMenu />
        <template v-if="session.me">
          <img
            v-if="session.me.avatarUrl"
            :src="session.me.avatarUrl"
            :alt="session.me.login"
            class="h-7 w-7 rounded-full border border-zinc-700"
          />
          <span class="hidden text-sm text-zinc-300 md:inline">{{
            session.me.login
          }}</span>
          <button
            type="button"
            class="btn-ghost px-2"
            title="Sign out"
            @click="logout"
          >
            <span class="i-mdi-logout" />
          </button>
        </template>
        <RouterLink
          v-else-if="route.name !== 'login'"
          data-ui="sign-in"
          :to="{ name: 'login', query: { redirect: route.fullPath } }"
          class="btn-primary"
          :title="SIGN_IN_TITLE"
          >Sign in</RouterLink
        >
      </div>
    </header>

    <main
      data-ui="app-main"
      class="min-h-0 flex-1"
      :class="fullscreen ? 'overflow-hidden' : 'overflow-auto'"
    >
      <RouterView />
    </main>
    <ToastHost />
    <ShortcutsDialog />
  </div>
</template>
