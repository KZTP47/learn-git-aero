// Tiny synchronous event bus. Read-only for feature agents.

const handlers = new Map();

export const bus = {
  on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(fn);
    return () => bus.off(name, fn);
  },

  off(name, fn) {
    const set = handlers.get(name);
    if (set) set.delete(fn);
  },

  once(name, fn) {
    const off = bus.on(name, (payload) => {
      off();
      fn(payload);
    });
    return off;
  },

  emit(name, payload) {
    const set = handlers.get(name);
    if (!set) return;
    // Copy so a handler that unsubscribes mid-emit cannot skip its neighbour.
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] handler for "${name}" threw`, err);
      }
    }
  },
};
