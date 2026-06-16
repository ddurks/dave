/**
 * Activity
 *
 * A first-class, durable object representing something Dave can be doing at
 * a piece of furniture: sitting at the chair browsing Wikipedia, lying on
 * the bed, drinking at the keg, watching TV on the couch.
 *
 * Replaces the old split between:
 *   - FSM states (S.INTERACTING)
 *   - ACTION_DEFS (animation + head-blocking metadata)
 *   - furniture descriptors (location + onArrive/onDepart callbacks)
 *   - scene-level activity state (browseInterval, isBrowsing, isWatchingTv)
 *
 * Now a single class owns the location, animation, lifecycle hooks, and any
 * per-activity timers (via the Scheduler passed to lifecycle methods).
 *
 * Concrete subclasses live in dave-scene.js since they need UI / mind-client
 * dependencies that only the scene wires up.
 */

export class Activity {
  /**
   * @param {object} opts
   * @param {string} opts.label                — "chair" | "couch" | "bed" | "keg"
   * @param {BABYLON.Mesh} opts.mesh           — the furniture's primary mesh
   * @param {BABYLON.Vector3} opts.approachPos — where Dave walks to
   * @param {BABYLON.Vector3} opts.departPos   — where Dave clears to on exit
   * @param {number} opts.facingAngle          — Dave's rotation on arrival
   * @param {string|null} opts.anim            — ACTION_DEFS key: "sit" | "laydown" | "idle"
   * @param {boolean} opts.blocksHead          — whether anim suppresses head tracking
   * @param {boolean} opts.reversible          — whether anim can be played backward to exit
   * @param {number} opts.defaultDuration      — seconds, used when caller doesn't specify
   * @param {number} opts.maxDuration          — seconds, used to cap Infinity from user paths
   */
  constructor({
    label,
    mesh,
    approachPos,
    departPos,
    facingAngle,
    anim = "sit",
    blocksHead = true,
    reversible = true,
    defaultDuration = 60,
    maxDuration = 180,
  }) {
    this.label = label;
    this.mesh = mesh;
    this.approachPos = approachPos;
    this.departPos = departPos;
    this.facingAngle = facingAngle;
    this.anim = anim;
    this.blocksHead = blocksHead;
    this.reversible = reversible;
    this.defaultDuration = defaultDuration;
    this.maxDuration = maxDuration;
  }

  /**
   * Called once when Dave finishes aligning at the activity location, after
   * the entry animation has been kicked off. `scheduler` is scoped to this
   * session — any timer or async work registered with it is automatically
   * cancelled when the activity ends or is interrupted.
   *
   * @param {import("./dave-character.js").Dave} dave
   * @param {import("./dave-scheduler.js").Scheduler} scheduler
   */
  async onEnter(dave, scheduler) {}

  /**
   * Per-frame tick while Dave is in INTERACTING. Default is a no-op; most
   * activities just run on timers registered in onEnter.
   *
   * @returns {boolean} true if the activity wants to exit (Dave will leave
   *   naturally via the reverse-animation path).
   */
  tick(dave, scheduler, dt) {
    return false;
  }

  /**
   * Called when Dave is leaving — either naturally (duration up, activity
   * requested exit) or due to interruption (user chat, new activity request).
   * The scheduler is cancelled by the caller AFTER this returns, so you can
   * still use it here for synchronous cleanup if needed.
   */
  onExit(dave, scheduler) {}
}

export default Activity;
