/**
 * Navigation Grid
 * Discretized grid for walkability checks and A* pathfinding
 */
export class NavGrid {
  constructor(enclosureImported, wallPositions, cfg) {
    const GRID_CELL_SIZE = 0.4; // meters per cell
    const GRID_BOUNDS = 25; // grid spans ±GRID_BOUNDS in x,z
    const DAVE_RADIUS = 0.1; // collision buffer around Dave — tighter to furniture
    const WALL_HEIGHT = 6; // from scene setup

    this.gridSize = Math.ceil((GRID_BOUNDS * 2) / GRID_CELL_SIZE);
    this.walkable = new Uint8Array(this.gridSize * this.gridSize);
    this.GRID_CELL_SIZE = GRID_CELL_SIZE;
    this.GRID_BOUNDS = GRID_BOUNDS;
    this.DAVE_RADIUS = DAVE_RADIUS;

    this.buildFromFurniture(enclosureImported, wallPositions, WALL_HEIGHT);
  }

  buildFromFurniture(enclosureImported, wallPositions, WALL_HEIGHT) {
    // Mark everything walkable by default
    this.walkable.fill(1);

    // Mark furniture and walls as unwalkable
    for (const mesh of enclosureImported.meshes) {
      if (!mesh.getTotalVertices || mesh.getTotalVertices() === 0) continue;
      const bounds = mesh.getBoundingInfo().boundingBox;
      const expandedMin = bounds.minimumWorld.clone();
      const expandedMax = bounds.maximumWorld.clone();

      // Expand by collision radius to account for Dave's size
      expandedMin.x -= this.DAVE_RADIUS;
      expandedMin.z -= this.DAVE_RADIUS;
      expandedMax.x += this.DAVE_RADIUS;
      expandedMax.z += this.DAVE_RADIUS;

      this.markBlockedRegion(expandedMin, expandedMax);
    }

    // Walls removed - only blocking furniture now
  }

  markBlockedRegion(min, max) {
    const minCell = this.worldToGrid(min);
    const maxCell = this.worldToGrid(max);
    const clamp = (val, lo, hi) => Math.max(lo, Math.min(hi, val));
    const x1 = clamp(Math.floor(minCell.x), 0, this.gridSize - 1);
    const x2 = clamp(Math.ceil(maxCell.x), 0, this.gridSize - 1);
    const z1 = clamp(Math.floor(minCell.z), 0, this.gridSize - 1);
    const z2 = clamp(Math.ceil(maxCell.z), 0, this.gridSize - 1);

    for (let z = z1; z <= z2; z++) {
      for (let x = x1; x <= x2; x++) {
        this.walkable[z * this.gridSize + x] = 0;
      }
    }
  }

  worldToGrid(pos) {
    const x = (pos.x + this.GRID_BOUNDS) / this.GRID_CELL_SIZE;
    const z = (pos.z + this.GRID_BOUNDS) / this.GRID_CELL_SIZE;
    return { x, z };
  }

  gridToWorld(x, z) {
    return new BABYLON.Vector3(
      x * this.GRID_CELL_SIZE - this.GRID_BOUNDS,
      0,
      z * this.GRID_CELL_SIZE - this.GRID_BOUNDS,
    );
  }

  isWalkable(x, z) {
    if (x < 0 || x >= this.gridSize || z < 0 || z >= this.gridSize)
      return false;
    return this.walkable[z * this.gridSize + x] === 1;
  }

  createVisualization(scene) {
    if (this.visualMeshes) {
      this.visualMeshes.forEach((m) => m.dispose());
      this.visualMeshes = null;
      return;
    }

    const blockMeshes = [];
    let blockCount = 0;

    for (let z = 0; z < this.gridSize; z++) {
      for (let x = 0; x < this.gridSize; x++) {
        if (this.walkable[z * this.gridSize + x] === 0) {
          const pos = this.gridToWorld(x, z);
          const box = BABYLON.MeshBuilder.CreateBox(
            "block",
            {
              width: this.GRID_CELL_SIZE * 0.9,
              height: 0.05,
              depth: this.GRID_CELL_SIZE * 0.9,
            },
            scene,
          );
          box.position.set(pos.x, 0.025, pos.z);
          blockMeshes.push(box);
          blockCount++;
        }
      }
    }

    if (blockMeshes.length > 0) {
      const merged = BABYLON.Mesh.MergeMeshes(blockMeshes, true, true);
      const mat = new BABYLON.StandardMaterial("grid_mat", scene);
      mat.diffuse = new BABYLON.Color3(1, 0, 0);
      mat.alpha = 0.7;
      merged.material = mat;
      this.visualMeshes = [merged];
    }
  }
}

/**
 * Pathfinder
 * A* pathfinding algorithm for navigation mesh-based movement
 */
export class Pathfinder {
  /**
   * @param {NavGrid} navGrid - Navigation grid for walkability checks
   */
  constructor(navGrid) {
    this.navGrid = navGrid;

    // ── Path-following state ─────────────────────────────────────────────────
    this.currentPath = [];
    this.pathIndex = 0;
    this.lastNavTarget = new BABYLON.Vector3(0, 0, 0);
    this.smoothedNavTarget = new BABYLON.Vector3(0, 0, 0);
    this.navTargetBlendFactor = 0;
  }

  /** Clear current path so the next getNextTarget() call recalculates. */
  reset() {
    this.currentPath = [];
    this.pathIndex = 0;
    this.navTargetBlendFactor = 0;
  }

  /**
   * Returns the next smoothed waypoint toward realTarget, recalculating the
   * A* path when the target changes significantly.
   * @param {BABYLON.Vector3} agentPos - Current agent position (y ignored)
   * @param {BABYLON.Vector3} realTarget - Desired world destination
   * @param {number} waypointThreshold - Distance at which a waypoint is considered reached
   * @param {number} blendSpeed - Rate at which navTargetBlendFactor advances
   * @param {number} dt - Delta time in seconds
   * @returns {BABYLON.Vector3} Next position to steer toward
   */
  getNextTarget(agentPos, realTarget, waypointThreshold, blendSpeed, dt) {
    const targetChanged =
      this.lastNavTarget.subtract(realTarget).length() > 1.0;

    let pathWasRecalculated = false;
    if (this.currentPath.length === 0 || targetChanged) {
      this.currentPath = this.findPath(agentPos, realTarget);
      this.lastNavTarget.copyFrom(realTarget);
      this.pathIndex = 0;
      this.navTargetBlendFactor = 0;
      pathWasRecalculated = true;
    }

    if (
      !pathWasRecalculated &&
      this.currentPath.length > 0 &&
      this.pathIndex < this.currentPath.length
    ) {
      const waypoint = this.currentPath[this.pathIndex];
      const toWaypoint = waypoint.subtract(agentPos);
      toWaypoint.y = 0;

      if (toWaypoint.length() < waypointThreshold) {
        this.pathIndex++;
        this.navTargetBlendFactor = 0;
      }

      if (this.pathIndex < this.currentPath.length) {
        this.navTargetBlendFactor = Math.min(
          1.0,
          this.navTargetBlendFactor + blendSpeed * dt,
        );

        const currentWaypoint = this.currentPath[this.pathIndex];
        if (this.pathIndex + 1 < this.currentPath.length) {
          this.smoothedNavTarget = BABYLON.Vector3.Lerp(
            currentWaypoint,
            this.currentPath[this.pathIndex + 1],
            this.navTargetBlendFactor,
          );
        } else {
          this.smoothedNavTarget = currentWaypoint.clone();
        }

        return this.smoothedNavTarget;
      }
    }

    return realTarget;
  }

  /**
   * Heuristic: Euclidean distance between two grid cells
   */
  heuristic(a, b) {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /**
   * Find nearest walkable cell to a blocked position
   * @private
   */
  findNearestWalkableCell(blockedCell, maxRadius = 5) {
    let bestCell = null;
    let bestDist = Infinity;

    for (let radius = 1; radius <= maxRadius; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          // Only check edge cells of current radius ring
          if (Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue;

          const x = blockedCell.x + dx;
          const z = blockedCell.z + dz;

          if (this.navGrid.isWalkable(x, z)) {
            const dist = Math.hypot(dx, dz);
            if (dist < bestDist) {
              bestDist = dist;
              bestCell = { x, z };
            }
          }
        }
      }

      if (bestCell) break; // Use first radius that finds a cell
    }

    return bestCell;
  }

  /**
   * A* pathfinding algorithm
   * @param {BABYLON.Vector3} start - World position start
   * @param {BABYLON.Vector3} goal - World position goal
   * @returns {BABYLON.Vector3[]} Array of waypoints from start to goal
   */
  findPath(start, goal) {
    const startGrid = this.navGrid.worldToGrid(start);
    const goalGrid = this.navGrid.worldToGrid(goal);

    let startCell = {
      x: Math.round(startGrid.x),
      z: Math.round(startGrid.z),
    };

    let goalCell = {
      x: Math.round(goalGrid.x),
      z: Math.round(goalGrid.z),
    };

    // Resolve blocked start position
    if (!this.navGrid.isWalkable(startCell.x, startCell.z)) {
      const nearestStart = this.findNearestWalkableCell(startCell, 5);
      if (!nearestStart) return [goal]; // No valid start found
      startCell = nearestStart;
    }

    // Resolve blocked goal position
    if (!this.navGrid.isWalkable(goalCell.x, goalCell.z)) {
      const nearestGoal = this.findNearestWalkableCell(goalCell, 8);
      if (!nearestGoal) return [goal]; // No valid goal found
      goalCell = nearestGoal;
    }

    // Initialize A* data structures
    const openSet = [startCell];
    const cameFrom = new Map();
    const gScore = new Map();
    const fScore = new Map();

    const key = (c) => `${c.x},${c.z}`;
    gScore.set(key(startCell), 0);
    fScore.set(key(startCell), this.heuristic(startCell, goalCell));

    // 8-directional movement (4 cardinal + 4 diagonal)
    const directions = [
      { x: 1, z: 0 },
      { x: -1, z: 0 },
      { x: 0, z: 1 },
      { x: 0, z: -1 },
      { x: 1, z: 1 },
      { x: -1, z: 1 },
      { x: 1, z: -1 },
      { x: -1, z: -1 },
    ];

    let iterations = 0;
    const MAX_ITERATIONS = 500;

    while (openSet.length > 0 && iterations++ < MAX_ITERATIONS) {
      // Find cell with lowest fScore
      let current = openSet[0];
      let currentIdx = 0;
      let currentF = fScore.get(key(current));

      for (let i = 1; i < openSet.length; i++) {
        const f = fScore.get(key(openSet[i]));
        if (f < currentF) {
          current = openSet[i];
          currentIdx = i;
          currentF = f;
        }
      }

      // Goal reached: reconstruct path
      if (current.x === goalCell.x && current.z === goalCell.z) {
        const path = [];
        let c = current;

        while (cameFrom.has(key(c))) {
          path.unshift(this.navGrid.gridToWorld(c.x, c.z));
          c = cameFrom.get(key(c));
        }

        path.unshift(start);
        path.push(goal);
        return path;
      }

      openSet.splice(currentIdx, 1);

      // Explore neighbors
      for (const dir of directions) {
        const neighbor = { x: current.x + dir.x, z: current.z + dir.z };

        if (!this.navGrid.isWalkable(neighbor.x, neighbor.z)) continue;

        const tentativeG = gScore.get(key(current)) + Math.hypot(dir.x, dir.z);
        const neighborG = gScore.get(key(neighbor)) ?? Infinity;

        if (tentativeG < neighborG) {
          // Found better path to neighbor
          cameFrom.set(key(neighbor), current);
          gScore.set(key(neighbor), tentativeG);
          fScore.set(
            key(neighbor),
            tentativeG + this.heuristic(neighbor, goalCell),
          );

          if (!openSet.find((c) => c.x === neighbor.x && c.z === neighbor.z)) {
            openSet.push(neighbor);
          }
        }
      }
    }

    // No path found, return direct path as fallback
    return [goal];
  }

  /**
   * Visualize a path in the scene for debugging
   * @param {BABYLON.Scene} scene - Babylon.js scene
   * @param {BABYLON.Vector3[]} path - Array of waypoints to visualize
   * @param {number} currentIndex - Current waypoint index
   * @returns {BABYLON.Mesh[]} Array of visual meshes created
   */
  visualizePath(scene, path, currentIndex) {
    const visuals = [];

    if (!path || path.length === 0) return visuals;

    // Draw waypoints
    for (let i = 0; i < path.length; i++) {
      const waypoint = path[i];
      const size = i === currentIndex ? 0.3 : 0.2;
      const color =
        i === currentIndex
          ? new BABYLON.Color3(0, 1, 0)
          : new BABYLON.Color3(0, 0, 1);

      const sphere = BABYLON.MeshBuilder.CreateSphere(
        "waypoint",
        { diameter: size },
        scene,
      );
      sphere.position.copyFrom(waypoint);
      const mat = new BABYLON.StandardMaterial("wp_mat_" + i, scene);
      mat.diffuse = color;
      sphere.material = mat;
      visuals.push(sphere);

      // Draw line to next waypoint
      if (i < path.length - 1) {
        const lines = BABYLON.MeshBuilder.CreateTube(
          "path_line_" + i,
          {
            path: [waypoint, path[i + 1]],
            radius: 0.05,
          },
          scene,
        );
        const lineMat = new BABYLON.StandardMaterial("line_mat_" + i, scene);
        lineMat.diffuse = new BABYLON.Color3(0.2, 0.2, 1);
        lines.material = lineMat;
        visuals.push(lines);
      }
    }

    return visuals;
  }
}
