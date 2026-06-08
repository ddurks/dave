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
    this.state = "idle";
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
    this.isBrowsing = false;
    this.browseInterval = null;

    // ── Musing ───────────────────────────────────────────────────────────────
    this.isMusing = false;
    this.museTimer =
      this.cfg.MUSE.MIN_INTERVAL +
      Math.random() * (this.cfg.MUSE.MAX_INTERVAL - this.cfg.MUSE.MIN_INTERVAL);
    this.expressionLockedUntil = 0; // timestamp — idle tick won't overwrite before this

    // ── Idle Context Tracking ────────────────────────────────────────────────
    this.lastAction = null; // e.g. "sitting on couch", "browsing", "talking"
    this.lastChatTime = Date.now();
    this._idleRequestPending = false;
    this.userPresent = true; // Whether the user's tab is active/visible

    // ── Talking State ────────────────────────────────────────────────────────
    this.wasInteractingBeforeTalk = false;

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
    this._idleRequestPending = true;

    const context = {
      lastAction: this.lastAction,
      minutesAlone: Math.round((Date.now() - this.lastChatTime) / 60000),
      currentEmotion: this.expressionManager.currentEmotion,
      userPresent: this.userPresent,
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
      // Pick a seat (couch or chair, not bed/keg)
      const seats = [...this.interactables.values()].filter(
        (d) => d.label === "couch" || d.label === "chair",
      );
      if (seats.length > 0) {
        const pick = seats[Math.floor(Math.random() * seats.length)];
        this.startInteraction(pick, directive.durationSec || 30);
        this.lastAction = `sitting on ${pick.label}`;
        return;
      }
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
    this.state = "turning";
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

    if (this.state === "talking" || this.state === "turning-to-camera") {
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

    // If already getting up, just queue the new interaction — don't interrupt the reverse
    if (this.state === "getting-up") {
      this.nextInteractionPending = descriptor;
      this.nextInteractionDuration = durationSec || Infinity;
      return;
    }

    // If already in an interaction, get up with reverse animation first
    if (this.currentInteraction) {
      if (this.currentInteraction.onDepart) this.currentInteraction.onDepart();
      this.currentInteraction = null;

      // Play reverse animation to get up (no teleport, Dave gets up in place)
      this.endInteractionWithReverseAnim();

      // Queue up the next interaction to start after getting up
      this.nextInteractionPending = descriptor;
      this.nextInteractionDuration = durationSec || Infinity;
      return;
    }

    this.currentInteraction = descriptor;
    this.interactionDuration = durationSec || Infinity;
    this.wanderTarget = descriptor.approachPos.clone();
    this.pathfinder.reset();
    this.state = "turning-to-approach";
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
    this.state = "idle";
    this.wanderTimer = 1 + Math.random() * 3;
    this.animationController.playForward("idle", true);
  }

  leaveInteraction() {
    if (this.currentInteraction) {
      this.lastAction = this.currentInteraction.label
        ? `using ${this.currentInteraction.label}`
        : "interacting";
      if (this.currentInteraction.onDepart) this.currentInteraction.onDepart();
      this.currentInteraction = null;
    }
    this.beerSequenceStartedThisSession = false; // Reset for next interaction
    this.pathfinder.reset();
  }

  endInteractionWithReverseAnim() {
    // When the forward animation completes normally, currentAnimName is null —
    // fall back to currentAction which is still set to "sit" / "laydown".
    const animName =
      this.animationController.currentAnimName ?? this.currentAction;
    if (animName === "sit" || animName === "laydown") {
      this.gettingUpAnim = animName;
      this.gettingUpTimer = Infinity; // driven by onComplete, not a timed estimate

      // Play animation in reverse; zero the timer when it actually finishes
      this.animationController.playReverse(animName, 1, () => {
        this.gettingUpTimer = 0;
      });
      this.currentAction = null;
      this.state = "getting-up";
      return;
    }
    // No animation to reverse, go straight to idle
    this._exitToIdle();
  }

  enterTalkingState() {
    // If interacting, play reverse animation first before talking
    if (this.state === "interacting") {
      this.endInteractionWithReverseAnim();
      this.wasInteractingBeforeTalk = true;
      this.nextStateAfterGetUp = "talking";
      return;
    }

    if (
      this.state === "aligning-to-interact" ||
      this.state === "walking-to-approach" ||
      this.state === "turning-to-approach"
    ) {
      this.leaveInteraction();
    }

    this.wasInteractingBeforeTalk = false;
    this.state = "turning-to-camera";
  }

  exitTalkingState() {
    if (this.wasInteractingBeforeTalk && this.currentInteraction) {
      this.state = "interacting";
      this.wasInteractingBeforeTalk = false;
      return;
    }
    this.wasInteractingBeforeTalk = false;
    this._exitToIdle();
    const vel = this.davePhysics.body.getLinearVelocity();
    this.davePhysics.body.setLinearVelocity(new BABYLON.Vector3(0, vel.y, 0));
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
    if (this.state === "talking" || this.state === "turning-to-camera") {
      const vel = this.davePhysics.body.getLinearVelocity();
      this.davePhysics.body.setLinearVelocity(new BABYLON.Vector3(0, vel.y, 0));
      return;
    }

    // Handle getting up from an interaction (sitting, laydown, etc)
    if (this.state === "getting-up") {
      const vel = this.davePhysics.body.getLinearVelocity();
      this.davePhysics.body.setLinearVelocity(new BABYLON.Vector3(0, vel.y, 0));

      this.gettingUpTimer -= dt;
      if (this.gettingUpTimer <= 0) {
        // Reverse animation finished, transition to idle
        this.animationController.stop();
        this.gettingUpAnim = null;

        // If there's a pending interaction, start it
        if (this.nextInteractionPending) {
          const pending = this.nextInteractionPending;
          const duration = this.nextInteractionDuration;
          this.nextInteractionPending = null;
          this.nextInteractionDuration = Infinity;

          this.currentInteraction = pending;
          this.interactionDuration = duration;
          this.wanderTarget = pending.approachPos.clone();
          this.pathfinder.reset();
          this.state = "turning-to-approach";
        } else if (this.nextStateAfterGetUp) {
          // Transition to queued state (e.g., "talking")
          const nextState = this.nextStateAfterGetUp;
          this.nextStateAfterGetUp = null;

          if (nextState === "talking") {
            this.state = "turning-to-camera";
            this.wasInteractingBeforeTalk = true;
          } else {
            this.state = nextState;
          }
        } else {
          // No pending action, just go to idle
          this._exitToIdle();
        }
      }
      return;
    }

    if (this.state === "interacting") {
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

      this.interactionDuration -= dt;
      if (this.interactionDuration <= 0) this.endInteractionWithReverseAnim();
      return;
    }

    if (this.state === "idle") {
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0) this.startWander();
      return;
    }

    if (this.state === "turning") {
      if (this.rotateToward(this.getForwardAngle(this.wanderTarget), dt)) {
        this.state = "walking";
        const animSpeed = 3.0 + Math.random() * 2.0;
        this.animationController.playForward("shuffle", true, animSpeed);
      }
      return;
    }

    if (this.state === "walking") {
      if (this._walkToward(dt, 0.3)) this._exitToIdle();
      return;
    }

    // Sit sequence
    if (this.state === "turning-to-approach") {
      if (this.rotateToward(this.getForwardAngle(this.wanderTarget), dt)) {
        this.state = "walking-to-approach";
        const animSpeed = 3.0 + Math.random() * 2.0;
        this.animationController.playForward("shuffle", true, animSpeed);
      }
      return;
    }

    if (this.state === "walking-to-approach") {
      if (this._walkToward(dt, 0.15)) this.state = "aligning-to-interact";
      return;
    }

    if (this.state === "aligning-to-interact") {
      if (this.rotateToward(this.currentInteraction.facingAngle, dt)) {
        this.davePhysics.body.disablePreStep = false;
        this.davePhysics.body.setLinearVelocity(BABYLON.Vector3.Zero());
        this.root.rotation.y = this.currentInteraction.facingAngle;

        // Play appropriate animation and trigger behavior based on interaction type
        const interactionLabel = this.currentInteraction.label;
        if (interactionLabel === "bed") {
          this._enterAction(this.laydownAnim ? "laydown" : "sit");
        } else if (
          interactionLabel === "keg" ||
          interactionLabel === "kegerator"
        ) {
          this._enterAction("idle"); // beer sequence will set currentAction = "chug" when it starts
        } else if (
          interactionLabel === "chair" ||
          interactionLabel === "computer"
        ) {
          this._enterAction("sit"); // chair browsing will be triggered by onArrive callback
        } else {
          // couch, etc.
          this._enterAction("sit");
        }

        if (this.currentInteraction.onArrive)
          this.currentInteraction.onArrive();
        this.state = "interacting";
      }
      return;
    }
  }

  updateTurnToCamera(dt) {
    if (this.state !== "turning-to-camera") return;
    if (this.rotateToward(this.getForwardAngle(this.camera.position), dt)) {
      this.state = "talking";
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
      this.leaveInteraction();
      this._exitToIdle();
    } catch (err) {
      console.error("[Beer] Error in beer sequence:", err);
      this.beer.detachBeer();
      this.beer.cleanupBeerParticles();
      this.leaveInteraction();
      this._exitToIdle();
    } finally {
      this.beer.beerSequenceActive = false;
    }
  }

  // ── Musing ───────────────────────────────────────────────────────────────
  async triggerMuse(contextStr = "") {
    if (this.isMusing) return null;
    if (
      this.state !== "idle" &&
      this.state !== "walking" &&
      this.state !== "interacting" &&
      this.state !== "lying"
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
    this._applyGazeTarget("user");
    // Brief curiosity — someone's back
    if (this.state !== "talking" && this.state !== "turning-to-camera") {
      this.expressionManager.setExpression("fleeting-curiosity");
      this._lockExpression(2500);
    }
  }

  // Called when the user's tab is hidden
  onUserDepart() {
    this.userPresent = false;
    if (this.state !== "talking" && this.state !== "turning-to-camera") {
      const isolated = ["melancholy", "boredom", "resignation"];
      const pick = isolated[Math.floor(Math.random() * isolated.length)];
      this.expressionManager.setExpression(pick);
      this._lockExpression(5000);
      this._applyGazeTarget("floor");
    }
  }

  // Called when the user watches for a while without interacting
  onUserLinger() {
    if (
      this.state === "talking" ||
      this.state === "turning-to-camera" ||
      this.isBrowsing
    )
      return;
    // Quick glance at camera — Dave notices you're still there
    this._applyGazeTarget("user");
    this.gazeTimer = 1.5 + Math.random() * 1.5;
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
      this.state !== "idle" &&
      this.state !== "walking" &&
      this.state !== "interacting"
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
