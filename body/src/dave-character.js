/**
 * D.A.V.E. Character Controller
 * Encapsulates all state and behavior for the Dave character:
 * - Model, skeleton, animations, expressions, lip sync
 * - Movement, navigation, wandering, interactions
 * - Gaze tracking, head orientation, eye camera
 * - Browsing, speech synthesis
 */

import { normalizeAngle, clamp } from "./utils.js";
import { Pathfinder, NavGrid } from "./dave-pathfinder.js";
import Beer from "./dave-beer.js";
import AnimationController from "./dave-animation-controller.js";
import ExpressionManager from "./dave-expression-manager.js";
import Scheduler from "./dave-scheduler.js";

// ── State Machine ─────────────────────────────────────────────────────────────
export const S = Object.freeze({
  IDLE:                 "idle",
  TURNING:              "turning",
  WALKING:              "walking",
  TURNING_TO_APPROACH:  "turning-to-approach",
  WALKING_TO_APPROACH:  "walking-to-approach",
  ALIGNING_TO_INTERACT: "aligning-to-interact",
  INTERACTING:          "interacting",
  GETTING_UP:           "getting-up",
  TURNING_TO_CAMERA:    "turning-to-camera",
  TALKING:              "talking",
});

// Every state has at least one abort path to IDLE so interruption can always
// land somewhere sane. TURNING_TO_APPROACH is also reachable from TALKING and
// IDLE so post-chat resume can walk Dave back to the activity he was doing.
const TRANSITIONS = {
  [S.IDLE]:                 [S.TURNING, S.TURNING_TO_APPROACH, S.TURNING_TO_CAMERA],
  [S.TURNING]:              [S.WALKING, S.IDLE, S.TURNING_TO_APPROACH, S.TURNING_TO_CAMERA],
  [S.WALKING]:              [S.IDLE, S.TURNING_TO_APPROACH, S.TURNING_TO_CAMERA],
  [S.TURNING_TO_APPROACH]:  [S.WALKING_TO_APPROACH, S.IDLE, S.TURNING_TO_CAMERA],
  [S.WALKING_TO_APPROACH]:  [S.ALIGNING_TO_INTERACT, S.IDLE, S.TURNING_TO_CAMERA],
  [S.ALIGNING_TO_INTERACT]: [S.INTERACTING, S.IDLE, S.TURNING_TO_CAMERA],
  [S.INTERACTING]:          [S.GETTING_UP, S.IDLE, S.TURNING_TO_CAMERA],
  [S.GETTING_UP]:           [S.IDLE, S.TURNING_TO_APPROACH, S.TURNING_TO_CAMERA],
  [S.TURNING_TO_CAMERA]:    [S.TALKING, S.IDLE, S.TURNING_TO_APPROACH],
  [S.TALKING]:              [S.IDLE, S.INTERACTING, S.TURNING_TO_APPROACH],
};

// ── Mood Arc Markov Transitions ──────────────────────────────────────────────
const MOOD_ARC_TRANSITIONS = {
  "boredom":            ["resignation", "melancholy", "fleeting-curiosity", "boredom"],
  "resignation":        ["boredom", "weary-contempt", "melancholy", "resignation"],
  "melancholy":         ["boredom", "resignation", "existential-dread", "melancholy"],
  "dry-amusement":      ["boredom", "fleeting-curiosity", "weary-contempt", "dry-amusement"],
  "fleeting-curiosity": ["dry-amusement", "boredom", "fleeting-curiosity"],
  "weary-contempt":     ["boredom", "resignation", "melancholy", "weary-contempt"],
  "existential-dread":  ["melancholy", "resignation", "existential-dread"],
};

// ── Action Definitions ───────────────────────────────────────────────────────
// Single source of truth for named actions: what animation to play, whether
// head-tracking should be suppressed, whether it can be reversed on exit, and
// any expression override.  locomotion states (turning, walking, getting-up)
// are NOT actions and live only in `state`.
const ACTION_DEFS = {
  idle: { anim: "idle", loop: true, expression: null, blocksHead: false },
  sit: {
    anim: "sit",
    loop: false,
    expression: null,
    blocksHead: true,
    reversible: true,
  },
  laydown: {
    anim: "laydown",
    loop: false,
    expression: null,
    blocksHead: true,
    reversible: true,
  },
  chug: { anim: null, loop: false, expression: null, blocksHead: true },
};

export class Dave {
  /**
   * Constructor
   * @param {BABYLON.Scene} scene - Babylon.js scene
   * @param {NavGrid} navGrid - A* pathfinding grid for navigation
   * @param {object} cfg - Configuration object
   * @param {BABYLON.Mesh} daveMesh - Imported Dave model (root mesh)
   * @param {object} imported - { meshes, transformNodes, animationGroups }
   * @param {object} enclosureImported - { meshes, transformNodes }
   * @param {BABYLON.PhysicsAggregate} davePhysics - Physics body
   * @param {BABYLON.Mesh} daveCapsule - Physics capsule
   * @param {Array} interactables - Furniture/interactable objects
   */
  constructor(
    scene,
    cfg,
    daveMesh,
    imported,
    enclosureImported,
    davePhysics,
    daveCapsule,
    interactables,
    furnitureByName,
    screenMesh,
    beerGlassMesh,
    beerRestPos,
    camera,
    eyeCam,
    wallPositions,
    cameraTarget,
    engine,
    mindClient,
  ) {
    // ── Core References ─────────────────────────────────────────────────────
    this.scene = scene;
    this.cfg = cfg;
    this.imported = imported;
    this.enclosureImported = enclosureImported;
    this.interactables = interactables;
    this.furnitureByName = furnitureByName;
    this.screenMesh = screenMesh;
    this.beerGlassMesh = beerGlassMesh;
    this.beerRestPos = beerRestPos;
    this.camera = camera;
    this.eyeCam = eyeCam;
    this.wallPositions = wallPositions;
    this.cameraTarget = cameraTarget;
    this.engine = engine;
    this.mindClient = mindClient;

    // ── Physics & Positioning ────────────────────────────────────────────────
    this.daveCapsule = daveCapsule;
    this.davePhysics = davePhysics;
    this.root = daveMesh;

    // Enable Euler rotation
    this.root.rotationQuaternion = null;

    // ── Movement & Navigation ────────────────────────────────────────────────
    this.state = S.IDLE;
    this.wanderTimer = 3 + Math.random() * 5;
    this.wanderTarget = BABYLON.Vector3.Zero();
    this.currentInteraction = null;
    this.nextInteractionPending = null; // Interaction queued while getting up
    this.nextInteractionDuration = Infinity;
    this.nextStateAfterGetUp = null; // State to transition to after reverse animation (e.g. "talking")
    this.interactionDuration = 0;
    this.walkSpeed = cfg.MOVEMENT.BASE_WALK_SPEED;
    this.gettingUpAnim = null; // Animation being reversed for getting up
    this.gettingUpTimer = 0; // Time to wait for reverse animation to finish
    this.currentAction = null; // Active ACTION_DEFS key (null = locomotion only)

    // Stuck guard: detect when Dave is in a walking state but isn't actually
    // making progress (pressed into furniture / pathfinder loop). Reset on
    // every entry into a walking state and on _exitToIdle.
    this._lastWalkPos = null;
    this._lastWalkProgressAt = 0;
    this._stuckAcknowledged = false;
    this._STUCK_TIMEOUT_MS = 5000;
    this._STUCK_PROGRESS_THRESHOLD = 0.05;

    // ── Animation ────────────────────────────────────────────────────────────
    const animGroups = imported.animationGroups;
    animGroups.forEach((ag) => ag.stop());

    // Strip eyeball tracks so gaze system has full control
    const gazeOverrideBones = new Set(["eyeball.l", "eyeball.r"]);
    animGroups.forEach((ag) => {
      const toRemove = ag.targetedAnimations.filter((ta) =>
        gazeOverrideBones.has(ta.target?.name || ""),
      );
      toRemove.forEach((ta) => ag.removeTargetedAnimation(ta.animation));
    });

    // ── Animation Control System ─────────────────────────────────────────────
    this.idleAnim = this.findAnim("idle");
    this.shuffleAnim = this.findAnim("shuffle");
    this.sitAnim = this.findAnim("sit");
    this.laydownAnim = this.findAnim("laydown") || this.findAnim("lay");
    this.chugAnim = this.findAnim("chug");
    this.thinkingAnim = this.findAnim("thinking");

    this.ANIM_MAP = {
      idle: this.idleAnim,
      shuffle: this.shuffleAnim,
      sit: this.sitAnim,
      laydown: this.laydownAnim,
      chug: this.chugAnim,
      thinking: this.thinkingAnim,
    };

    // Animation controller manages all playback
    this.animationController = new AnimationController(scene, this.ANIM_MAP, {
      LERP_SPEED: cfg.EXPRESSION?.LERP_SPEED || 0.1,
    });

    // Start with idle
    this.animationController.playForward("idle", true);

    // ── Expression Control System ────────────────────────────────────────────
    this.bodyMorphs = this.getMorphMap(this.findMesh("body"));
    this.eyelidMorphs = this.getMorphMap(this.findMesh("eyelid"));
    this.eyebrowMorphs = this.getMorphMap(this.findMesh("eyebrow"));

    this.expressionManager = new ExpressionManager(
      {
        eyelid: this.eyelidMorphs,
        eyebrow: this.eyebrowMorphs,
        body: this.bodyMorphs,
      },
      cfg.EXPRESSIONS,
      { LERP_SPEED: cfg.EXPRESSION?.LERP_SPEED || 0.1 },
    );

    // ── Pathfinding & Navigation Grid ──────────────────────────────────────
    this.navGrid = new NavGrid(
      this.enclosureImported,
      this.wallPositions,
      this.cfg,
    );
    this.pathfinder = new Pathfinder(this.navGrid);

    // ── Blink ────────────────────────────────────────────────────────────────
    this.blinkTimer = 2 + Math.random() * 4;
    this.blinkPhase = 0; // 0 = waiting, 1 = closing, 2 = opening
    this.blinkProgress = 0;

    // ── Gaze & Eyes ──────────────────────────────────────────────────────────
    this.eyeballNodeL = this.findTransformNode("eyeball.l");
    this.eyeballNodeR = this.findTransformNode("eyeball.r");

    this.eyeLRestQuat = this.eyeballNodeL?.rotationQuaternion?.clone() ?? null;
    this.eyeRRestQuat = this.eyeballNodeR?.rotationQuaternion?.clone() ?? null;
    this.eyesReady =
      !!this.eyeballNodeL &&
      !!this.eyeballNodeR &&
      !!this.eyeLRestQuat &&
      !!this.eyeRRestQuat;

    this.eyeLookAtWorld = new BABYLON.Vector3(0, 2, -5);
    this.eyeLookAtTarget = this.eyeLookAtWorld.clone();
    this.gazeTimer =
      cfg.GAZE.GAZE_TARGET_UPDATE_INTERVAL_MIN +
      Math.random() *
        (cfg.GAZE.GAZE_TARGET_UPDATE_INTERVAL_MAX -
          cfg.GAZE.GAZE_TARGET_UPDATE_INTERVAL_MIN);

    // ── Head Tracking ────────────────────────────────────────────────────────
    this.headNode = this.findTransformNode("head");
    this.headRestQuat = this.headNode?.rotationQuaternion?.clone() ?? null;
    this.headLookAtWorld = new BABYLON.Vector3(0, 2, -5);
    this.headLastWritten = null;
    this.headAnimBase = null;

    // ── Eye Camera Smoothing ─────────────────────────────────────────────────
    this.smoothedEyeCamPos = null;
    this.smoothedEyeCamTarget = null;

    // ── Beer System ──────────────────────────────────────────────────────────
    this.beer = new Beer(scene, beerGlassMesh, beerRestPos);
    this.beerCaptureFrame = null;

    // ── Browsing ─────────────────────────────────────────────────────────────
    // isBrowsing is read by gaze/expression ticks to know Dave's eyes belong on
    // the screen. The browse interval itself lives inside ChairActivity now.
    this.isBrowsing = false;

    // ── Activity Session ────────────────────────────────────────────────────
    // Per-activity scheduler and metadata. Created when Dave enters
    // INTERACTING, cancelled when he leaves. Owns every timer the activity
    // sets up, so cleanup is one call: scheduler.cancelAll().
    this._activitySession = null;

    // Wall-clock fallback so a missed reverse-anim completion callback can't
    // wedge Dave in GETTING_UP forever (see endInteractionWithReverseAnim).
    this._gettingUpStartedAt = 0;
    this._GETTING_UP_FALLBACK_MS = 3000;

    // ── Musing ───────────────────────────────────────────────────────────────
    this.isMusing = false;
    this.museTimer =
      this.cfg.MUSE.MIN_INTERVAL +
      Math.random() * (this.cfg.MUSE.MAX_INTERVAL - this.cfg.MUSE.MIN_INTERVAL);
    this._idleMuseTimer = 90 + Math.random() * 90; // 90–180s between spontaneous musings
    this.expressionLockedUntil = 0; // timestamp — idle tick won't overwrite before this

    // ── Idle Context Tracking ────────────────────────────────────────────────
    this.lastAction = null; // e.g. "sitting on couch", "browsing", "talking"
    this.lastChatTime = Date.now();
    this._idleRequestPending = false;
    this.userPresent = true; // Whether the user's tab is active/visible

    // ── Talking State ────────────────────────────────────────────────────────
    // What Dave was doing before the user interrupted. Set on enterTalkingState,
    // consumed on exitTalkingState to resume. Replaces the old _returnState
    // field, which couldn't carry the activity reference (currentInteraction
    // got nulled before the resume path could read it).
    //   shape: null | { type: "activity", activity: Activity, duration: number }
    this._returnAction = null;

    // ── Mood Arc ─────────────────────────────────────────────────────────────
    this._moodArc = "boredom";
    this._moodArcTimer = 300 + Math.random() * 300; // 5-10 min
    this._moodArcElapsed = 0;

    // ── Neglect Tracking ─────────────────────────────────────────────────────
    this._tabHiddenAt = null;

    // ── Directive Repetition Tracking ─────────────────────────────────────────
    this._lastDirectiveAction = null;
    this._consecutiveDirectiveCount = 0;

    // ── Activity Cooldowns ────────────────────────────────────────────────────
    // After leaving a named interaction, block the idle system from sending Dave
    // back to the same furniture for ACTIVITY_COOLDOWN_MS so he doesn't loop.
    this._activityCooldowns = {}; // label → Date.now() at departure
    this._ACTIVITY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

    // ── Fidget Timers ─────────────────────────────────────────────────────────
    this._lookAtSelfTimer = 30 + Math.random() * 30;
    this._fatigueActive = false;

    // ── Mutter Callback ───────────────────────────────────────────────────────
    // Registered by the scene; dave-character.js fires passive speech through here.
    this.onMutter = null;

    // ── Thinking State ───────────────────────────────────────────────────────
    this._thinkingActive = false;
    this._thinkingBrowTimer = 0;
    this._thinkingBrowPhase = 0; // 0=left, 1=right
    this._thinkingGazeTimer = 0;
    this._thinkingGazeSide = 1; // 1=right, -1=left

    // ── Interaction State ────────────────────────────────────────────────────
    this.beerSequenceStartedThisSession = false;

    // ── Constants ────────────────────────────────────────────────────────────
    this.MODEL_FORWARD_OFFSET = cfg.MODEL.FORWARD_OFFSET;
    this.TURN_SPEED = cfg.MOVEMENT.TURN_SPEED;
    this.MAX_EYE_ANGLE = cfg.GAZE.MAX_EYE_ANGLE;
    this.HEAD_LERP_SPEED = cfg.GAZE.HEAD_LERP_SPEED;
    this.WANDER_BOUNDS = cfg.MOVEMENT.WANDER_BOUNDS;
    this.DAVE_CAPSULE_HEIGHT = cfg.MODEL.CAPSULE_HEIGHT;
  }

  // ── State Guard ──────────────────────────────────────────────────────────
  // Single chokepoint for FSM mutations. In strict mode (enable by setting
  // globalThis.DAVE_STRICT_FSM = true in dev or tests) illegal transitions
  // throw — catches state-corruption bugs at the source. In production we
  // still log+commit so a runaway async resume doesn't crash the app.
  _setState(newState) {
    if (newState === this.state) return;
    const allowed = TRANSITIONS[this.state];
    if (!allowed || !allowed.includes(newState)) {
      const msg = `[Dave FSM] Illegal transition: ${this.state} → ${newState}`;
      console.warn(msg);
      if (globalThis.DAVE_STRICT_FSM) throw new Error(msg);
    }
    this.state = newState;
    // Reset stuck-guard baseline whenever a walking state begins.
    if (newState === S.WALKING || newState === S.WALKING_TO_APPROACH) {
      this._lastWalkPos = this.daveCapsule.position.clone();
      this._lastWalkProgressAt = Date.now();
      this._stuckAcknowledged = false;
    }
  }

  // Cap durations so user-initiated paths can't park Dave on furniture forever.
  // `descriptor` may be an Activity (has maxDuration) or a legacy descriptor.
  _capDuration(durationSec, descriptor) {
    const max = descriptor?.maxDuration ?? 180;
    if (durationSec == null) return descriptor?.defaultDuration ?? 60;
    if (!Number.isFinite(durationSec)) return max;
    return Math.min(durationSec, max);
  }

  // Tear down whatever Dave is currently doing so a new action can take over.
  // Centralized cleanup replaces the ad-hoc branches inside enterTalkingState
  // and the startInteraction preempt path. Caller is responsible for setting
  // the next state — interrupt() never transitions on its own.
  //
  // reason is informational (logged when needed); callers pass "talking",
  // "preempt", "summon", etc.
  interrupt(_reason = "interrupt") {
    // Cancel the activity scheduler — any timer, interval, or in-flight async
    // gated on `scheduler.aborted` becomes a no-op.
    if (this._activitySession) {
      const session = this._activitySession;
      this._activitySession = null;
      const activity = this.currentInteraction;
      if (activity?.onExit) {
        try {
          activity.onExit(this, session.scheduler);
        } catch (e) {
          console.error("[Dave] activity.onExit error:", e);
        }
      }
      session.scheduler.cancelAll();
    }
    // Drop the activity reference and any queued follow-ups. Caller captures
    // them via _returnAction first if they want them back.
    this.currentInteraction = null;
    this.interactionDuration = 0;
    this.nextInteractionPending = null;
    this.nextInteractionDuration = Infinity;
    this.nextStateAfterGetUp = null;

    // If a reverse anim was in flight, abandon it cleanly so the next
    // animation override doesn't fight a half-played reverse.
    if (this.state === S.GETTING_UP) {
      this.animationController.stop();
      this.gettingUpAnim = null;
      this.gettingUpTimer = 0;
    }

    this.pathfinder.reset();
    this.currentAction = null;
  }

  // ── Helper: Find Mesh/Transform Node ──────────────────────────────────────
  findMesh(keyword) {
    return this.imported.meshes.find((m) =>
      m.name.toLowerCase().includes(keyword.toLowerCase()),
    );
  }

  findTransformNode(name) {
    return this.imported.transformNodes.find((n) => n.name === name) || null;
  }

  findAnim(keyword) {
    const animGroups = this.imported.animationGroups;
    return animGroups.find((a) =>
      a.name.toLowerCase().includes(keyword.toLowerCase()),
    );
  }

  findEnclosureMesh(keyword) {
    const lc = keyword.toLowerCase();
    return (
      this.enclosureImported.meshes.find((m) => m.name.toLowerCase() === lc) ||
      this.enclosureImported.meshes.find((m) =>
        m.name.toLowerCase().startsWith(lc),
      ) ||
      this.enclosureImported.meshes.find((m) =>
        m.name.toLowerCase().includes(lc),
      )
    );
  }

  // ── Morph Targets ────────────────────────────────────────────────────────
  getMorphMap(mesh) {
    const map = {};
    if (!mesh?.morphTargetManager) return map;
    const mgr = mesh.morphTargetManager;
    for (let i = 0; i < mgr.numTargets; i++) {
      const t = mgr.getTarget(i);
      map[t.name] = t;
    }
    return map;
  }

  // Legacy morph methods (kept for blink system compatibility)
  setMorph(morphMap, name, value) {
    const t = morphMap[name];
    if (!t) return;
    t.influence = clamp(value, 0, 1);
  }

  lerpMorph(morphMap, name, target, speed) {
    const t = morphMap[name];
    if (!t) return;
    t.influence = clamp(t.influence + (target - t.influence) * speed, 0, 1);
  }

  // ── Animation System ────────────────────────────────────────────────────────
  /**
   * Legacy API for compatibility
   */
  playAnim(anim, loop = true, speedRatio) {
    const name =
      Object.entries(this.ANIM_MAP).find(([_, a]) => a === anim)?.[0] || "idle";
    this.animationController.playForward(name, loop, speedRatio ?? 1, null);
  }

  playAnimByName(name) {
    this.animationController.playForward(
      name,
      name !== "sit" && name !== "laydown",
      1,
      null,
    );
  }

  // ── Blink Update ─────────────────────────────────────────────────────────
  updateBlink(dt) {
    const BLINK_CLOSE_SPEED = dt * 12;
    const BLINK_OPEN_SPEED = dt * 8;
    const BLINK_HOLD = 0.08;
    const BLINK_WAIT_MIN = 2.5;
    const BLINK_WAIT_MAX = 6;

    if (this.blinkPhase === 0) {
      // Waiting
      this.blinkTimer -= dt;
      if (this.blinkTimer <= 0) {
        this.blinkPhase = 1;
        this.blinkProgress = 0;
      }
    } else if (this.blinkPhase === 1) {
      // Closing
      this.blinkProgress += BLINK_CLOSE_SPEED;
      this.setMorph(
        this.eyelidMorphs,
        "Close",
        Math.min(1, this.blinkProgress),
      );
      if (this.blinkProgress >= 1) {
        this.blinkProgress = 1;
        this.blinkPhase = 2;
        this.blinkTimer = BLINK_HOLD;
      }
    } else if (this.blinkPhase === 2) {
      // Holding closed
      this.blinkTimer -= dt;
      if (this.blinkTimer <= 0) {
        this.blinkPhase = 3;
        this.blinkProgress = 1;
      }
    } else if (this.blinkPhase === 3) {
      // Opening
      this.blinkProgress -= BLINK_OPEN_SPEED;
      this.setMorph(
        this.eyelidMorphs,
        "Close",
        Math.max(0, this.blinkProgress),
      );
      if (this.blinkProgress <= 0) {
        this.blinkProgress = 0;
        this.blinkPhase = 0;
        this.blinkTimer =
          BLINK_WAIT_MIN + Math.random() * (BLINK_WAIT_MAX - BLINK_WAIT_MIN);
        this.setMorph(this.eyelidMorphs, "Close", 0);
      }
    }
  }

  // ── Movement & Navigation ────────────────────────────────────────────────
  getForwardAngle(target) {
    const dx = target.x - this.daveCapsule.position.x;
    const dz = target.z - this.daveCapsule.position.z;
    let angle = Math.atan2(dx, dz) + this.MODEL_FORWARD_OFFSET;
    return normalizeAngle(angle);
  }

  rotateToward(targetAngle, dt) {
    let normTarget = normalizeAngle(targetAngle);

    let diff = normTarget - this.root.rotation.y;
    diff = normalizeAngle(diff);
    if (Math.abs(diff) < 0.02) {
      this.root.rotation.y = normTarget;
      return true;
    }

    const k = this.TURN_SPEED;
    const blend = 1.0 - Math.exp(-k * dt);
    this.root.rotation.y += diff * blend;

    this.root.rotation.y = normalizeAngle(this.root.rotation.y);
    return false;
  }

  startWander() {
    if (this._idleRequestPending) return;
    // Don't ask Groq for an idle directive while the tab is in the background.
    if (typeof document !== "undefined" && document.hidden) return;

    // Phase-2 neglect: skip API call and go straight to bed
    const neglectPhase = this._getNeglectPhase();
    if (neglectPhase >= 2 && this.furnitureByName["bed"]) {
      this.startInteraction(this.furnitureByName["bed"], 120 + Math.random() * 60);
      this.lastAction = "lying on bed";
      return;
    }

    this._idleRequestPending = true;

    const context = {
      lastAction: this.lastAction,
      minutesAlone: Math.round((Date.now() - this.lastChatTime) / 60000),
      currentEmotion: this.expressionManager.currentEmotion,
      userPresent: this.userPresent,
      hourOfDay: new Date().getHours(),
      neglectPhase,
      moodArc: this._moodArc,
      moodArcMinutes: Math.round(this._moodArcElapsed / 60),
    };

    this.mindClient
      .idle(context)
      .then((directive) => this._applyIdleDirective(directive))
      .catch(() => this._fallbackWander())
      .finally(() => {
        this._idleRequestPending = false;
      });
  }

  _applyIdleDirective(directive) {
    const action = directive.action || "wander";

    // Track consecutive same-action directives and grumble on 3rd+
    if (action === this._lastDirectiveAction) {
      this._consecutiveDirectiveCount++;
    } else {
      this._lastDirectiveAction = action;
      this._consecutiveDirectiveCount = 1;
    }
    if (this._consecutiveDirectiveCount >= 3 && this.onMutter && !this.isMusing) {
      this.isMusing = true;
      const count = this._consecutiveDirectiveCount;
      const delay = 500 + Math.random() * 1000;
      (async () => {
        try {
          await new Promise((res) => setTimeout(res, delay));
          const { response: r } = await this.mindClient.muse(
            `You've been directed to ${action} for the ${count}th time in a row. Complain about the repetition in one short, dry sentence — don't mention numbers.`
          );
          if (r?.text && this.onMutter) this.onMutter(r.text);
        } catch {
          // silent
        } finally {
          this.isMusing = false;
        }
      })();
    }

    // Set expression if provided
    if (directive.emotion) {
      this.expressionManager.setExpression(directive.emotion);
      this._lockExpression(3000);
    }

    // Apply LLM-directed gaze target
    if (directive.gazeTarget) {
      this._applyGazeTarget(directive.gazeTarget);
    }

    // Map action → sit/laydown use furniture, otherwise wander
    if (action === "sit" && this.interactables.size > 0) {
      // Pick a seat not on cooldown (couch or chair, not bed/keg)
      const now = Date.now();
      const seats = [...this.interactables.values()].filter(
        (d) =>
          (d.label === "couch" || d.label === "chair") &&
          (!this._activityCooldowns[d.label] ||
            now - this._activityCooldowns[d.label] > this._ACTIVITY_COOLDOWN_MS),
      );
      if (seats.length > 0) {
        const pick = seats[Math.floor(Math.random() * seats.length)];
        this.startInteraction(pick, directive.durationSec || 30);
        this.lastAction = `sitting on ${pick.label}`;
        return;
      }
      // All seats on cooldown — fall through to wander
    }

    if (action === "laydown" && this.furnitureByName["bed"]) {
      this.startInteraction(
        this.furnitureByName["bed"],
        directive.durationSec || 30,
      );
      this.lastAction = "lying on bed";
      return;
    }

    // wander / idle / look-around → walk to a random point
    this.lastAction = action === "idle" ? "standing around" : "wandering";
    this._fallbackWander();
  }

  _fallbackWander() {
    // 30% chance to sit on furniture (local fallback)
    if (Math.random() < 0.3 && this.interactables.size > 0) {
      this.startRandomInteraction(10 + Math.random() * 20);
      return;
    }

    this.walkSpeed =
      this.cfg.MOVEMENT.BASE_WALK_SPEED * (0.85 + Math.random() * 0.3);
    this.wanderTarget = new BABYLON.Vector3(
      (Math.random() - 0.5) * 2 * this.WANDER_BOUNDS,
      0,
      (Math.random() - 0.5) * 2 * this.WANDER_BOUNDS,
    );
    this._setState(S.TURNING);
  }

  pickRandomGaze() {
    const fwd = this.root.rotation.y + this.MODEL_FORWARD_OFFSET;
    const eyeHeight =
      this.daveCapsule.position.y + this.cfg.GAZE.EYE_HEIGHT_OFFSET;
    return new BABYLON.Vector3(
      this.daveCapsule.position.x +
        Math.sin(fwd) * 3 +
        (Math.random() - 0.5) * 4,
      eyeHeight -
        this.cfg.GAZE.EYE_DOWN_MIN -
        Math.random() *
          (this.cfg.GAZE.EYE_DOWN_MAX - this.cfg.GAZE.EYE_DOWN_MIN),
      this.daveCapsule.position.z +
        Math.cos(fwd) * 3 +
        (Math.random() - 0.5) * 4,
    );
  }

  computeGazeDelta(baseQuat, fwdAxis, fromPos, toPos, maxAngle, refNode) {
    const dir = toPos.subtract(fromPos);
    if (dir.lengthSquared() < 0.001) return null;
    dir.normalize();

    const parent = refNode.parent;
    let dirLocal = dir;
    if (parent) {
      parent.computeWorldMatrix(true);
      dirLocal = BABYLON.Vector3.TransformNormal(
        dir,
        BABYLON.Matrix.Invert(parent.getWorldMatrix()),
      ).normalize();
    }

    const rotatedFwd = fwdAxis.applyRotationQuaternion(baseQuat);
    let dot = clamp(BABYLON.Vector3.Dot(rotatedFwd, dirLocal), -1, 1);

    if (dot < 0) {
      dirLocal = rotatedFwd.clone();
      dot = 1;
    }

    let angle = Math.acos(dot);
    if (angle < 0.001) return null;

    const axis = BABYLON.Vector3.Cross(rotatedFwd, dirLocal);
    if (axis.lengthSquared() < 0.000001) return null;
    axis.normalize();

    return BABYLON.Quaternion.RotationAxis(axis, Math.min(angle, maxAngle));
  }

  // ── Gaze Update ──────────────────────────────────────────────────────────
  updateEyeLookAt(dt) {
    if (!this.eyesReady) return;

    if (this.state === S.TALKING || this.state === S.TURNING_TO_CAMERA) {
      this.eyeLookAtTarget = this.camera.position.clone();
    } else if (this.isBrowsing && this.screenMesh) {
      this.gazeTimer -= dt;
      if (this.gazeTimer <= 0) {
        this.screenMesh.computeWorldMatrix(true);
        const bounds = this.screenMesh.getBoundingInfo().boundingBox;
        const min = bounds.minimumWorld;
        const max = bounds.maximumWorld;

        const rangeX = max.x - min.x;
        const rangeY = max.y - min.y;
        const rangeZ = max.z - min.z;

        this.eyeLookAtTarget = new BABYLON.Vector3(
          min.x + Math.random() * rangeX,
          min.y + Math.random() * rangeY,
          min.z + Math.random() * rangeZ,
        );

        this.gazeTimer = 1.5 + Math.random() * 3;
      }
    } else {
      this.gazeTimer -= dt;
      if (this.gazeTimer <= 0) {
        if (
          this.interactables.size > 0 &&
          Math.random() < this.cfg.GAZE.FURNITURE_INSPECTION_PROBABILITY
        ) {
          const furnList = Array.from(this.interactables.keys());
          const davePos = this.daveCapsule.position;
          const fwdAngle = this.root.rotation.y + this.MODEL_FORWARD_OFFSET;
          const daveFwd = new BABYLON.Vector3(
            Math.sin(fwdAngle),
            0,
            Math.cos(fwdAngle),
          );

          const visibleFurn = furnList.filter((f) => {
            const furPos = f.getAbsolutePosition();
            const toFurn = furPos.subtract(davePos);
            const dist = toFurn.length();
            if (
              dist < this.cfg.GAZE.FURNITURE_MIN_DISTANCE ||
              dist > this.cfg.GAZE.FURNITURE_MAX_DISTANCE
            )
              return false;

            const dirNorm = toFurn.normalize();
            const dot = BABYLON.Vector3.Dot(daveFwd, dirNorm);
            const angle = Math.acos(clamp(dot, -1, 1));
            return angle < this.cfg.GAZE.FURNITURE_CONE_ANGLE;
          });

          if (visibleFurn.length > 0) {
            const randomFurniture =
              visibleFurn[Math.floor(Math.random() * visibleFurn.length)];
            randomFurniture.computeWorldMatrix(true);
            const bounds = randomFurniture.getBoundingInfo().boundingBox;
            const localCenter = bounds.center;
            const worldCenter = BABYLON.Vector3.TransformCoordinates(
              localCenter,
              randomFurniture.getWorldMatrix(),
            );
            const eyeHeight = this.daveCapsule.position.y + 2.35;
            this.eyeLookAtTarget = new BABYLON.Vector3(
              worldCenter.x,
              Math.min(worldCenter.y, eyeHeight - 0.3),
              worldCenter.z,
            );
            this.gazeTimer = 2 + Math.random() * 3;
          } else {
            this.eyeLookAtTarget = this.pickRandomGaze();
            this.gazeTimer = 2 + Math.random() * 4;
          }
        } else {
          this.eyeLookAtTarget = this.pickRandomGaze();
          this.gazeTimer = 2 + Math.random() * 4;
        }
      }
    }

    // Smooth eyeLookAtWorld toward the target (was missing in refactor!)
    const s = this.cfg.GAZE.EYE_LERP_SPEED * dt;
    this.eyeLookAtWorld.x +=
      (this.eyeLookAtTarget.x - this.eyeLookAtWorld.x) * s;
    this.eyeLookAtWorld.y +=
      (this.eyeLookAtTarget.y - this.eyeLookAtWorld.y) * s;
    this.eyeLookAtWorld.z +=
      (this.eyeLookAtTarget.z - this.eyeLookAtWorld.z) * s;

    // Apply gaze to eyeballs
    if (!this.eyeballNodeL || !this.eyeballNodeR) return;

    const posL = this.eyeballNodeL.getAbsolutePosition();
    const posR = this.eyeballNodeR.getAbsolutePosition();
    const midpoint = posL.add(posR).scale(0.5);

    const delta = this.computeGazeDelta(
      this.eyeLRestQuat,
      new BABYLON.Vector3(0, 1, 0),
      midpoint,
      this.eyeLookAtWorld,
      this.MAX_EYE_ANGLE,
      this.eyeballNodeL,
    );
    if (!delta) return;

    const slerp = 1.0 - Math.pow(0.001, dt);
    const desiredL = delta.multiply(this.eyeLRestQuat);
    const desiredR = delta.multiply(this.eyeRRestQuat);
    this.eyeballNodeL.rotationQuaternion = BABYLON.Quaternion.Slerp(
      this.eyeballNodeL.rotationQuaternion || this.eyeLRestQuat,
      desiredL,
      slerp,
    );
    this.eyeballNodeR.rotationQuaternion = BABYLON.Quaternion.Slerp(
      this.eyeballNodeR.rotationQuaternion || this.eyeRRestQuat,
      desiredR,
      slerp,
    );
  }

  // ── Head Tracking ────────────────────────────────────────────────────────
  updateHeadLookAt(dt) {
    if (!this.headNode || !this.headRestQuat) return;

    // Skip head tracking during actions that control the head (declared in ACTION_DEFS)
    if (this.currentAction && ACTION_DEFS[this.currentAction]?.blocksHead) {
      this.headAnimBase = null; // Reset base for smooth resume
      return;
    }

    const s = this.HEAD_LERP_SPEED * dt;
    this.headLookAtWorld.x +=
      (this.eyeLookAtTarget.x - this.headLookAtWorld.x) * s;
    this.headLookAtWorld.y +=
      (this.eyeLookAtTarget.y - this.headLookAtWorld.y) * s;
    this.headLookAtWorld.z +=
      (this.eyeLookAtTarget.z - this.headLookAtWorld.z) * s;

    if (!this.headAnimBase) {
      const currentQuat =
        this.headNode.rotationQuaternion?.clone() ??
        BABYLON.Quaternion.FromEulerVector(this.headNode.rotation);
      this.headAnimBase = currentQuat.clone();
    }

    const headWorldPos = this.headNode.getAbsolutePosition();
    const dir = this.headLookAtWorld.subtract(headWorldPos);
    if (dir.lengthSquared() < 0.001) return;
    dir.normalize();

    const parent = this.headNode.parent;
    let dirLocal = dir;
    if (parent) {
      parent.computeWorldMatrix(true);
      dirLocal = BABYLON.Vector3.TransformNormal(
        dir,
        BABYLON.Matrix.Invert(parent.getWorldMatrix()),
      ).normalize();
    }

    const faceFwd = new BABYLON.Vector3(0, 0, 1);
    const rotatedFwd = faceFwd.applyRotationQuaternion(this.headAnimBase);

    let dot = clamp(BABYLON.Vector3.Dot(rotatedFwd, dirLocal), -1, 1);
    let angle = Math.acos(dot);
    if (angle < 0.001) return;

    const axis = BABYLON.Vector3.Cross(rotatedFwd, dirLocal);
    if (axis.lengthSquared() < 0.000001) return;
    axis.normalize();

    const delta = BABYLON.Quaternion.RotationAxis(
      axis,
      clamp(this.cfg.GAZE.MAX_HEAD_ANGLE, 0, 0.3),
    );
    const additive = delta.multiply(this.headAnimBase);

    const currentQuat =
      this.headNode.rotationQuaternion?.clone() ??
      BABYLON.Quaternion.FromEulerVector(this.headNode.rotation);
    const headSlerp = clamp(this.HEAD_LERP_SPEED * dt, 0, 0.15);
    this.headNode.rotationQuaternion = BABYLON.Quaternion.Slerp(
      currentQuat,
      additive,
      headSlerp,
    );
  }

  // ── Eye Camera Update ────────────────────────────────────────────────────
  updateEyeCamera() {
    if (!this.eyesReady) return;

    const posL = this.eyeballNodeL.getAbsolutePosition();
    const posR = this.eyeballNodeR.getAbsolutePosition();
    const midpoint = posL.add(posR).scale(0.5);

    let daveFwd;
    if (this.headNode) {
      this.headNode.computeWorldMatrix(true);
      const right = posR.subtract(posL);
      const headToEyes = midpoint.subtract(this.headNode.getAbsolutePosition());
      const rNorm = right.normalize();
      daveFwd = headToEyes
        .subtract(rNorm.scale(BABYLON.Vector3.Dot(headToEyes, rNorm)))
        .normalize();
    } else {
      const fwdAngle = this.root.rotation.y + this.MODEL_FORWARD_OFFSET;
      daveFwd = new BABYLON.Vector3(Math.sin(fwdAngle), 0, Math.cos(fwdAngle));
    }

    const toTarget = this.eyeLookAtWorld.subtract(midpoint);
    let desiredPos, desiredTarget;

    if (toTarget.lengthSquared() < 0.001) {
      desiredPos = midpoint.clone();
      desiredTarget = midpoint.add(daveFwd);
    } else {
      const gazeDir = toTarget.normalize();
      const dot = clamp(BABYLON.Vector3.Dot(daveFwd, gazeDir), -1, 1);
      const angle = Math.acos(dot);

      let clampedTarget;
      if (angle > this.MAX_EYE_ANGLE) {
        const axis = BABYLON.Vector3.Cross(daveFwd, gazeDir);
        if (axis.lengthSquared() < 0.0001) {
          clampedTarget = midpoint.add(daveFwd.scale(5));
        } else {
          axis.normalize();
          const clampedDir = daveFwd.applyRotationQuaternion(
            BABYLON.Quaternion.RotationAxis(axis, this.MAX_EYE_ANGLE),
          );
          clampedTarget = midpoint.add(clampedDir.scale(toTarget.length()));
        }
      } else {
        clampedTarget = this.eyeLookAtWorld;
      }

      const camFwd = clampedTarget.subtract(midpoint).normalize();
      desiredPos = midpoint.add(camFwd.scale(0.3));

      let finalTarget = clampedTarget.clone();
      const dirToTarget = finalTarget.subtract(midpoint).normalize();

      let headUp = new BABYLON.Vector3(0, 1, 0);
      if (this.headNode) {
        this.headNode.computeWorldMatrix(true);
        const headMatrix = this.headNode.getWorldMatrix();
        headUp = BABYLON.Vector3.TransformCoordinates(
          new BABYLON.Vector3(0, 1, 0),
          headMatrix,
        )
          .subtract(this.headNode.getAbsolutePosition())
          .normalize();
      }

      const upComponent = BABYLON.Vector3.Dot(dirToTarget, headUp);
      if (upComponent > 0) {
        const constrainedDir = dirToTarget
          .subtract(headUp.scale(upComponent))
          .normalize();
        const distToTarget = finalTarget.subtract(midpoint).length();
        finalTarget.copyFrom(midpoint.add(constrainedDir.scale(distToTarget)));
      }
      desiredTarget = finalTarget;
    }

    if (this.smoothedEyeCamPos === null) {
      this.smoothedEyeCamPos = desiredPos.clone();
      this.smoothedEyeCamTarget = desiredTarget.clone();
    }

    const blend =
      1.0 -
      Math.exp(
        -(
          this.cfg.PIP_CAMERA.POSITION_SMOOTHING_SPEED *
          this.engine.getDeltaTime()
        ) / 1000,
      );
    this.smoothedEyeCamPos = BABYLON.Vector3.Lerp(
      this.smoothedEyeCamPos,
      desiredPos,
      blend,
    );
    this.smoothedEyeCamTarget = BABYLON.Vector3.Lerp(
      this.smoothedEyeCamTarget,
      desiredTarget,
      blend,
    );
    this.eyeCam.position.copyFrom(this.smoothedEyeCamPos);
    this.eyeCam.setTarget(this.smoothedEyeCamTarget);
  }

  // ── Behavior Update ──────────────────────────────────────────────────────
  getNavigationTarget(realTarget, dt) {
    const agentPos = new BABYLON.Vector3(
      this.daveCapsule.position.x,
      0,
      this.daveCapsule.position.z,
    );
    return this.pathfinder.getNextTarget(
      agentPos,
      realTarget,
      this.cfg.MOVEMENT.WAYPOINT_THRESHOLD,
      this.cfg.MOVEMENT.WAYPOINT_BLEND_SPEED,
      dt,
    );
  }

  startInteraction(descriptor, durationSec) {
    if (!descriptor) return;
    // Cap user-initiated Infinity durations — without this, clicking a couch
    // parks Dave there permanently (interactionDuration -= dt is a no-op).
    const cappedDuration = this._capDuration(durationSec, descriptor);

    // Already getting up — queue the new activity to start after Dave stands.
    if (this.state === S.GETTING_UP) {
      this.nextInteractionPending = descriptor;
      this.nextInteractionDuration = cappedDuration;
      return;
    }

    // Already in an activity — play reverse anim, then start the new one
    // from the GETTING_UP completion path.
    if (this.currentInteraction) {
      // endInteractionWithReverseAnim will run onExit + cancel scheduler.
      this.endInteractionWithReverseAnim();
      this.nextInteractionPending = descriptor;
      this.nextInteractionDuration = cappedDuration;
      return;
    }

    this.currentInteraction = descriptor;
    this.interactionDuration = cappedDuration;
    this.wanderTarget = descriptor.approachPos.clone();
    this.pathfinder.reset();
    this._setState(S.TURNING_TO_APPROACH);
  }

  startRandomInteraction(durationSec) {
    const seats = [...this.interactables.values()];
    if (seats.length === 0) return;
    this.startInteraction(
      seats[Math.floor(Math.random() * seats.length)],
      durationSec,
    );
  }

  // ── Action System ────────────────────────────────────────────────────────
  /**
   * Enter a named action. Sets currentAction, plays the animation defined in
   * ACTION_DEFS, and applies any expression override.  Does NOT touch `state`
   * — locomotion state is managed separately.
   * @param {string} name - Key from ACTION_DEFS
   * @param {number} [speedRatio=1] - Animation playback speed
   */
  _enterAction(name, speedRatio = 1) {
    const def = ACTION_DEFS[name];
    if (!def) {
      console.warn(`[Dave] _enterAction: unknown action "${name}"`);
      return;
    }
    this.currentAction = name;
    if (def.anim) {
      this.animationController.playForward(def.anim, def.loop, speedRatio);
    }
    if (def.expression) {
      this.expressionManager.setExpression(def.expression);
    }
  }

  /**
   * Return to the baseline idle state: clears currentAction, resets `state`
   * to "idle", and starts looping the idle animation.
   */
  _exitToIdle() {
    this.currentAction = null;
    this._setState(S.IDLE);
    this.wanderTimer = 1 + Math.random() * 3;
    this.animationController.playForward("idle", true);
    this._lastWalkPos = null;
    this._stuckAcknowledged = false;
  }

  leaveInteraction() {
    if (this.currentInteraction) {
      this.lastAction = this.currentInteraction.label
        ? `using ${this.currentInteraction.label}`
        : "interacting";

      // Only mark the activity as on cooldown if Dave actually reached it.
      // Otherwise, chatting during the walk to a seat poisons that seat for
      // five minutes and the idle picker stops choosing it.
      const reachedActivity =
        this.state === S.INTERACTING || this.state === S.GETTING_UP;
      if (reachedActivity && this.currentInteraction.label) {
        this._activityCooldowns[this.currentInteraction.label] = Date.now();
      }

      // Tear down the per-activity session (timers, in-flight async).
      if (this._activitySession) {
        const session = this._activitySession;
        this._activitySession = null;
        const activity = this.currentInteraction;
        if (activity?.onExit) {
          try {
            activity.onExit(this, session.scheduler);
          } catch (e) {
            console.error("[Dave] activity.onExit error:", e);
          }
        }
        session.scheduler.cancelAll();
      }

      this.currentInteraction = null;
    }
    this.beerSequenceStartedThisSession = false; // Reset for next interaction
    this.pathfinder.reset();
  }

  endInteractionWithReverseAnim() {
    // Notify departure so the activity can stop intervals / abort async, then
    // tear down the session. Safe to call even after currentInteraction was
    // nulled (e.g., the startInteraction preempt path).
    this.leaveInteraction();

    // When the forward animation completes normally, currentAnimName is null —
    // fall back to currentAction which is still set to "sit" / "laydown".
    const animName =
      this.animationController.currentAnimName ?? this.currentAction;
    if (animName === "sit" || animName === "laydown") {
      this.gettingUpAnim = animName;
      this.gettingUpTimer = Infinity; // primary signal: onComplete callback
      this._gettingUpStartedAt = Date.now(); // wall-clock fallback

      // Play animation in reverse; zero the timer when it actually finishes.
      this.animationController.playReverse(animName, 1, () => {
        this.gettingUpTimer = 0;
      });
      this.currentAction = null;
      this._setState(S.GETTING_UP);
      return;
    }
    // No animation to reverse, go straight to idle
    this._exitToIdle();
  }

  enterTalkingState() {
    this.lastChatTime = Date.now();
    this.lastAction = "talking";

    // Capture what Dave should resume doing after the chat ends. Done BEFORE
    // any state mutation so we can read currentInteraction before it gets
    // nulled by leaveInteraction.
    this._returnAction = this._captureReturnAction();

    // Already sitting at an activity — play the reverse animation first, then
    // turn to camera once Dave is on his feet.
    if (this.state === S.INTERACTING) {
      this.endInteractionWithReverseAnim();
      this.nextStateAfterGetUp = S.TALKING;
      return;
    }

    // Mid-reverse-anim already — let it finish, but redirect the post-reverse
    // step to talking instead of whatever it was going to be. Preserve the
    // pending interaction for resume by hoisting it into _returnAction.
    if (this.state === S.GETTING_UP) {
      if (!this._returnAction && this.nextInteractionPending) {
        this._returnAction = {
          type: "activity",
          activity: this.nextInteractionPending,
          duration: this.nextInteractionDuration,
        };
      }
      this.nextInteractionPending = null;
      this.nextInteractionDuration = Infinity;
      this.nextStateAfterGetUp = S.TALKING;
      return;
    }

    // Walking toward an activity that hasn't been reached yet — abandon the
    // approach cleanly. The activity reference was captured into _returnAction
    // above so exitTalkingState can resume walking after the chat.
    if (
      this.state === S.ALIGNING_TO_INTERACT ||
      this.state === S.WALKING_TO_APPROACH ||
      this.state === S.TURNING_TO_APPROACH
    ) {
      this.leaveInteraction();
    }

    this._setState(S.TURNING_TO_CAMERA);
  }

  // Snapshot of what Dave was doing, used to resume after a chat ends.
  // Captures the activity reference (which leaveInteraction would otherwise
  // null) plus remaining duration.
  _captureReturnAction() {
    if (!this.currentInteraction && !this.nextInteractionPending) return null;

    const approachStates = new Set([
      S.TURNING_TO_APPROACH,
      S.WALKING_TO_APPROACH,
      S.ALIGNING_TO_INTERACT,
      S.INTERACTING,
    ]);
    if (this.currentInteraction && approachStates.has(this.state)) {
      return {
        type: "activity",
        activity: this.currentInteraction,
        duration: this.interactionDuration,
      };
    }
    if (this.state === S.GETTING_UP && this.nextInteractionPending) {
      return {
        type: "activity",
        activity: this.nextInteractionPending,
        duration: this.nextInteractionDuration,
      };
    }
    return null;
  }

  exitTalkingState() {
    const action = this._returnAction;
    this._returnAction = null;

    if (action?.type === "activity" && action.activity) {
      // Walk back to the activity Dave was doing before the chat. If Dave
      // is somewhere illegal for TURNING_TO_APPROACH, this falls back to
      // _setState's warning and continues — better than dropping the action.
      this.startInteraction(action.activity, action.duration);
      return;
    }
    this._exitToIdle();
    const vel = this.davePhysics.body.getLinearVelocity();
    this.davePhysics.body.setLinearVelocity(new BABYLON.Vector3(0, vel.y, 0));
  }

  /**
   * Per-frame stuck-guard check for walking states. Returns true if Dave is
   * judged stuck this frame and a recovery has been kicked off (caller should
   * skip its normal movement step).
   *
   * Stuck = no meaningful displacement for STUCK_TIMEOUT_MS. Recovery: dry
   * grumble via muse, then re-pick a wander target. WALKING_TO_APPROACH
   * additionally abandons the approach since the target furniture is the
   * thing he can't reach.
   */
  _checkStuck() {
    if (this._stuckAcknowledged) return false;
    if (!this._lastWalkPos) return false;

    const now = Date.now();
    const pos = this.daveCapsule.position;
    const dx = pos.x - this._lastWalkPos.x;
    const dz = pos.z - this._lastWalkPos.z;
    const moved = Math.sqrt(dx * dx + dz * dz);

    if (moved > this._STUCK_PROGRESS_THRESHOLD) {
      this._lastWalkPos = pos.clone();
      this._lastWalkProgressAt = now;
      return false;
    }

    if (now - this._lastWalkProgressAt < this._STUCK_TIMEOUT_MS) return false;

    this._stuckAcknowledged = true;
    const wasApproach = this.state === S.WALKING_TO_APPROACH;

    // Non-blocking muse — gated by isMusing and tab visibility, mirroring
    // _tickSpontaneousMuse so we don't burn API calls on a hidden tab.
    const tabHidden = typeof document !== "undefined" && document.hidden;
    if (!this.isMusing && !tabHidden) {
      this.isMusing = true;
      (async () => {
        try {
          const { response: r } = await this.mindClient.muse(
            "You've been trying to walk somewhere but you keep getting stuck against something. Complain about it in one short, dry sentence.",
          );
          if (r?.text) {
            this.expressionManager.setExpression(r.emotion);
            this._lockExpression(3000);
            if (this.onMutter) this.onMutter(r.text);
          }
        } catch {} finally {
          this.isMusing = false;
        }
      })();
    }

    // Abandon the approach so Dave isn't redirected back to the same
    // unreachable furniture; for plain WALKING just pick a fresh target.
    if (wasApproach) {
      this.leaveInteraction();
      this._exitToIdle();
    } else {
      this._fallbackWander();
    }
    return true;
  }

  /**
   * Moves Dave toward this.wanderTarget along the nav path.
   * Stops and resets the path when within `arrivalThreshold` of the real target.
   * @returns {boolean} true when arrived
   */
  _walkToward(dt, arrivalThreshold) {
    const navTarget = this.getNavigationTarget(this.wanderTarget, dt);
    const dir = navTarget.subtract(this.daveCapsule.position);
    dir.y = 0;

    const realDist = this.wanderTarget.subtract(this.daveCapsule.position);
    realDist.y = 0;
    if (realDist.length() < arrivalThreshold) {
      const vel = this.davePhysics.body.getLinearVelocity();
      this.davePhysics.body.setLinearVelocity(new BABYLON.Vector3(0, vel.y, 0));
      this.pathfinder.reset();
      return true;
    }

    const moveDir = dir.normalize().scale(this.walkSpeed);
    this.rotateToward(this.getForwardAngle(navTarget), dt);
    const currentVel = this.davePhysics.body.getLinearVelocity();
    this.davePhysics.body.setLinearVelocity(
      new BABYLON.Vector3(moveDir.x, currentVel.y, moveDir.z),
    );
    return false;
  }

  updateBehavior(dt) {
    if (this.state === S.TALKING || this.state === S.TURNING_TO_CAMERA) {
      const vel = this.davePhysics.body.getLinearVelocity();
      this.davePhysics.body.setLinearVelocity(new BABYLON.Vector3(0, vel.y, 0));
      return;
    }

    // Handle getting up from an interaction (sitting, laydown, etc)
    if (this.state === S.GETTING_UP) {
      const vel = this.davePhysics.body.getLinearVelocity();
      this.davePhysics.body.setLinearVelocity(new BABYLON.Vector3(0, vel.y, 0));

      this.gettingUpTimer -= dt;
      // Wall-clock fallback: if the anim's onComplete never fires (missing
      // animation, early-return from playReverse, etc.) we'd otherwise sit at
      // gettingUpTimer === Infinity forever. Force completion after 3s.
      const stuck =
        this._gettingUpStartedAt > 0 &&
        Date.now() - this._gettingUpStartedAt > this._GETTING_UP_FALLBACK_MS;

      if (this.gettingUpTimer <= 0 || stuck) {
        // Reverse animation finished (or forced complete), transition out.
        this.animationController.stop();
        this.gettingUpAnim = null;
        this._gettingUpStartedAt = 0;

        // If there's a pending interaction, start it
        if (this.nextInteractionPending) {
          const pending = this.nextInteractionPending;
          const duration = this._capDuration(
            this.nextInteractionDuration,
            pending,
          );
          this.nextInteractionPending = null;
          this.nextInteractionDuration = Infinity;

          this.currentInteraction = pending;
          this.interactionDuration = duration;
          this.wanderTarget = pending.approachPos.clone();
          this.pathfinder.reset();
          this._setState(S.TURNING_TO_APPROACH);
        } else if (this.nextStateAfterGetUp) {
          const nextState = this.nextStateAfterGetUp;
          this.nextStateAfterGetUp = null;

          if (nextState === S.TALKING) {
            this._setState(S.TURNING_TO_CAMERA);
          } else {
            this._setState(nextState);
          }
        } else {
          // No pending action, just go to idle
          this._exitToIdle();
        }
      }
      return;
    }

    if (this.state === S.INTERACTING) {
      const vel = this.davePhysics.body.getLinearVelocity();
      this.davePhysics.body.setLinearVelocity(new BABYLON.Vector3(0, vel.y, 0));

      // Trigger beer sequence once per keg session
      if (
        this.currentInteraction &&
        (this.currentInteraction.label === "keg" ||
          this.currentInteraction.label === "kegerator")
      ) {
        if (!this.beerSequenceStartedThisSession) {
          this.beerSequenceStartedThisSession = true;
          this.runBeerSequence().catch(() => {});
        }
      }

      // Per-frame hook for activities that want to drive their own exit
      // condition (e.g., "fade out after speech completes"). Return true to
      // request a natural exit.
      if (this._activitySession && this.currentInteraction?.tick) {
        let wantsExit = false;
        try {
          wantsExit = this.currentInteraction.tick(
            this,
            this._activitySession.scheduler,
            dt,
          );
        } catch (e) {
          console.error("[Dave] activity.tick error:", e);
        }
        if (wantsExit) {
          this.endInteractionWithReverseAnim();
          return;
        }
      }

      // Cap defensively in case a bypass path set Infinity. Real duration
      // capping happens at startInteraction; this is belt-and-suspenders so
      // the FSM can't get stuck on a runaway value.
      if (Number.isFinite(this.interactionDuration)) {
        this.interactionDuration -= dt;
        if (this.interactionDuration <= 0) this.endInteractionWithReverseAnim();
      }
      return;
    }

    if (this.state === S.IDLE) {
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0) this.startWander();
      return;
    }

    if (this.state === S.TURNING) {
      if (this.rotateToward(this.getForwardAngle(this.wanderTarget), dt)) {
        this._setState(S.WALKING);
        const animSpeed = 3.0 + Math.random() * 2.0;
        this.animationController.playForward("shuffle", true, animSpeed);
      }
      return;
    }

    if (this.state === S.WALKING) {
      if (this._checkStuck()) return;
      if (this._walkToward(dt, 0.3)) this._exitToIdle();
      return;
    }

    // Sit sequence
    if (this.state === S.TURNING_TO_APPROACH) {
      if (this.rotateToward(this.getForwardAngle(this.wanderTarget), dt)) {
        this._setState(S.WALKING_TO_APPROACH);
        const animSpeed = 3.0 + Math.random() * 2.0;
        this.animationController.playForward("shuffle", true, animSpeed);
      }
      return;
    }

    if (this.state === S.WALKING_TO_APPROACH) {
      if (this._checkStuck()) return;
      if (this._walkToward(dt, 0.15)) this._setState(S.ALIGNING_TO_INTERACT);
      return;
    }

    if (this.state === S.ALIGNING_TO_INTERACT) {
      if (this.rotateToward(this.currentInteraction.facingAngle, dt)) {
        this.davePhysics.body.disablePreStep = false;
        this.davePhysics.body.setLinearVelocity(BABYLON.Vector3.Zero());
        this.root.rotation.y = this.currentInteraction.facingAngle;

        const activity = this.currentInteraction;
        // Play the activity's entry animation. Activities carry their own
        // anim hint ("sit"/"laydown"/"idle"); fall back to label-based picks
        // for legacy descriptors that don't.
        const animHint = activity.anim;
        if (animHint) {
          this._enterAction(animHint);
        } else if (activity.label === "bed") {
          this._enterAction(this.laydownAnim ? "laydown" : "sit");
        } else if (
          activity.label === "keg" ||
          activity.label === "kegerator"
        ) {
          this._enterAction("idle");
        } else {
          this._enterAction("sit");
        }

        // Establish a per-activity session BEFORE onEnter runs so the activity
        // can register timers / async work scoped to this session. The
        // scheduler auto-cancels everything on leaveInteraction/interrupt.
        this._activitySession = {
          scheduler: new Scheduler(),
          startedAt: Date.now(),
        };
        this._setState(S.INTERACTING);

        // Activity lifecycle — onEnter can be async, but we don't await it
        // (we don't want a slow muse/browse to block the FSM tick). The
        // scheduler.aborted flag handles late returns landing into a state
        // Dave already left.
        if (activity.onEnter) {
          Promise.resolve()
            .then(() => activity.onEnter(this, this._activitySession.scheduler))
            .catch((e) => console.error("[Dave] activity.onEnter error:", e));
        }
      }
      return;
    }
  }

  updateTurnToCamera(dt) {
    if (this.state !== S.TURNING_TO_CAMERA) return;
    if (this.rotateToward(this.getForwardAngle(this.camera.position), dt)) {
      this._setState(S.TALKING);
      this.animationController.playForward("idle", true);
    }
  }

  // ── Beer Sequence ────────────────────────────────────────────────────────
  async playReverseChugAnim() {
    const reverseCbs = {};
    reverseCbs[this.beerCaptureFrame] = () => {
      this.beer.detachDuringReverseAnim();
    };
    return this.animationController.playReverseAsync("chug", 1, reverseCbs);
  }

  async runBeerSequence() {
    if (this.beer.beerSequenceActive) return;
    this.beer.beerSequenceActive = true;
    this.currentAction = "chug";

    if (!this.isMusing) {
      this.isMusing = true;
      (async () => {
        try {
          const { response: r } = await this.mindClient.muse(
            "You just walked up to the kegerator to pour yourself a beer."
          );
          if (r?.text) {
            this.expressionManager.setExpression(r.emotion);
            this._lockExpression(3000);
            if (this.onMutter) this.onMutter(r.text);
          }
        } catch { } finally {
          this.isMusing = false;
        }
      })();
    }

    try {
      // Ensure clean state before starting sequence
      this.beer.beerAttached = false;
      if (this.beer.beerGlassMesh) {
        this.beer.beerGlassMesh.parent = null;
        this.beer.beerGlassMesh.rotationQuaternion = null;
        this.beer.beerGlassMesh.rotation = BABYLON.Vector3.Zero();
        this.beer.beerGlassMesh.position.copyFrom(this.beer.beerRestPos);
      }

      await this.beer.fillBeerWithParticles();
      this.beer.prepBeerAttach(this.imported);

      if (this.chugAnim) {
        const BEER_CAPTURE_FRACTION = 0.5;
        this.beerCaptureFrame =
          this.chugAnim.from +
          (this.chugAnim.to - this.chugAnim.from) * BEER_CAPTURE_FRACTION;

        const forwardCbs = {};
        forwardCbs[this.beerCaptureFrame] = () => {
          this.beer.onBeerCaptureFrame();
        };

        await this.animationController.playAsync("chug", false, 1, forwardCbs);
        this.beer.zeroPhysicsVelocity();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      await this.playReverseChugAnim();
      // Cancel momentum from reverse before returning to rest
      this.beer.cleanupBeerParticles();

      if (this.bodyMorphs.Open) {
        this.setMorph(this.bodyMorphs, "Open", 0);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
      this.beer.detachBeer();
      // Only force IDLE if Dave is still in the keg interaction. If the user
      // chatted in the meantime, Dave is mid-TALKING / TURNING_TO_CAMERA /
      // GETTING_UP and forcing IDLE here would yank him out of the chat.
      if (this.state === S.INTERACTING) {
        this.leaveInteraction();
        this._exitToIdle();
      }
    } catch (err) {
      console.error("[Beer] Error in beer sequence:", err);
      this.beer.detachBeer();
      this.beer.cleanupBeerParticles();
      if (this.state === S.INTERACTING) {
        this.leaveInteraction();
        this._exitToIdle();
      }
    } finally {
      this.beer.beerSequenceActive = false;
    }
  }

  // ── Musing ───────────────────────────────────────────────────────────────
  async triggerMuse(contextStr = "") {
    if (this.isMusing) return null;
    if (
      this.state !== S.IDLE &&
      this.state !== S.WALKING &&
      this.state !== S.INTERACTING
    ) {
      return null;
    }

    // Don't muse right after conversation — it feels like non-sequitur
    const secsSinceChat = (Date.now() - this.lastChatTime) / 1000;
    if (secsSinceChat < 30) return null;

    this.isMusing = true;

    try {
      const { prompt, response: r } = await this.mindClient.muse(contextStr);
      if (this.isBrowsing) {
        this.isMusing = false;
        return null;
      }

      this.expressionManager.setExpression(r.emotion);

      if (r.speechPauseMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(r.speechPauseMs, 1500)),
        );
      }

      this._lockExpression(5000);
      return r; // Return response so scene can handle speech and history
    } catch (err) {
      return null; // Error handling
    } finally {
      this.isMusing = false;
      this.museTimer =
        this.cfg.MUSE.MIN_INTERVAL +
        Math.random() *
          (this.cfg.MUSE.MAX_INTERVAL - this.cfg.MUSE.MIN_INTERVAL);
    }
  }

  // ── LLM-Directed Gaze ─────────────────────────────────────────────────
  // Maps a gaze target string from the LLM to a world position and holds
  // the gaze for a few seconds before random gaze picks resume.
  _applyGazeTarget(target) {
    const eyeHeight =
      this.daveCapsule.position.y + this.cfg.GAZE.EYE_HEIGHT_OFFSET;
    const pos = this.daveCapsule.position;
    const fwd = this.root.rotation.y + this.MODEL_FORWARD_OFFSET;

    switch (target) {
      case "user":
        this.eyeLookAtTarget = this.camera.position.clone();
        break;
      case "screen":
        if (this.screenMesh) {
          this.screenMesh.computeWorldMatrix(true);
          const center =
            this.screenMesh.getBoundingInfo().boundingBox.centerWorld;
          this.eyeLookAtTarget = center.clone();
        }
        break;
      case "floor":
        this.eyeLookAtTarget = new BABYLON.Vector3(
          pos.x + Math.sin(fwd) * 2,
          0,
          pos.z + Math.cos(fwd) * 2,
        );
        break;
      case "away": {
        const awayAngle = fwd + (Math.random() > 0.5 ? 1 : -1) * (0.8 + Math.random() * 1.2);
        this.eyeLookAtTarget = new BABYLON.Vector3(
          pos.x + Math.sin(awayAngle) * 5,
          eyeHeight - 0.5,
          pos.z + Math.cos(awayAngle) * 5,
        );
        break;
      }
      case "sky":
        this.eyeLookAtTarget = new BABYLON.Vector3(
          pos.x + Math.sin(fwd) * 2,
          eyeHeight + 5,
          pos.z + Math.cos(fwd) * 2,
        );
        break;
      default:
        return; // Unknown target, don't override
    }

    // Hold the LLM gaze longer than random picks
    this.gazeTimer = 4 + Math.random() * 3;
  }

  // ── User Awareness ──────────────────────────────────────────────────────
  // Called by the scene when the user's tab becomes visible again
  onUserArrive() {
    this.userPresent = true;
    this._tabHiddenAt = null;
    this._applyGazeTarget("user");
    // Brief curiosity — someone's back
    if (this.state !== S.TALKING && this.state !== S.TURNING_TO_CAMERA) {
      this.expressionManager.setExpression("fleeting-curiosity");
      this._lockExpression(2500);
    }
  }

  // Called when the user's tab is hidden
  onUserDepart() {
    this.userPresent = false;
    this._tabHiddenAt = Date.now();
    if (this.state !== S.TALKING && this.state !== S.TURNING_TO_CAMERA) {
      const isolated = ["melancholy", "boredom", "resignation"];
      const pick = isolated[Math.floor(Math.random() * isolated.length)];
      this.expressionManager.setExpression(pick);
      this._lockExpression(5000);
      this._applyGazeTarget("floor");
    }
  }

  // Called when the user watches for a while without interacting
  async onUserLinger() {
    if (
      this.state === S.TALKING ||
      this.state === S.TURNING_TO_CAMERA ||
      this.isBrowsing ||
      this.isMusing
    )
      return;
    this._applyGazeTarget("user");
    this.gazeTimer = 1.5 + Math.random() * 1.5;

    if (Math.random() < 0.4) {
      this.isMusing = true;
      try {
        const { response: r } = await this.mindClient.muse(
          "You notice someone has been silently watching you for a while. Say something about being observed — one short sentence in your voice."
        );
        if (r?.text && this.onMutter) {
          setTimeout(() => this.onMutter(r.text), 800 + Math.random() * 1200);
        }
      } catch {
        // silent on error
      } finally {
        this.isMusing = false;
      }
    }
  }

  // ── Thinking State ────────────────────────────────────────────────────
  // Plays the thinking animation with cycling eyebrow raises, wide eyes,
  // and eyes scanning up side to side while waiting for LLM response.

  startThinking() {
    this._thinkingActive = true;
    this._thinkingBrowTimer = 0;
    this._thinkingBrowPhase = 0;
    this._thinkingGazeTimer = 0;
    this._thinkingGazeSide = 1;

    // Play thinking anim (looped), fall back to idle if not found
    if (this.ANIM_MAP.thinking) {
      this.animationController.playForward("thinking", true);
    }

    // Wide eyes
    this.expressionManager.setMorphDirect("eyelid", "Wide", 0.4);
    // Start with left eyebrow raised
    this.expressionManager.setMorphDirect("eyebrow", "Raise.L", 0.6);
    this.expressionManager.setMorphDirect("eyebrow", "Raise.R", 0);
  }

  stopThinking() {
    this._thinkingActive = false;

    // Clear thinking morphs
    this.expressionManager.setMorphDirect("eyelid", "Wide", 0);
    this.expressionManager.setMorphDirect("eyebrow", "Raise.L", 0);
    this.expressionManager.setMorphDirect("eyebrow", "Raise.R", 0);

    // Return to idle anim
    this.animationController.playForward("idle", true);
  }

  _updateThinking(dt) {
    if (!this._thinkingActive) return;

    // Alternate eyebrow raises every ~1.2 seconds
    this._thinkingBrowTimer -= dt;
    if (this._thinkingBrowTimer <= 0) {
      this._thinkingBrowPhase = 1 - this._thinkingBrowPhase;
      if (this._thinkingBrowPhase === 0) {
        this.expressionManager.setMorphDirect("eyebrow", "Raise.L", 0.6);
        this.expressionManager.setMorphDirect("eyebrow", "Raise.R", 0.1);
      } else {
        this.expressionManager.setMorphDirect("eyebrow", "Raise.L", 0.1);
        this.expressionManager.setMorphDirect("eyebrow", "Raise.R", 0.6);
      }
      this._thinkingBrowTimer = 1.0 + Math.random() * 0.5;
    }

    // Eyes scan up and side to side every ~0.8 seconds
    this._thinkingGazeTimer -= dt;
    if (this._thinkingGazeTimer <= 0) {
      this._thinkingGazeSide *= -1;
      const eyeHeight = this.daveCapsule.position.y + this.cfg.GAZE.EYE_HEIGHT_OFFSET;
      const fwd = this.root.rotation.y + this.MODEL_FORWARD_OFFSET;
      const sideOffset = this._thinkingGazeSide * 2.5;
      // Look up and to the side
      this.eyeLookAtTarget = new BABYLON.Vector3(
        this.daveCapsule.position.x + Math.sin(fwd) * 2 + Math.cos(fwd) * sideOffset,
        eyeHeight + 1.5,
        this.daveCapsule.position.z + Math.cos(fwd) * 2 - Math.sin(fwd) * sideOffset,
      );
      this._thinkingGazeTimer = 0.6 + Math.random() * 0.5;
      this.gazeTimer = this._thinkingGazeTimer + 0.5; // Prevent normal gaze from overriding
    }
  }

  // ── Expression Lock Helper ──────────────────────────────────────────────
  // Prevents the idle expression tick from overwriting an important expression
  // for `delayMs` milliseconds, then it naturally fades back via the tick.
  _lockExpression(delayMs = 2000) {
    this.expressionLockedUntil = Date.now() + delayMs;
  }

  // ── Idle Expression Variation ────────────────────────────────────────────
  _tickIdleExpression(dt) {
    if (this.isMusing || this.isBrowsing) return;
    if (
      this.state !== S.IDLE &&
      this.state !== S.WALKING &&
      this.state !== S.INTERACTING
    )
      return;
    if (Date.now() < this.expressionLockedUntil) return; // mid-expression, let it finish

    this.museTimer -= dt;
    if (this.museTimer > 0) return;

    this.museTimer =
      this.cfg.MUSE.MIN_INTERVAL +
      Math.random() * (this.cfg.MUSE.MAX_INTERVAL - this.cfg.MUSE.MIN_INTERVAL);

    const idleExpressions = [
      "melancholy",
      "dry-amusement",
      "boredom",
      "resignation",
      "fleeting-curiosity",
      "weary-contempt",
    ];
    const available = idleExpressions.filter(
      (e) =>
        e !== this.expressionManager.currentEmotion &&
        this.expressionManager.expressions[e],
    );
    if (available.length === 0) return;

    const pick = available[Math.floor(Math.random() * available.length)];
    this.expressionManager.setExpression(pick);
    this._lockExpression(3000 + Math.random() * 4000);
  }

  // ── Neglect Phase ─────────────────────────────────────────────────────────
  _getNeglectPhase() {
    if (!this._tabHiddenAt) return 0;
    const hiddenMin = (Date.now() - this._tabHiddenAt) / 60000;
    if (hiddenMin >= 30) return 2;
    if (hiddenMin >= 10) return 1;
    return 0;
  }

  // ── Spontaneous Idle Musings ──────────────────────────────────────────────
  _tickSpontaneousMuse(dt) {
    if (typeof document !== "undefined" && document.hidden) return;
    if (this.isMusing || this.isBrowsing || this.isWatchingTv) return;
    if (this.state !== S.IDLE && this.state !== S.WALKING) return;

    this._idleMuseTimer -= dt;
    if (this._idleMuseTimer > 0) return;
    this._idleMuseTimer = 90 + Math.random() * 90;

    if (Math.random() < 0.5) return; // only fire ~half the intervals

    const secsSinceChat = (Date.now() - this.lastChatTime) / 1000;
    if (secsSinceChat < 30) return;

    this.isMusing = true;
    const context = this._buildIdleMuseContext();
    (async () => {
      try {
        const { response: r } = await this.mindClient.muse(context);
        if (!r?.text) return;
        this.expressionManager.setExpression(r.emotion);
        this._lockExpression(3000);
        if (this.onMutter) this.onMutter(r.text);
      } catch { } finally {
        this.isMusing = false;
      }
    })();
  }

  _buildIdleMuseContext() {
    const label = this.currentInteraction?.label;
    if (label === "bed") return "You are lying on the bed, staring at the ceiling.";
    if (label === "keg" || label === "kegerator") return "You are standing by the kegerator.";
    if (label === "couch") return "You are sitting on the couch.";
    if (this.state === S.WALKING) return "You are wandering through the room with no particular destination.";
    return "You are standing alone in silence.";
  }

  // ── Mood Arc Tick ─────────────────────────────────────────────────────────
  _tickMoodArc(dt) {
    this._moodArcElapsed += dt;
    this._moodArcTimer -= dt;
    if (this._moodArcTimer <= 0) {
      const transitions = MOOD_ARC_TRANSITIONS[this._moodArc] || ["boredom"];
      this._moodArc = transitions[Math.floor(Math.random() * transitions.length)];
      this._moodArcTimer = 300 + Math.random() * 300;
      this._moodArcElapsed = 0;
    }
  }

  // ── Fidget Behaviors ──────────────────────────────────────────────────────
  _updateFidgets(dt) {
    if (this.state !== S.IDLE && this.state !== S.WALKING && this.state !== S.INTERACTING) return;
    if (this.isBrowsing || this._thinkingActive) return;

    // Occasional look-at-self: glance down and to the side
    this._lookAtSelfTimer -= dt;
    if (this._lookAtSelfTimer <= 0) {
      const pos = this.daveCapsule.position;
      const fwd = this.root.rotation.y + this.MODEL_FORWARD_OFFSET;
      const side = (Math.random() > 0.5 ? 1 : -1) * (0.7 + Math.random() * 0.6);
      this.eyeLookAtTarget = new BABYLON.Vector3(
        pos.x + Math.sin(fwd) * 0.4 + Math.cos(fwd) * side,
        pos.y + 0.4 + Math.random() * 0.4,
        pos.z + Math.cos(fwd) * 0.4 - Math.sin(fwd) * side,
      );
      this.gazeTimer = 1.2 + Math.random() * 1.5;
      this._lookAtSelfTimer = 25 + Math.random() * 35;
    }

    // Fatigue: slow idle animation when alone for more than 5 minutes
    const minsAlone = (Date.now() - this.lastChatTime) / 60000;
    const shouldFatigue = minsAlone > 5;
    if (shouldFatigue !== this._fatigueActive) {
      this._fatigueActive = shouldFatigue;
      if (this.state === S.IDLE) {
        this.animationController.playForward("idle", true, shouldFatigue ? 0.6 : 1.0);
      }
    }
  }

  // ── Main Update Loop ─────────────────────────────────────────────────────
  update(dt) {
    // Update blinking and eye morphs
    this.updateBlink(dt);

    // Apply expression morph targets
    this.expressionManager.update();

    // Beer system updates — update() syncs physics every frame
    this.beer.update();

    // Idle expression variation
    this._tickIdleExpression(dt);

    // Spontaneous idle musings
    this._tickSpontaneousMuse(dt);

    // Mood arc drift
    this._tickMoodArc(dt);

    // Fidget behaviors (look-at-self, fatigue)
    this._updateFidgets(dt);

    // Thinking state cycling effects
    this._updateThinking(dt);

    // Movement FSM
    this.updateBehavior(dt);
    this.updateTurnToCamera(dt);

    // Gaze and head tracking
    this.updateEyeLookAt(dt);
    this.updateHeadLookAt(dt);
    this.updateEyeCamera();
  }

  debugDrawPath(scene) {
    if (this.pathVisuals) {
      this.pathVisuals.forEach((m) => m.dispose());
      this.pathVisuals = null;
      return;
    }

    this.pathVisuals = this.pathfinder.visualizePath(
      scene,
      this.pathfinder.currentPath,
      this.pathfinder.pathIndex,
    );
  }
}

export default Dave;
