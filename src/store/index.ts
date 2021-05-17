import { createStore, Store } from 'vuex';

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface RootState {}

const store: Store<RootState> = createStore({
  state: {},
  mutations: {},
  actions: {},
  modules: {}
});

export default store;
