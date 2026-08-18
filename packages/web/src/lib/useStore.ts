import { useSyncExternalStore } from 'react';
import { store, type MeshState } from './store.js';

/** Subscribe a component to the shared realtime store. */
export function useMesh(): MeshState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export { store };
