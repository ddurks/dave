/**
 * D.A.V.E. Beer System
 * Encapsulates all beer interaction logic:
 * - Beer glass attachment and hand tracking
 * - Particle effects for beer overflow
 * - Animation coordination (chug animation)
 * - Physics management for beer glass and particles
 */

export class Beer {
  /**
   * Constructor
   * @param {BABYLON.Scene} scene - Babylon.js scene
   * @param {BABYLON.Mesh} beerGlassMesh - The beer glass mesh
   * @param {BABYLON.Vector3} beerRestPos - Rest position for beer glass
   */
  constructor(scene, beerGlassMesh, beerRestPos) {
    this.scene = scene;
    this.beerGlassMesh = beerGlassMesh;
    this.beerRestPos = beerRestPos;

    // ── Physics (ANIMATED so particles collide with the glass) ───────────
    if (beerGlassMesh) {
      this.beerAggregate = new BABYLON.PhysicsAggregate(
        beerGlassMesh,
        BABYLON.PhysicsShapeType.MESH,
        { mass: 0, restitution: 0.2, friction: 0.5 },
        scene,
      );
      this.beerAggregate.body.setMotionType(BABYLON.PhysicsMotionType.ANIMATED);
      this.beerAggregate.body.disablePreStep = false;
      this.beerAggregate.body.setCollisionCallbackEnabled(true);
    } else {
      this.beerAggregate = null;
    }

    // ── Particle System ──────────────────────────────────────────────────
    this.beerParticleInstances = [];
    this.beerEmitInterval = null;
    this.beerSequenceActive = false;

    // ── Materials ────────────────────────────────────────────────────────
    this.beerLiquidMaterial = new BABYLON.StandardMaterial(
      "beerLiquidMat",
      scene,
    );
    this.beerLiquidMaterial.diffuseColor = new BABYLON.Color3(1.0, 0.72, 0.05);
    this.beerLiquidMaterial.emissiveColor = new BABYLON.Color3(0.3, 0.2, 0.0);
    this.beerLiquidMaterial.alpha = 0.82;

    this.beerFoamMaterial = new BABYLON.StandardMaterial("beerFoamMat", scene);
    this.beerFoamMaterial.diffuseColor = new BABYLON.Color3(1.0, 0.97, 0.88);
    this.beerFoamMaterial.emissiveColor = new BABYLON.Color3(0.4, 0.38, 0.3);
    this.beerFoamMaterial.alpha = 0.92;

    // ── Hand Attachment ─────────────────────────────────────────────────
    this.beerAttached = false;
    this.beerHandNodeL = null;
    this.beerHandNodeR = null;
    this.beerHandLocalPos = null;
    this.beerHandLocalRot = null;
    this.beerCaptureFrame = null;
    this.beerPrevPos = new BABYLON.Vector3();
    this.beerPrevRot = new BABYLON.Quaternion();
    this._beerTmpMat = new BABYLON.Matrix();
    this._beerTmpRot = new BABYLON.Quaternion();

    // ── Constants ────────────────────────────────────────────────────────
    this.PARTICLE_DIAMETER_MIN = 0.05;
    this.PARTICLE_DIAMETER_MAX = 0.1;
    this.PARTICLE_SPAWN_HEIGHT = 0.5;
    this.PARTICLE_SCATTER = 0.05;
    this.PARTICLE_VELOCITY = -2;
  }

  /**
   * Emit beer particles (foam bubbles and liquid drops)
   * @param {boolean} active - True to start emission, false to stop
   */
  emitBeerParticles(active) {
    if (active) {
      this.beerEmitInterval = setInterval(() => {
        if (!this.beerGlassMesh) return;

        const beerWorldPos = this.beerGlassMesh.getAbsolutePosition();
        const spawnY = beerWorldPos.y + this.PARTICLE_SPAWN_HEIGHT;

        for (let i = 0; i < 3; i++) {
          const diameter =
            this.PARTICLE_DIAMETER_MIN +
            Math.random() *
              (this.PARTICLE_DIAMETER_MAX - this.PARTICLE_DIAMETER_MIN);
          const particle = BABYLON.MeshBuilder.CreateSphere(
            "beerParticle",
            { diameter },
            this.scene,
          );
          particle.position = new BABYLON.Vector3(
            beerWorldPos.x + (Math.random() - 0.5) * this.PARTICLE_SCATTER,
            spawnY,
            beerWorldPos.z + (Math.random() - 0.5) * this.PARTICLE_SCATTER,
          );
          const isTop = this.beerParticleInstances.length % 4 === 0;
          particle.material = isTop
            ? this.beerFoamMaterial
            : this.beerLiquidMaterial;
          const aggregate = new BABYLON.PhysicsAggregate(
            particle,
            BABYLON.PhysicsShapeType.SPHERE,
            {
              mass: 0.5,
              restitution: 0.1,
              friction: 0.8,
              radius: diameter / 2,
            },
            this.scene,
          );
          aggregate.body.setCollisionCallbackEnabled(true);
          aggregate.body.setLinearVelocity(
            new BABYLON.Vector3(0, this.PARTICLE_VELOCITY, 0),
          );
          this.beerParticleInstances.push({ mesh: particle, aggregate });
        }
      }, 50);
    } else {
      clearInterval(this.beerEmitInterval);
      this.beerEmitInterval = null;
    }
  }

  /**
   * Fill beer glass with foam and liquid particles over time
   */
  async fillBeerWithParticles() {
    this.emitBeerParticles(true);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    this.emitBeerParticles(false);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  /**
   * Prepare beer glass for hand attachment
   * @param {object} imported - Dave's imported model data with transformNodes
   */
  prepBeerAttach(imported) {
    if (!this.beerGlassMesh) return;

    // Find both hands for centering
    if (!this.beerHandNodeL) {
      this.beerHandNodeL = this.findTransformNode(
        imported,
        "hand.l",
        "hand.thumb.l",
      );
    }
    if (!this.beerHandNodeR) {
      this.beerHandNodeR = this.findTransformNode(
        imported,
        "hand.r",
        "hand.thumb.r",
      );
    }
    if (!this.beerHandNodeL || !this.beerHandNodeR) {
      return;
    }

    this.beerGlassMesh.parent = null;
    if (!this.beerGlassMesh.rotationQuaternion) {
      this.beerGlassMesh.rotationQuaternion = BABYLON.Quaternion.Identity();
    }
  }

  /**
   * Helper: Find transform node by name
   * @private
   */
  findTransformNode(imported, ...names) {
    for (const name of names) {
      const node = imported.transformNodes.find((n) => n.name === name);
      if (node) return node;
    }
    return null;
  }

  /**
   * Capture grip offset when beer is grabbed
   */
  captureGripOffset() {
    if (!this.beerHandNodeL || !this.beerHandNodeR || !this.beerGlassMesh)
      return;

    this.beerHandNodeL.computeWorldMatrix(true);
    this.beerHandNodeR.computeWorldMatrix(true);

    // Calculate center point between both hands
    const leftWorld = this.beerHandNodeL.getAbsolutePosition();
    const rightWorld = this.beerHandNodeR.getAbsolutePosition();
    const centerWorld = leftWorld.add(rightWorld).scale(0.5);

    // Calculate offset in hand-local space so it rotates correctly with
    // the hand throughout the full chug animation (including apex tilt)
    const beerRestWorldPos = this.beerRestPos.clone();
    const worldOffset = beerRestWorldPos.subtract(centerWorld);
    const handQuatConj =
      this.beerHandNodeR.absoluteRotationQuaternion.conjugate();
    BABYLON.Matrix.FromQuaternionToRef(handQuatConj, this._beerTmpMat);
    this.beerHandLocalPos = BABYLON.Vector3.TransformCoordinates(
      worldOffset,
      this._beerTmpMat,
    );

    // Use right hand rotation as reference for beer orientation
    this.beerHandLocalRot = handQuatConj;
    this.beerAttached = true;
  }

  /**
   * Detach beer from hands and return to rest position
   */
  detachBeer() {
    if (!this.beerGlassMesh) return;

    this.beerAttached = false;
    this.beerGlassMesh.rotationQuaternion = null;
    this.beerGlassMesh.rotation = BABYLON.Vector3.Zero();
    this.beerGlassMesh.position.copyFrom(this.beerRestPos);
    this._syncPhysicsToMesh();
  }

  /**
   * Sync physics body transform to the current mesh world matrix.
   * Must be called every frame (after animations) to keep the ANIMATED
   * body locked to the mesh whether attached or at rest.
   * @private
   */
  _syncPhysicsToMesh() {
    if (!this.beerAggregate?.body || !this.beerGlassMesh) return;
    this.beerGlassMesh.computeWorldMatrix(true);
    const worldMatrix = this.beerGlassMesh.getWorldMatrix();
    const pos = new BABYLON.Vector3();
    const rot = new BABYLON.Quaternion();
    const scale = new BABYLON.Vector3();
    worldMatrix.decompose(scale, rot, pos);
    this.beerAggregate.body.setTargetTransform(pos, rot);
  }

  /**
   * Zero linear and angular velocity on the physics body.
   * Call at animation transition points to prevent momentum carry-over.
   */
  zeroPhysicsVelocity() {
    if (!this.beerAggregate?.body) return;
    this.beerAggregate.body.setLinearVelocity(BABYLON.Vector3.Zero());
    this.beerAggregate.body.setAngularVelocity(BABYLON.Vector3.Zero());
  }

  /**
   * Update beer glass position and rotation based on hand attachment,
   * then sync the physics body to the new mesh transform.
   * Safe to call every frame — only moves the mesh when truly attached.
   */
  updateBeerHandAttachment() {
    if (
      this.beerAttached &&
      this.beerHandNodeL &&
      this.beerHandNodeR &&
      this.beerGlassMesh
    ) {
      this.beerHandNodeL.computeWorldMatrix(true);
      this.beerHandNodeR.computeWorldMatrix(true);

      // Center point between both hands
      const leftWorld = this.beerHandNodeL.getAbsolutePosition();
      const rightWorld = this.beerHandNodeR.getAbsolutePosition();
      const centerWorld = leftWorld.add(rightWorld).scale(0.5);

      if (this.beerHandLocalPos) {
        // Rotate the hand-local offset back to world space using the current hand orientation
        BABYLON.Matrix.FromQuaternionToRef(
          this.beerHandNodeR.absoluteRotationQuaternion,
          this._beerTmpMat,
        );
        const worldOffset = BABYLON.Vector3.TransformCoordinates(
          this.beerHandLocalPos,
          this._beerTmpMat,
        );
        this.beerGlassMesh.position.copyFrom(centerWorld.add(worldOffset));
      }
      if (this.beerHandLocalRot) {
        const handQuat = this.beerHandNodeR.absoluteRotationQuaternion;
        this.beerGlassMesh.rotationQuaternion = handQuat.multiply(
          this.beerHandLocalRot,
        );
      }
    }

    // Always keep the physics body pinned to wherever the mesh is
    this._syncPhysicsToMesh();
  }

  /**
   * Clean up all beer particles
   */
  cleanupBeerParticles() {
    for (let i = this.beerParticleInstances.length - 1; i >= 0; i--) {
      this.beerParticleInstances[i].aggregate.dispose();
      this.beerParticleInstances[i].mesh.dispose();
    }
    this.beerParticleInstances = [];
  }

  update() {
    this.updateBeerHandAttachment();
    this.updateBeerParticles();
  }

  /**
   * Update beer particles (remove those that fell below world)
   */
  updateBeerParticles() {
    // Clean up particles that fell below the world
    for (let i = this.beerParticleInstances.length - 1; i >= 0; i--) {
      const p = this.beerParticleInstances[i];
      if (p.mesh.position.y < -5) {
        p.aggregate.dispose();
        p.mesh.dispose();
        this.beerParticleInstances.splice(i, 1);
      }
    }
  }

  /**
   * Callback when beer capture frame is reached during chug animation
   * Captures the grip offset at the right moment
   */
  onBeerCaptureFrame() {
    this.captureGripOffset();
  }

  /**
   * Callback to detach beer during reverse animation
   */
  detachDuringReverseAnim() {
    this.detachBeer();
  }

  /**
   * Cleanup and dispose of all resources
   */
  dispose() {
    clearInterval(this.beerEmitInterval);
    this.cleanupBeerParticles();
    if (this.beerAggregate) this.beerAggregate.dispose();
    this.beerLiquidMaterial.dispose();
    this.beerFoamMaterial.dispose();
  }
}

export default Beer;
