<template>
  <div id="app">
    <div id="main-control"></div>
    <div id="sidenav-left">
      <div class="title">Explorer</div>
      <div class="content"></div>
    </div>
    <div id="main-view">
      <div id="main-toolbar">
        <div class="tabs"></div>
        <div class="actions">
          <a v-for="{ location, d } of mainToolbarActions" :key="location" @click="navigateTo(location)">
            <div class="icon">
              <svg width="24" height="24" viewBox="0 0 24 24">
                <path fill="#fff" :d="d" />
              </svg>
            </div>
          </a>
        </div>
      </div>
      <div id="main-container">
        <router-view />
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { RouteLocationRaw } from 'vue-router';

export default defineComponent({
  data: () => ({
    mainToolbarActions: [
      {
        location: 'code',
        d:
          'M8,3C6.9,3 6,3.9 6,5V9C6,10.1 5.1,11 4,11H3V13H4C5.1,13 6,13.9 6,15V19C6,20.1 6.9,21 8,21H10V19H8V14C8,12.9 7.1,12 6,12C7.1,12 8,11.1 8,10V5H10V3M16,3C17.1,3 18,3.9 18,5V9C18,10.1 18.9,11 20,11H21V13H20C18.9,13 18,13.9 18,15V19C18,20.1 17.1,21 16,21H14V19H16V14C16,12.9 16.9,12 18,12C16.9,12 16,11.1 16,10V5H14V3H16Z'
      },
      {
        location: 'viz',
        d:
          'M11.5 19.1C11.3 20.2 10.9 21 10.2 21.5C9.5 22 8.6 22.1 7.5 21.9C7.1 21.8 6.3 21.7 6 21.5L6.5 20C6.8 20.1 7.4 20.3 7.7 20.3C8.8 20.5 9.4 20 9.6 18.8L12 5.2C12.2 4 12.7 3.2 13.4 2.6C14.1 2.1 15.1 1.9 16.2 2.1C16.6 2.2 17.4 2.3 18 2.6L17.5 4C17.3 3.9 16.6 3.8 16.3 3.7C15 3.5 14.3 4.1 14 5.6L11.5 19.1Z'
      },
      {
        location: 'ast',
        d: 'M10,21V18H3L8,13H5L10,8H7L12,3L17,8H14L19,13H16L21,18H14V21H10Z'
      }
    ]
  }),
  methods: {
    navigateTo(location: RouteLocationRaw): void {
      this.$router.push(location);
    }
  }
});
</script>

<style lang="scss">
$main-control-width: 48px;
$sidenav-left-width: 300px;
$main-toolbar-height: 35px;

body {
  margin: 0;
  font-size: 13px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans',
    'Helvetica Neue', sans-serif;
}

#app {
  display: flex;
  color: rgb(227, 227, 227);
  background-color: rgb(37, 37, 38);
}

#main-control {
  background-color: rgb(33, 37, 43);
  width: $main-control-width;
  height: 100vh;
}

#sidenav-left {
  width: $sidenav-left-width;
  height: 100vh;

  .title {
    height: $main-toolbar-height;
    background-color: rgb(47, 52, 63);
    color: rgb(187, 187, 187);
    text-transform: uppercase;
  }

  .content {
    background-color: rgb(47, 52, 63);
    height: calc(100vh - #{$main-toolbar-height});
  }
}

#main-view {
  height: 100vh;
  width: calc(100vw - #{$main-control-width} - #{$sidenav-left-width});
  overflow-y: auto;
}

#main-toolbar {
  height: $main-toolbar-height;
  background-color: rgb(47, 52, 63);

  .actions {
    display: flex;
    justify-content: flex-end;
    height: inherit;

    .icon {
      display: flex;
      align-content: center;
      padding: 4px;
    }
  }
}

#main-container {
  height: calc(100vh - #{$main-toolbar-height});
  overflow-y: auto;
}
</style>
