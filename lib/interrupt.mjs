// SIGINT/SIGTERM/SIGHUP handling for the whole tool run. Installed before a tool starts, so a
// signal that lands between two steps (not only while a child is running) still ends in a
// failure document with exit 128+signal instead of Node's silent default.
const SIGS = ["SIGINT", "SIGTERM", "SIGHUP"];
let pending = null;
let fallback = null;
const subscribers = new Set();

export function installInterruptHandlers(onUnhandled) {
  fallback = onUnhandled;
  for (const s of SIGS) {
    process.on(s, () => {
      if (pending) return;
      pending = s;
      if (subscribers.size) for (const fn of subscribers) fn(s);
      else fallback?.(s);
    });
  }
}

/** Run fn on an interrupt (immediately if one already arrived). Returns an unsubscribe function. */
export function onInterrupt(fn) {
  subscribers.add(fn);
  if (pending) fn(pending);
  return () => subscribers.delete(fn);
}

export function interrupted() {
  return pending;
}
