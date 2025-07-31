/*
 * @since 2020-11-04 12:43:17
 * @author acrazing <joking.young@gmail.com>
 */

import { useContext, useDebugValue, useLayoutEffect, useEffect, useReducer } from 'react';
import { __Context } from './context';
import { Selector } from './selector';
import { Dispatch, Selectable, Snapshot, Store } from './store';
import { arrayEqual, strictEqual } from './utils';

export const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' &&
  typeof window.document !== 'undefined' &&
  typeof window.document.createElement !== 'undefined'
    ? useLayoutEffect
    : useEffect;

/**
 * use context's store
 *
 * @stable
 */
export function useStore(): Store {
  const state = useContext(__Context);
  if (!state) {
    throw new Error('[Amos] you are using hooks without <Provider />.');
  }
  return state.store;
}

export function useDispatch(): Dispatch {
  const store = useStore();
  return store.dispatch;
}

export type MapSelector<Rs extends readonly Selectable[]> = {
  [P in keyof Rs]: Rs[P] extends Selectable<infer R> ? R : never;
};

interface SelectorRef {
  selectors: Selectable[];
  deps: (unknown[] | undefined)[];
  snapshots: (Snapshot | undefined)[];
  results: unknown[];
}

const defaultSelectorRef: SelectorRef = { selectors: [], deps: [], snapshots: [], results: [] };

interface StoreRef {
  store: Store;
  disposer: () => void;
  updated: boolean;
  error: any;
}

function hasSame(master: Snapshot, slave: Snapshot) {
  for (const k in master) {
    if (master.hasOwnProperty(k) && slave.hasOwnProperty(k)) {
      return true;
    }
  }
  return false;
}

function shouldSelectorRecompute(
  selector: Selector,
  store: Store,
  deps: (unknown[] | undefined)[],
  index: number,
) {
  if (!selector.factory?.deps || !deps[index]) {
    return true;
  }
  const newDeps = selector.factory.deps(store.select, ...(selector.args || []));
  const isEqual = arrayEqual(deps[index] || [], newDeps);
  deps[index] = newDeps;
  return !isEqual;
}

function compare(selector: Selector, a: unknown, b: unknown) {
  return selector.factory ? selector.factory.compare(a, b) : strictEqual(a, b);
}

function selectorChanged(
  old: Selectable | undefined,
  newly: Selector,
  snapshot: Snapshot | undefined,
  store: Store,
  deps: unknown[] | undefined,
) {
  if (!old || typeof old !== 'function' || !snapshot || !old.args || !newly.args) {
    return true;
  }
  if (!(old === newly || (newly.factory && newly.factory === old.factory))) {
    return true;
  }
  if (newly.factory?.deps === void 0) {
    return !arrayEqual(old.args, newly.args);
  }
  const newDeps = newly.factory.deps(store.select, ...newly.args);
  const isEqual = arrayEqual(deps || [], newDeps);
  return isEqual ? false : newDeps;
}

/**
 * Get the selected states according to the selectors, and rerender the
 * component when the selected states updated.
 *
 * A selector is a selectable thing, it could be one of this:
 *
 * 1. A pure function accepts `store.select` as the only one parameter
 * 2. A `Selector` which is created by `SelectorFactory`
 * 3. A `Box` instance
 *
 * If the selector is a function or a `Selector`, the selected state is its
 * return value, otherwise, when the selector is a `Box`, the selected state is
 * the state of the `Box`.
 *
 * `useSelector` accepts multiple selectors, and returns an array of the
 * selected states of the selectors.
 *
 * @example
 * ```typescript
 * const [
 *   count, // 1
 *   doubleCount, // 2
 *   tripleCount, // 3
 * ] = useSelector(
 *   countBox, // A Box
 *   selectDoubleCount, // A pure function
 *   selectMultipleCount(3), // A Selector
 * );
 * ```
 *
 * The selectors' result is cached, which means:
 *
 * 1. If a selector's dependencies is not updated, it will not be recomputed.
 * 2. If all the results of the selectors are not changed, the component will
 *    not rerender.
 *
 * If the selector is a `Selector`, it will be recomputed:
 *
 * 1. if it has no `deps` function, when its parameters changes, or the state
 *    of the boxes it depends on changes
 * 2. else, when the return value of the deps function changes. The return
 *    value should always be an array, and the compare method is compare each
 *    element of it.
 *
 * and it will be marked as changed:
 *
 * 1. if it has no `compare` function, when the result is not strict equals to
 *    the previous result.
 * 2. else if the compare function returns `false`.
 *
 * If the selector is a pure function, the cache strategy is same to a
 * `Selector` without parameter and without `deps` and `compare` function. If
 * the selector is a `Box`, the cache strategy is same to a `Selector` without
 * parameter and with `deps` as `false` and without `compare` function.
 *
 * @param selectors a selectable array
 */
interface SelectorState {
  selectorRef: SelectorRef;
  storeRef: StoreRef | undefined;
  lastState: unknown[];
  updateCount: number;
}

function selectorReducer(state: SelectorState, action: { type: 'UPDATE' }): SelectorState {
  return { ...state, updateCount: state.updateCount + 1 };
}

export function useSelector<Rs extends Selectable[]>(...selectors: Rs): MapSelector<Rs> {
  const store = useStore();

  const [state, dispatch] = useReducer(selectorReducer, {
    selectorRef: defaultSelectorRef,
    storeRef: undefined,
    lastState: [],
    updateCount: 0,
  });

  if (state.storeRef?.store !== store) {
    state.selectorRef = defaultSelectorRef;
  }

  if (state.storeRef?.error) {
    const error = state.storeRef.error;
    state.storeRef.error = void 0;
    throw error;
  }

  const resolveState = () => {
    if (state.storeRef?.updated) {
      state.storeRef.updated = false;
      return state.selectorRef.results;
    } else {
      if (state.selectorRef === defaultSelectorRef) {
        state.selectorRef = { selectors: [], deps: [], snapshots: [], results: [] };
      }
      // updates from outside
      const { selectors: oldSelectors, deps, snapshots, results } = state.selectorRef;
      for (let i = 0; i < selectors.length; i++) {
        const old = oldSelectors[i];
        const newly = selectors[i];
        if (typeof newly === 'object') {
          results[i] = store.select(newly);
          oldSelectors[i] = newly;
        } else {
          const newDeps = selectorChanged(old, newly, snapshots[i], store, deps[i]);
          if (newDeps) {
            snapshots[i] = void 0;
            const newSnapshot: Snapshot = {};
            results[i] = store.select(newly, newSnapshot);
            deps[i] = newDeps === true ? void 0 : newDeps;
            snapshots[i] = newSnapshot;
            oldSelectors[i] = newly;
          }
        }
      }
      results.length = selectors.length;
      return results;
    }
  };

  let selectedState: any = resolveState();

  useIsomorphicLayoutEffect(() => {
    state.lastState = [...selectedState];
  });

  useIsomorphicLayoutEffect(() => {
    state.storeRef = {
      store,
      updated: false,
      error: void 0,
      disposer: store.subscribe((updatedState) => {
        let i = 0;
        const { selectors, snapshots, results, deps } = state.selectorRef;
        const max = selectors.length;
        try {
          for (; i < max; i++) {
            const selector = selectors[i];
            const snapshot = snapshots[i];
            if (typeof selector === 'function') {
              if (!snapshot || hasSame(snapshot, updatedState)) {
                if (shouldSelectorRecompute(selector, store, deps, i)) {
                  const newSnapshot: Snapshot = {};
                  const newResult = store.select(selector, newSnapshot);
                  state.storeRef!.updated ||= !compare(selector, results[i], newResult);
                  snapshots[i] = newSnapshot;
                  results[i] = newResult;
                }
              }
            } else if (updatedState.hasOwnProperty(selector.key)) {
              const newState = store.select(selector);
              state.storeRef!.updated ||= newState !== results[i];
              results[i] = newState;
            }
          }
          state.storeRef!.updated && dispatch({ type: 'UPDATE' });
        } catch (e) {
          snapshots.length = results.length = i;
          state.storeRef!.error =
            typeof e === 'object' && e && 'message' in e
              ? Object.assign(e, { message: '[Amos] selector throws error: ' + e.message })
              : new Error('[Amos] selector throws falsy error: ' + e);
          dispatch({ type: 'UPDATE' });
        }
      }),
    };

    // if something change between render and the effect. eg. dispatch when render
    if (!arrayEqual(state.lastState, resolveState())) {
      dispatch({ type: 'UPDATE' });
    }

    return () => state.storeRef?.disposer();
  }, [store]);

  useDebugValue(selectedState, (value: any[]) => {
    return value.reduce((map, value, index) => {
      const s = selectors[index];
      let type = typeof s === 'function' ? s.type ?? s.factory?.type ?? s.name : s.key;
      if (!type) {
        type = `anonymous`;
      }
      if (map.hasOwnProperty(type)) {
        type = type + '_' + index;
      }
      map[type] = value;
      return map;
    }, {} as any);
  });
  return selectedState;
}
