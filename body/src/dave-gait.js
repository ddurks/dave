/**
 * Dave Gait
 * Procedural stepping for Dave's legs: feet stay planted on the floor while
 * the body moves, and step one at a time with a hold (and a random
 * hesitation) between steps. The body only advances while a foot is in the
 * air, so the walk lurches instead of gliding.
 *
 * Rig (body/blender/davebot.blend): ik.foot.{l,r} mark each foot's home
 * under the hip, ik.pole.{l,r} sit in front of the knees to set the bend
 * direction. Tuning comes from the gait_* extras on the Armature node.
 * Runs after animations, overriding femur/tibia/foot on top of whatever
 * clip is playing, and fades in/out so seated and lying clips are untouched.
 * Arms swing opposite the feet on loose springs, so they dangle and lag.
 */

import { clamp } from "./utils.js";

const SIDES = ["l", "r"];
const UP = BABYLON.Vector3.Up();
const FADE_SPEED = 5; // weight units per second
const CROUCH_SPEED = 4;
const DROP_DECAY = 10;
const SETTLE_DIST = 0.04; // standing feet this far off home step back under the hips
const SETTLE_ANGLE = 0.3; // radians
const LEG_STRAIGHT = 0.99; // planted legs extend to this fraction of full length
// Arm springs: soft and under-damped so the arms trail, overshoot and dangle.
const ARM_STIFFNESS = 120;
const ARM_DAMPING = 12;
const ELBOW_STIFFNESS = 60;
const ELBOW_DAMPING = 8;
const MAX_SPRING_STEP = 1 / 120; // seconds per integration substep

const DEFAULTS = {
  gait_stride: 0.4,
  gait_step_height: 0.1,
  gait_step_time: 0.2,
  gait_hold_time: 0.15,
  gait_hesitation: 0.6,
  gait_hip_drop: 0.02,
  gait_crouch: 0.01, // base knee softness; the hips also dip as far as the feet need
  gait_hip_forward: 0.05, // hips ride this far ahead of the feet while walking
  gait_head_droop: 8, // degrees the head hangs forward while walking
  gait_arm_swing: 18, // degrees each arm swings either side of hanging
  gait_elbow_swing: 15, // extra degrees the elbow bends on the forward swing
};

export class DaveGait {
  /**
   * @param {object} imported - { transformNodes } from the davebot import
   */
  constructor(imported) {
    const node = (name) => imported.transformNodes.find((t) => t.name === name);
    this.armature = node("Armature");
    const extras = this.armature.metadata?.gltf?.extras ?? {};
    const p = { ...DEFAULTS, ...extras };
    this.stride = p.gait_stride;
    this.stepHeight = p.gait_step_height;
    this.stepTime = p.gait_step_time;
    this.holdTime = p.gait_hold_time;
    this.hesitation = p.gait_hesitation;
    this.hipDrop = p.gait_hip_drop;
    this.crouchDepth = p.gait_crouch;
    this.hipForward = p.gait_hip_forward;
    this.headDroop = (p.gait_head_droop * Math.PI) / 180;
    // The neck, not the head: the head belongs to the look-at system.
    this.neck = node("neck");
    this.armSwing = (p.gait_arm_swing * Math.PI) / 180;
    this.elbowSwing = (p.gait_elbow_swing * Math.PI) / 180;

    this.legs = SIDES.map((side) => ({
      side,
      femur: node(`femur.${side}`),
      tibia: node(`tibia.${side}`),
      foot: node(`foot.${side}`),
      toe: node(`toe.${side}`),
      target: node(`ik.foot.${side}`),
      pole: node(`ik.pole.${side}`),
      pos: null, // planted (or swinging) ankle position, world
      heading: null, // planted foot direction, world, horizontal
      swing: null, // { from, fromHeading, t }
    }));

    // Each arm follows the opposite leg.
    this.arms = SIDES.map((side, i) => ({
      humerus: node(`humerus.${side}`),
      radius: node(`radius.${side}`),
      leg: this.legs[1 - i],
      swing: 0, // radians forward of hanging
      swingVel: 0,
      bend: 0, // extra elbow bend, radians
      bendVel: 0,
    }));

    // Every bone we rotate, with the pose it had before we touched it.
    this.driven = [
      this.neck,
      ...this.legs.flatMap((l) => [l.femur, l.tibia, l.foot]),
      ...this.arms.flatMap((a) => [a.humerus, a.radius]),
    ].map(
      (bone) => ({ bone, base: null, written: null }),
    );

    this.armatureBase = this.armature.position.clone();
    this.weight = 0;
    this.active = false;
    this.moving = false;
    this.crouch = 0;
    this.drop = 0;
    this.hold = 0;
    this.lastLeg = this.legs[1];
    this.speed = 0;
    // How far the body really moves per step (physics doesn't track the
    // commanded speed exactly). Each foot is planted for one step, so it
    // lands half of this ahead of home and lifts half of it behind.
    this.advance = this.stride / 2;
  }

  /**
   * Body speed for this frame, world units per second. Non-zero only while
   * a foot is in the air, peaking mid-swing.
   */
  bodySpeed() {
    return this.speed;
  }

  /**
   * @param {number} dt - seconds
   * @param {boolean} active - legs are ours (standing or walking states)
   * @param {boolean} moving - the body wants to travel forward
   */
  update(dt, active, moving) {
    this.active = active;
    this.moving = moving && active;
    const prevWeight = this.weight;
    this.weight = clamp(this.weight + (active ? 1 : -1) * FADE_SPEED * dt, 0, 1);
    this.armature.position.copyFrom(this.armatureBase);
    this._restoreUnanimated();
    if (this.weight === 0) {
      this.speed = 0;
      for (const leg of this.legs) leg.pos = null;
      for (const arm of this.arms) arm.swing = arm.swingVel = arm.bend = arm.bendVel = 0;
      return;
    }
    this.armature.computeWorldMatrix(true);
    for (const leg of this.legs) {
      this._refreshChain(leg);
      leg.length ??=
        BABYLON.Vector3.Distance(leg.femur.getAbsolutePosition(), leg.tibia.getAbsolutePosition()) +
        BABYLON.Vector3.Distance(leg.tibia.getAbsolutePosition(), leg.foot.getAbsolutePosition());
    }

    const homes = this.legs.map((leg) => leg.target.getAbsolutePosition().clone());
    const fwd = this._forward(this.legs[0], homes[0]);
    if (prevWeight === 0 || !this.legs[0].pos) this._plantAll(homes, fwd);

    this._plan(dt, homes, fwd);

    this.crouch += ((this.moving ? 1 : 0) - this.crouch) * Math.min(1, CROUCH_SPEED * dt);
    this.drop *= Math.exp(-DROP_DECAY * dt);
    // Hips ride forward over the feet and dip only as far as the planted feet
    // need to stay reachable with nearly straight legs, plus the footfall bob.
    const ahead = this.crouch * this.hipForward * this.weight;
    const lower =
      (this.crouch * this.crouchDepth + this._reachDrop(fwd.scale(ahead)) + this.drop * this.hipDrop) *
      this.weight;
    if (lower > 0 || ahead > 0) {
      const parentInv = this.armature.parent.getWorldMatrix().clone().invert();
      const shift = UP.scale(-lower).add(fwd.scale(ahead));
      this.armature.position.addInPlace(BABYLON.Vector3.TransformNormal(shift, parentInv));
      this.armature.computeWorldMatrix(true);
      for (const leg of this.legs) this._refreshChain(leg);
    }

    for (const leg of this.legs) this._solve(leg);
    this._swingArms(dt, homes, fwd);

    // Mope: let the head hang forward a little.
    const droop = this.headDroop * this.crouch * this.weight;
    if (droop > 0) rotateAboutWorld(this.neck, BABYLON.Vector3.Cross(UP, fwd), droop);
    for (const d of this.driven) d.written = d.bone.rotationQuaternion?.clone() ?? null;
  }

  // A bone the current clip doesn't key still holds what we wrote last
  // frame; put its own pose back so our rotations don't stack up.
  _restoreUnanimated() {
    for (const d of this.driven) {
      const q = d.bone.rotationQuaternion;
      if (q && d.written && q.equals(d.written)) q.copyFrom(d.base);
      d.base = q?.clone() ?? null;
      d.written = null;
    }
  }

  // ── Step planning ──────────────────────────────────────────────────────────

  _plantAll(homes, fwd) {
    this.legs.forEach((leg, i) => {
      const ankle = leg.foot.getAbsolutePosition().clone();
      ankle.y = homes[i].y;
      leg.pos = ankle;
      leg.heading = fwd.clone();
      leg.swing = null;
    });
    this.hold = 0;
  }

  _plan(dt, homes, fwd) {
    const reach = this.moving ? this.stride / 2 : 0;
    const land = this.moving ? this.advance / 2 : 0;
    this.speed = 0;
    this.hold -= dt;

    const swinging = this.legs.findIndex((leg) => leg.swing);
    if (swinging >= 0) {
      const leg = this.legs[swinging];
      const s = leg.swing;
      s.t = Math.min(1, s.t + dt / this.stepTime);
      // Fast lift, then a clunky settle onto the floor.
      const e = 1 - Math.pow(1 - s.t, 3);
      const target = homes[swinging].add(fwd.scale(land));
      leg.pos = BABYLON.Vector3.Lerp(s.from, target, e);
      leg.pos.y += Math.sin(Math.PI * s.t) * this.stepHeight;
      leg.heading = BABYLON.Vector3.Lerp(s.fromHeading, fwd, e).normalize();
      if (this.moving) {
        // Integrates to stride/2 over the swing: the body covers half a stride per step.
        this.speed = (reach * Math.PI * Math.sin(Math.PI * s.t)) / (2 * this.stepTime);
      }
      if (s.t >= 1) {
        if (this.moving) {
          const moved = BABYLON.Vector3.Dot(homes[swinging].subtract(s.home), fwd);
          this.advance = clamp(0.5 * this.advance + 0.5 * moved, 0, reach);
        }
        leg.pos = target;
        leg.swing = null;
        this.lastLeg = leg;
        this.drop = 1;
        this.hold = this.holdTime * (1 + Math.random() * this.hesitation);
      }
      return;
    }
    if (this.hold > 0) return;

    let next = null;
    if (this.moving) {
      next = this.legs.find((leg) => leg !== this.lastLeg);
    } else {
      // Standing: step whichever foot is furthest from home, if any is off.
      let worst = 0;
      this.legs.forEach((leg, i) => {
        const off = flat(leg.pos.subtract(homes[i])).length();
        const turn = Math.acos(clamp(BABYLON.Vector3.Dot(leg.heading, fwd), -1, 1));
        const err = Math.max(off / SETTLE_DIST, turn / SETTLE_ANGLE);
        if (err > 1 && err > worst) {
          worst = err;
          next = leg;
        }
      });
    }
    if (next) {
      const home = homes[this.legs.indexOf(next)].clone();
      next.swing = { from: next.pos.clone(), fromHeading: next.heading.clone(), home, t: 0 };
    }
  }

  // How far the hips must come down for every planted foot to be in reach.
  _reachDrop(hipShift) {
    let drop = 0;
    for (const leg of this.legs) {
      if (leg.swing) continue;
      const hip = leg.femur.getAbsolutePosition().add(hipShift);
      const x = flat(leg.pos.subtract(hip)).length();
      const reach = LEG_STRAIGHT * leg.length;
      const height = hip.y - leg.pos.y;
      drop = Math.max(drop, height - Math.sqrt(Math.max(0, reach * reach - x * x)));
    }
    return drop;
  }

  _forward(leg, home) {
    const f = flat(leg.pole.getAbsolutePosition().subtract(home));
    return f.normalize();
  }

  // ── Arms ───────────────────────────────────────────────────────────────────

  _swingArms(dt, homes, fwd) {
    // Down-hanging arms swing forward about this axis.
    const axis = BABYLON.Vector3.Cross(UP.scale(-1), fwd);
    const half = Math.max(this.advance / 2, 1e-3);
    for (const arm of this.arms) {
      // Where the opposite foot is in its stride: -1 behind, +1 ahead.
      const i = this.legs.indexOf(arm.leg);
      const phase = clamp(BABYLON.Vector3.Dot(arm.leg.pos.subtract(homes[i]), fwd) / half, -1, 1);
      const target = phase * this.armSwing * this.crouch;
      for (let left = dt; left > 0; left -= MAX_SPRING_STEP) {
        const h = Math.min(left, MAX_SPRING_STEP);
        arm.swingVel += (ARM_STIFFNESS * (target - arm.swing) - ARM_DAMPING * arm.swingVel) * h;
        arm.swing += arm.swingVel * h;
        // Elbow bends only forward, more as the arm comes forward.
        const bendTarget = (Math.max(0, arm.swing) / Math.max(this.armSwing, 1e-3)) * this.elbowSwing;
        arm.bendVel += (ELBOW_STIFFNESS * (bendTarget - arm.bend) - ELBOW_DAMPING * arm.bendVel) * h;
        arm.bend = Math.max(0, arm.bend + arm.bendVel * h);
      }
      rotateAboutWorld(arm.humerus, axis, arm.swing * this.weight);
      arm.radius.computeWorldMatrix(true);
      rotateAboutWorld(arm.radius, axis, arm.bend * this.weight);
    }
  }

  // ── Two-bone IK ────────────────────────────────────────────────────────────

  _refreshChain(leg) {
    for (const n of [leg.femur, leg.tibia, leg.foot, leg.toe, leg.target, leg.pole]) {
      n.computeWorldMatrix(true);
    }
  }

  _solve(leg) {
    const w = this.weight;
    const a = leg.femur.getAbsolutePosition().clone();
    const b = leg.tibia.getAbsolutePosition().clone();
    const c = leg.foot.getAbsolutePosition().clone();
    const l1 = b.subtract(a).length();
    const l2 = c.subtract(b).length();

    const toTarget = leg.pos.subtract(a);
    const d = clamp(toTarget.length(), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
    const dir = toTarget.normalize();
    let bend = leg.pole.getAbsolutePosition().subtract(a);
    bend = bend.subtract(dir.scale(BABYLON.Vector3.Dot(bend, dir))).normalize();
    const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const knee = a.add(dir.scale(along)).add(bend.scale(Math.sqrt(Math.max(0, l1 * l1 - along * along))));
    const ankle = a.add(dir.scale(d));

    rotateToward(leg.femur, b.subtract(a), knee.subtract(a), w);
    leg.tibia.computeWorldMatrix(true);
    leg.foot.computeWorldMatrix(true);
    const b2 = leg.tibia.getAbsolutePosition().clone();
    rotateToward(leg.tibia, leg.foot.getAbsolutePosition().subtract(b2), ankle.subtract(b2), w);
    leg.foot.computeWorldMatrix(true);
    leg.toe.computeWorldMatrix(true);
    const toeDir = leg.toe.getAbsolutePosition().subtract(leg.foot.getAbsolutePosition());
    rotateToward(leg.foot, toeDir, leg.heading, w);
    leg.toe.computeWorldMatrix(true);
  }
}

function flat(v) {
  return new BABYLON.Vector3(v.x, 0, v.z);
}

/**
 * Rotate `node` about its pivot so world direction `from` turns toward `to`,
 * by `weight` of the full angle.
 */
function rotateToward(node, from, to, weight) {
  const f = from.normalizeToNew();
  const t = to.normalizeToNew();
  const axis = BABYLON.Vector3.Cross(f, t);
  const sin = axis.length();
  if (sin < 1e-6) return;
  rotateAboutWorld(node, axis, Math.atan2(sin, BABYLON.Vector3.Dot(f, t)) * weight);
}

/**
 * Rotate `node` about its pivot by `angle` around world-space `axis`.
 * Works in the parent's frame, so it holds up under the glTF root's
 * mirroring scale.
 */
function rotateAboutWorld(node, axis, angle) {
  node.parent.computeWorldMatrix(true);
  const parentWorld = node.parent.getWorldMatrix();
  if (parentWorld.determinant() < 0) angle = -angle;
  const localAxis = BABYLON.Vector3.TransformNormal(axis, parentWorld.clone().invert()).normalize();
  const q = BABYLON.Quaternion.RotationAxis(localAxis, angle);
  node.rotationQuaternion = q.multiply(node.rotationQuaternion ?? BABYLON.Quaternion.Identity());
  node.computeWorldMatrix(true);
}

export default DaveGait;
