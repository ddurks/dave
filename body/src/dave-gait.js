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
 */

import { clamp } from "./utils.js";

const SIDES = ["l", "r"];
const UP = BABYLON.Vector3.Up();
const FADE_SPEED = 5; // weight units per second
const CROUCH_SPEED = 4;
const DROP_DECAY = 10;
const SETTLE_DIST = 0.04; // standing feet this far off home step back under the hips
const SETTLE_ANGLE = 0.3; // radians

const DEFAULTS = {
  gait_stride: 0.7,
  gait_step_height: 0.1,
  gait_step_time: 0.22,
  gait_hold_time: 0.2,
  gait_hesitation: 0.6,
  gait_hip_drop: 0.05,
  gait_crouch: 0.1,
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

    this.armatureBase = this.armature.position.clone();
    this.weight = 0;
    this.active = false;
    this.moving = false;
    this.crouch = 0;
    this.drop = 0;
    this.hold = 0;
    this.lastLeg = this.legs[1];
    this.speed = 0;
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
    if (this.weight === 0) {
      this.speed = 0;
      for (const leg of this.legs) leg.pos = null;
      return;
    }
    this.armature.computeWorldMatrix(true);
    for (const leg of this.legs) this._refreshChain(leg);

    const homes = this.legs.map((leg) => leg.target.getAbsolutePosition().clone());
    const fwd = this._forward(this.legs[0], homes[0]);
    if (prevWeight === 0 || !this.legs[0].pos) this._plantAll(homes, fwd);

    this._plan(dt, homes, fwd);

    this.crouch += ((this.moving ? 1 : 0) - this.crouch) * Math.min(1, CROUCH_SPEED * dt);
    this.drop *= Math.exp(-DROP_DECAY * dt);
    const lower = (this.crouch * this.crouchDepth + this.drop * this.hipDrop) * this.weight;
    if (lower > 0) {
      const parentInv = this.armature.parent.getWorldMatrix().clone().invert();
      const down = BABYLON.Vector3.TransformNormal(UP.scale(-lower), parentInv);
      this.armature.position.addInPlace(down);
      this.armature.computeWorldMatrix(true);
      for (const leg of this.legs) this._refreshChain(leg);
    }

    for (const leg of this.legs) this._solve(leg);
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
    this.speed = 0;
    this.hold -= dt;

    const swinging = this.legs.findIndex((leg) => leg.swing);
    if (swinging >= 0) {
      const leg = this.legs[swinging];
      const s = leg.swing;
      s.t = Math.min(1, s.t + dt / this.stepTime);
      // Fast lift, then a clunky settle onto the floor.
      const e = 1 - Math.pow(1 - s.t, 3);
      const target = homes[swinging].add(fwd.scale(reach));
      leg.pos = BABYLON.Vector3.Lerp(s.from, target, e);
      leg.pos.y += Math.sin(Math.PI * s.t) * this.stepHeight;
      leg.heading = BABYLON.Vector3.Lerp(s.fromHeading, fwd, e).normalize();
      if (this.moving) {
        // Integrates to stride/2 over the swing: the body covers half a stride per step.
        this.speed = (reach * Math.PI * Math.sin(Math.PI * s.t)) / (2 * this.stepTime);
      }
      if (s.t >= 1) {
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
      next.swing = { from: next.pos.clone(), fromHeading: next.heading.clone(), t: 0 };
    }
  }

  _forward(leg, home) {
    const f = flat(leg.pole.getAbsolutePosition().subtract(home));
    return f.normalize();
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
 * by `weight` of the full angle. Works in the parent's frame, so it holds up
 * under the glTF root's mirroring scale.
 */
function rotateToward(node, from, to, weight) {
  const f = from.normalizeToNew();
  const t = to.normalizeToNew();
  const axis = BABYLON.Vector3.Cross(f, t);
  const sin = axis.length();
  if (sin < 1e-6) return;
  let angle = Math.atan2(sin, BABYLON.Vector3.Dot(f, t)) * weight;
  const parentWorld = node.parent.getWorldMatrix();
  if (parentWorld.determinant() < 0) angle = -angle;
  const localAxis = BABYLON.Vector3.TransformNormal(axis, parentWorld.clone().invert()).normalize();
  const q = BABYLON.Quaternion.RotationAxis(localAxis, angle);
  node.rotationQuaternion = q.multiply(node.rotationQuaternion ?? BABYLON.Quaternion.Identity());
  node.computeWorldMatrix(true);
}

export default DaveGait;
