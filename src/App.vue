<template>
  <div id="app">
    <div id="main-control"></div>
    <div id="sidenav-left">
      <div class="title">Explorer</div>
      <div class="content"></div>
    </div>
    <div id="main-view">
      <div id="main-toolbar"></div>
      <div id="main-container">
        <router-view />
      </div>
    </div>
  </div>
</template>

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
}

#main-container {
  height: calc(100vh - #{$main-toolbar-height});
  overflow-y: auto;
}
</style>
