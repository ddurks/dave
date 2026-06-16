/**
 * Scheduler
 *
 * Tracks every setTimeout / setInterval handle it creates so the whole batch
 * can be cancelled at once. Also exposes an AbortSignal for in-flight async
 * work (fetches, awaits) that should be discarded if the owner moves on.
 *
 * Pattern: one Scheduler per Activity session. When Dave interrupts or exits
 * the activity, the Scheduler is cancelled — every pending timer fires never,
 * every async resume that checks `aborted` becomes a no-op.
 *
 * This replaces the ad-hoc scene-level `browseInterval` / `tvWatchInterval`
 * pattern, where late callbacks would fire into a stale state.
 */

export class Scheduler {
  constructor() {
    this._timeouts = new Set();
    this._intervals = new Set();
    this._abort = new AbortController();
  }

  setTimeout(fn, ms) {
    const handle = globalThis.setTimeout(() => {
      this._timeouts.delete(handle);
      if (!this._abort.signal.aborted) fn();
    }, ms);
    this._timeouts.add(handle);
    return handle;
  }

  setInterval(fn, ms) {
    const handle = globalThis.setInterval(() => {
      if (!this._abort.signal.aborted) fn();
    }, ms);
    this._intervals.add(handle);
    return handle;
  }

  clearTimeout(handle) {
    globalThis.clearTimeout(handle);
    this._timeouts.delete(handle);
  }

  clearInterval(handle) {
    globalThis.clearInterval(handle);
    this._intervals.delete(handle);
  }

  get signal() {
    return this._abort.signal;
  }

  get aborted() {
    return this._abort.signal.aborted;
  }

  cancelAll() {
    for (const h of this._timeouts) globalThis.clearTimeout(h);
    for (const h of this._intervals) globalThis.clearInterval(h);
    this._timeouts.clear();
    this._intervals.clear();
    if (!this._abort.signal.aborted) this._abort.abort();
  }
}

export default Scheduler;
