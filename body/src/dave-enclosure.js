/**
 * D.A.V.E. Enclosure & Props System
 * Manages environment objects: camera character, screen, lamps, beer glass, etc.
 * Provides classes and loading utilities for environment props.
 */

/**
 * CamCharacter - The camera character (cam.glb) that observes from the orbital camera position
 */
export class CamCharacter {
  constructor(scene, cfg, root, meshes) {
    this.scene = scene;
    this.cfg = cfg;
    this.root = root;
    this.meshes = meshes;

    // Setup rotation (Euler)
    this.root.rotationQuaternion = null;

    // Find key meshes
    const eyelidMesh = this.findMesh("eyelid");
    const eyebrowMesh = this.findMesh("eyebrow");
    const eyeballMesh = this.findMesh("eyeball");

    // Morph target maps
    this.eyelidMorphs = this.getMorphMap(eyelidMesh);
    this.eyebrowMorphs = this.getMorphMap(eyebrowMesh);
    this.eyeballMorphs = this.getMorphMap(eyeballMesh);

    // Blink state
    this.blinkTimer = 2 + Math.random() * 4;
    this.blinkPhase = 0; // 0=waiting, 1=closing, 2=opening
    this.blinkProgress = 0;

    // Expression state
    this.exprTargets = {
      eyelid: { Close: 0, Wide: 0, Droop: 0, Squint: 0, Sad: 0 },
      eyebrow: { Raise: 0, "Raise.L": 0, "Raise.R": 0, Furrow: 0, Sad: 0 },
    };
    this.exprTimer = 4 + Math.random() * 6;

    // Expression presets
    this.expressions = [
      { eyelid: { Droop: 0.3 }, eyebrow: { Sad: 0.3 } },
      { eyelid: { Squint: 0.2 }, eyebrow: { Furrow: 0.3 } },
      { eyelid: { Wide: 0.2 }, eyebrow: { Raise: 0.4 } },
      { eyelid: {}, eyebrow: { "Raise.L": 0.4 } },
      { eyelid: { Droop: 0.4, Sad: 0.2 }, eyebrow: { Sad: 0.5 } },
      { eyelid: {}, eyebrow: {} }, // neutral
    ];
  }

  findMesh(keyword) {
    return this.meshes.find((m) =>
      m.name.toLowerCase().includes(keyword.toLowerCase()),
    );
  }

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

  setMorph(morphMap, name, value) {
    const t = morphMap[name];
    if (!t) return;
    t.influence = Math.max(0, Math.min(1, value));
  }

  lerpMorph(morphMap, name, target, speed) {
    const t = morphMap[name];
    if (!t) return;
    t.influence = Math.max(
      0,
      Math.min(1, t.influence + (target - t.influence) * speed),
    );
  }

  updateBlink(dt) {
    if (this.blinkPhase === 0) {
      this.blinkTimer -= dt;
      if (this.blinkTimer <= 0) {
        this.blinkPhase = 1;
        this.blinkProgress = 0;
      }
    } else if (this.blinkPhase === 1) {
      this.blinkProgress += dt * 12;
      this.setMorph(
        this.eyelidMorphs,
        "Close",
        Math.min(1, this.blinkProgress),
      );
      if (this.blinkProgress >= 1) {
        this.blinkPhase = 2;
        this.blinkProgress = 1;
      }
    } else {
      this.blinkProgress -= dt * 8;
      this.setMorph(
        this.eyelidMorphs,
        "Close",
        Math.max(0, this.blinkProgress),
      );
      if (this.blinkProgress <= 0) {
        this.blinkPhase = 0;
        this.blinkTimer = 2 + Math.random() * 5;
        this.setMorph(this.eyelidMorphs, "Close", 0);
      }
    }
  }

  updateExpression(dt) {
    this.exprTimer -= dt;
    if (this.exprTimer <= 0) {
      const pick =
        this.expressions[Math.floor(Math.random() * this.expressions.length)];
      this.exprTargets.eyelid = { ...this.exprTargets.eyelid, ...pick.eyelid };
      this.exprTargets.eyebrow = {
        ...this.exprTargets.eyebrow,
        ...pick.eyebrow,
      };
      this.exprTimer = 4 + Math.random() * 8;
    }

    const speed = dt * this.cfg.EXPRESSION.LERP_SPEED;
    for (const [name, target] of Object.entries(this.exprTargets.eyelid)) {
      if (name !== "Close")
        this.lerpMorph(this.eyelidMorphs, name, target, speed);
    }
    for (const [name, target] of Object.entries(this.exprTargets.eyebrow)) {
      this.lerpMorph(this.eyebrowMorphs, name, target, speed);
    }
  }

  updateGaze(cameraTarget, cameraPos) {
    // Point eyes toward orbit target
    const toTarget = cameraTarget.subtract(cameraPos);
    if (toTarget.lengthSquared() < 0.001) {
      this.setMorph(this.eyeballMorphs, "Left", 0);
      this.setMorph(this.eyeballMorphs, "Right", 0);
      this.setMorph(this.eyeballMorphs, "Up", 0);
      this.setMorph(this.eyeballMorphs, "Down", 0);
      return;
    }

    // For now, just center the eyes on orbit target
    this.setMorph(this.eyeballMorphs, "Left", 0);
    this.setMorph(this.eyeballMorphs, "Right", 0);
    this.setMorph(this.eyeballMorphs, "Up", 0);
    this.setMorph(this.eyeballMorphs, "Down", 0);
  }

  update(dt, cameraTarget, cameraPos) {
    this.updateBlink(dt);
    this.updateExpression(dt);
    this.updateGaze(cameraTarget, cameraPos);
  }
}

/**
 * Screen - Generalized screen/display (computer, TV, etc.) with dynamic texture
 */
export class Screen {
  constructor(scene, cfg, mesh, textureName = "screenTex") {
    this.scene = scene;
    this.cfg = cfg;
    this.mesh = mesh;

    // Create dynamic texture
    this.texture = new BABYLON.DynamicTexture(
      textureName,
      { width: cfg.SCREEN.TEXTURE_SIZE, height: cfg.SCREEN.TEXTURE_SIZE },
      scene,
      false,
    );

    // Create material
    this.material = new BABYLON.StandardMaterial(textureName + "Mat", scene);
    this.material.diffuseTexture = this.texture;
    this.material.emissiveTexture = this.texture;
    this.material.emissiveColor = new BABYLON.Color3(1, 1, 1);
    this.material.specularColor = new BABYLON.Color3(0, 0, 0);
    this.material.backFaceCulling = false;

    if (this.mesh) {
      this.mesh.material = this.material;
    }
  }

  dispose() {
    this.texture.dispose();
    this.material.dispose();
  }
}

/**
 * Lamp - Furniture with a point light
 */
export class Lamp {
  constructor(scene, cfg, mesh, position, label) {
    this.scene = scene;
    this.cfg = cfg;
    this.mesh = mesh;
    this.label = label;

    // Create point light at position
    this.light = new BABYLON.PointLight(`lamp_${label}`, position, scene);
    this.light.diffuse = new BABYLON.Color3(
      cfg.ENVIRONMENT.LAMP_COLOR.r,
      cfg.ENVIRONMENT.LAMP_COLOR.g,
      cfg.ENVIRONMENT.LAMP_COLOR.b,
    );
    this.light.intensity = cfg.ENVIRONMENT.LAMP_INTENSITY;
    this.light.range = cfg.ENVIRONMENT.LAMP_RANGE;
  }

  dispose() {
    this.light.dispose();
  }
}
