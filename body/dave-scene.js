// ── D.A.V.E. Babylon.js Scene ─────────────────────────────────────────────────
// Loads davebot.glb, wires up expressions, lip sync, gaze tracking, and chat.

import cfg from "./src/config.js";
import { DaveMindClient } from "./src/dave-mind-client.js";
import { handleError, clamp, normalizeAngle } from "./src/utils.js";
import { Dave, S } from "./src/dave-character.js";
import Activity from "./src/dave-activity.js";
import { CamCharacter, Screen, Lamp } from "./src/dave-enclosure.js";

// ── Application Constants ───────────────────────────────────────────────────

const API_BASE_URL = cfg.API.getBaseUrl();

// Cryptographically random session id. The previous Date.now()-based id
// was guessable in seconds; anyone could read or poison another visitor's
// chat history. crypto.randomUUID is supported in every browser Vite
// targets; the fallback is paranoia for older Safari.
const SESSION_ID =
  cfg.USER.SESSION_ID_PREFIX +
  (typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2));

// Persistent user identity — survives page reloads / new sessions
const STORED_USER_ID = localStorage.getItem(cfg.USER.STORAGE_KEY);
const USER_ID =
  STORED_USER_ID ||
  cfg.USER.USER_ID_PREFIX +
    Math.random()
      .toString(36)
      .slice(2, 2 + cfg.USER.USER_ID_LENGTH);
if (!STORED_USER_ID) localStorage.setItem(cfg.USER.STORAGE_KEY, USER_ID);

// Initialize backend client
const mindClient = new DaveMindClient(API_BASE_URL, SESSION_ID, USER_ID);

// Model & Movement
const MODEL_PATH = cfg.ASSETS.DAVE_MODEL;
const MODEL_FORWARD_OFFSET = cfg.MODEL.FORWARD_OFFSET;
const TURN_SPEED = cfg.MOVEMENT.TURN_SPEED;

// Camera Configuration
const PIP_CAMERA_NEAR_PLANE = cfg.PIP_CAMERA.NEAR_PLANE;
const PIP_CAMERA_FOV = cfg.PIP_CAMERA.FOV;

// Mute State
let isMuted = localStorage.getItem(cfg.USER.MUTED_STORAGE_KEY) === "true";

// ── Engine + Scene ───────────────────────────────────────────────────────

const canvas = document.getElementById("renderCanvas");
// index.html draws its own loading screens; keep Babylon's logo screen off.
BABYLON.SceneLoader.ShowLoadingScreen = false;
const engine = new BABYLON.Engine(canvas, true, {
  preserveDrawingBuffer: true,
});
const scene = new BABYLON.Scene(engine);
scene.clearColor = new BABYLON.Color4(
  cfg.SCENE.CLEAR_COLOR.r,
  cfg.SCENE.CLEAR_COLOR.g,
  cfg.SCENE.CLEAR_COLOR.b,
  cfg.SCENE.CLEAR_COLOR.a,
);

// ── Havok Physics ────────────────────────────────────────────────────────
// PhysicsViewer will be created after scene.enablePhysics
let physicsViewer = null;
let physicsViewerEnabled = false;

// ── Physics Debug Viewer ─────────────────────────────────────────────────
// Press 'P' to toggle all physics bodies on/off
function togglePhysicsViewer() {
  if (physicsViewerEnabled) {
    // Disable - restore both cameras
    if (physicsViewer) {
      physicsViewer.dispose();
      physicsViewer = null;
    }
    scene.activeCameras = [camera, eyeCam]; // Restore PIP camera
    physicsViewerEnabled = false;
  } else {
    // Enable - show only main orbit camera, hide PIP
    scene.activeCameras = [camera];

    if (!physicsViewer) {
      physicsViewer = new BABYLON.PhysicsViewer(scene);
    }

    // Show all physics bodies by iterating through all meshes
    const meshes = scene.meshes;
    let bodyCount = 0;
    meshes.forEach((mesh) => {
      // Check if mesh has a physics body (via aggregate)
      if (mesh.physicsBody) {
        try {
          physicsViewer.showBody(mesh.physicsBody);
          bodyCount++;
        } catch (e) {
          // Body may not be renderable
        }
      }
    });

    physicsViewerEnabled = true;
  }
}

// Keyboard shortcut: Press 'P' to toggle physics viewer
window.addEventListener("keydown", (event) => {
  if (
    event.key.toLowerCase() === "p" &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    // Make sure we're not typing in an input field
    if (document.activeElement.tagName !== "INPUT") {
      togglePhysicsViewer();
    }
  }
});

// Keyboard shortcut: Press 'G' to toggle grid visualization
window.addEventListener("keydown", (event) => {
  if (
    event.key.toLowerCase() === "g" &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    // Make sure we're not typing in an input field
    if (document.activeElement.tagName !== "INPUT") {
      // dave will be created later in the function, so we'll store reference
      window.toggleGridViz = () => {
        if (window._dave && window._dave.navGrid) {
          window._dave.navGrid.createVisualization(scene);
        }
      };
      window.toggleGridViz();
    }
  }
});

// Keyboard shortcut: Press 'V' to toggle path visualization for current navigation
window.addEventListener("keydown", (event) => {
  if (
    event.key.toLowerCase() === "v" &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    // Make sure we're not typing in an input field
    if (document.activeElement.tagName !== "INPUT") {
      window.togglePathViz = () => {
        if (window._dave) {
          window._dave.debugDrawPath(scene);
        }
      };
      window.togglePathViz();
    }
  }
});

const havokInstance = await HavokPhysics();
const hk = new BABYLON.HavokPlugin(true, havokInstance);
scene.enablePhysics(new BABYLON.Vector3(0, cfg.MODEL.GRAVITY_Y, 0), hk);

// ── Camera ───────────────────────────────────────────────────────────────

const cameraTarget = new BABYLON.Vector3(0, cfg.CAMERA.TARGET_Y, 0);
const camera = new BABYLON.ArcRotateCamera(
  "cam",
  cfg.CAMERA.INITIAL_ALPHA,
  cfg.CAMERA.INITIAL_BETA,
  cfg.CAMERA.INITIAL_RADIUS,
  cameraTarget,
  scene,
);
camera.lowerRadiusLimit = cfg.CAMERA.MIN_RADIUS;
camera.upperRadiusLimit = cfg.CAMERA.MAX_RADIUS;
camera.lowerBetaLimit = cfg.CAMERA.MIN_BETA;
camera.attachControl(canvas, true);

// ── Environment ──────────────────────────────────────────────────────────

const ground = BABYLON.MeshBuilder.CreateGround(
  "ground",
  {
    width: cfg.ENVIRONMENT.GROUND_WIDTH,
    height: cfg.ENVIRONMENT.GROUND_HEIGHT,
    subdivisions: cfg.ENVIRONMENT.GROUND_SUBDIVISIONS,
  },
  scene,
);
const groundMat = new BABYLON.StandardMaterial("groundMat", scene);

// Procedural dark green shag carpet
const carpetTex = new BABYLON.DynamicTexture(
  "carpetTex",
  cfg.ENVIRONMENT.CARPET_TEXTURE_SIZE,
  scene,
  false,
);
const ctx2d = carpetTex.getContext();

// Seeded RNG
let _cs = 42;
const rng = () => {
  _cs = (_cs * 1103515245 + 12345) & 0x7fffffff;
  return _cs / 0x7fffffff;
};

// Per-pixel noisy green base
const texSize = cfg.ENVIRONMENT.CARPET_TEXTURE_SIZE;
const img = ctx2d.createImageData(texSize, texSize);
for (let i = 0; i < texSize * texSize; i++) {
  const p = i * 4;
  img.data[p] =
    cfg.ENVIRONMENT.CARPET_COLOR_R_MIN +
    Math.floor(rng() * cfg.ENVIRONMENT.CARPET_COLOR_R_RANGE); // R
  img.data[p + 1] =
    cfg.ENVIRONMENT.CARPET_COLOR_G_MIN +
    Math.floor(rng() * cfg.ENVIRONMENT.CARPET_COLOR_G_RANGE); // G
  img.data[p + 2] =
    cfg.ENVIRONMENT.CARPET_COLOR_B_MIN +
    Math.floor(rng() * cfg.ENVIRONMENT.CARPET_COLOR_B_RANGE); // B
  img.data[p + 3] = 255;
}
ctx2d.putImageData(img, 0, 0);

// Fine fiber strands on top
for (let i = 0; i < cfg.ENVIRONMENT.CARPET_STRAND_COUNT; i++) {
  const x = rng() * texSize;
  const y = rng() * texSize;
  const len =
    cfg.ENVIRONMENT.CARPET_STRAND_LENGTH_MIN +
    rng() * cfg.ENVIRONMENT.CARPET_STRAND_LENGTH_RANGE;
  const a = rng() * Math.PI * 2;
  const g = 40 + Math.floor(rng() * 80); // keep green component varied
  ctx2d.strokeStyle = `rgba(${8 + Math.floor(rng() * 20)},${g},${5 + Math.floor(rng() * 12)},${cfg.ENVIRONMENT.CARPET_STRAND_ALPHA})`;
  ctx2d.lineWidth =
    cfg.ENVIRONMENT.CARPET_STRAND_WIDTH_MIN +
    rng() * cfg.ENVIRONMENT.CARPET_STRAND_WIDTH_RANGE;
  ctx2d.lineCap = "round";
  ctx2d.beginPath();
  ctx2d.moveTo(x, y);
  ctx2d.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
  ctx2d.stroke();
}

carpetTex.update();

// Generate a normal map from a matching heightmap
const normalTex = new BABYLON.DynamicTexture("carpetNorm", 512, scene, false);
const nCtx = normalTex.getContext();
// Build heightmap array
const hMap = new Float32Array(512 * 512);
let _hs = 42; // same seed
const hrng = () => {
  _hs = (_hs * 1103515245 + 12345) & 0x7fffffff;
  return _hs / 0x7fffffff;
};

// Base noise height
for (let i = 0; i < 512 * 512; i++) {
  hMap[i] = hrng() * 0.3;
  hrng();
  hrng(); // skip G,B to stay in sync with diffuse RNG
}
// Fiber bumps
for (let i = 0; i < 20000; i++) {
  const x = Math.floor(hrng() * 512);
  const y = Math.floor(hrng() * 512);
  const len = 0.8 + hrng() * 2;
  const a = hrng() * Math.PI * 2;
  hrng();
  hrng();
  hrng();
  hrng(); // skip color rngs
  const steps = Math.ceil(len);
  for (let s = 0; s <= steps; s++) {
    const px = Math.floor(x + Math.cos(a) * len * (s / steps));
    const py = Math.floor(y + Math.sin(a) * len * (s / steps));
    if (px >= 0 && px < 512 && py >= 0 && py < 512) {
      hMap[py * 512 + px] = Math.min(1, hMap[py * 512 + px] + 0.4);
    }
  }
}

// Convert heightmap → tangent-space normal map using Sobel
const nImg = nCtx.createImageData(512, 512);
const strength = 2.0;
for (let y = 0; y < 512; y++) {
  for (let x = 0; x < 512; x++) {
    const xp = (x + 1) % 512,
      xn = (x - 1 + 512) % 512;
    const yp = (y + 1) % 512,
      yn = (y - 1 + 512) % 512;
    const dX = (hMap[y * 512 + xp] - hMap[y * 512 + xn]) * strength;
    const dY = (hMap[yp * 512 + x] - hMap[yn * 512 + x]) * strength;
    // Normal = normalize(-dX, -dY, 1)
    const invLen = 1 / Math.sqrt(dX * dX + dY * dY + 1);
    const p = (y * 512 + x) * 4;
    nImg.data[p] = Math.floor((-dX * invLen * 0.5 + 0.5) * 255);
    nImg.data[p + 1] = Math.floor((-dY * invLen * 0.5 + 0.5) * 255);
    nImg.data[p + 2] = Math.floor((invLen * 0.5 + 0.5) * 255);
    nImg.data[p + 3] = 255;
  }
}
nCtx.putImageData(nImg, 0, 0);
normalTex.update();

groundMat.diffuseTexture = carpetTex;
groundMat.diffuseTexture.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
groundMat.diffuseTexture.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
groundMat.diffuseTexture.uScale = 10;
groundMat.diffuseTexture.vScale = 10;
groundMat.bumpTexture = normalTex;
groundMat.bumpTexture.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
groundMat.bumpTexture.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
groundMat.bumpTexture.uScale = 10;
groundMat.bumpTexture.vScale = 10;
groundMat.bumpTexture.level = 1.5;
groundMat.specularColor = new BABYLON.Color3(0.03, 0.05, 0.03);
groundMat.specularPower = 4;
ground.material = groundMat;

// Ground physics body (static)
new BABYLON.PhysicsAggregate(
  ground,
  BABYLON.PhysicsShapeType.BOX,
  { mass: 0, friction: 0.5 },
  scene,
);

// ── Invisible barrier walls ──────────────────────────────────────────────
const GROUND_SIZE = 40;
const WALL_HEIGHT = 6;
const WALL_THICKNESS = 1;
const wallPositions = [
  { x: 0, z: GROUND_SIZE / 2, sx: GROUND_SIZE, sz: WALL_THICKNESS }, // +Z
  { x: 0, z: -GROUND_SIZE / 2, sx: GROUND_SIZE, sz: WALL_THICKNESS }, // -Z
  { x: GROUND_SIZE / 2, z: 0, sx: WALL_THICKNESS, sz: GROUND_SIZE }, // +X
  { x: -GROUND_SIZE / 2, z: 0, sx: WALL_THICKNESS, sz: GROUND_SIZE }, // -X
];
wallPositions.forEach((w, i) => {
  const wall = BABYLON.MeshBuilder.CreateBox(
    `barrier_${i}`,
    { width: w.sx, height: WALL_HEIGHT, depth: w.sz },
    scene,
  );
  wall.position.set(w.x, WALL_HEIGHT / 2, w.z);
  wall.isVisible = false;
  new BABYLON.PhysicsAggregate(
    wall,
    BABYLON.PhysicsShapeType.BOX,
    { mass: 0, friction: 0 },
    scene,
  );
});

const hemi = new BABYLON.HemisphericLight(
  "hemi",
  new BABYLON.Vector3(0, 1, 0),
  scene,
);
hemi.intensity = 0.5;
hemi.groundColor = new BABYLON.Color3(0.05, 0.05, 0.05);

// ── Load Model ───────────────────────────────────────────────────────────

const imported = await BABYLON.SceneLoader.ImportMeshAsync(
  "",
  "",
  MODEL_PATH,
  scene,
);
const root = imported.meshes[0];
root.rotationQuaternion = null; // enable Euler rotation

// ── Load Enclosure ───────────────────────────────────────────────────────

const ENCLOSURE_PATH = "/assets/davebot_enclosure.glb";
const enclosureImported = await BABYLON.SceneLoader.ImportMeshAsync(
  "",
  "",
  ENCLOSURE_PATH,
  scene,
);

// Add static physics bodies to all enclosure meshes
const enclosurePhysicsMap = new Map(); // mesh name → PhysicsAggregate
for (const mesh of enclosureImported.meshes) {
  if (!mesh.getTotalVertices || mesh.getTotalVertices() === 0) continue;
  const agg = new BABYLON.PhysicsAggregate(
    mesh,
    BABYLON.PhysicsShapeType.MESH,
    { mass: 0, friction: 0.5, restitution: 0.2 },
    scene,
  );
  enclosurePhysicsMap.set(mesh.name, agg);
}

// ── Load Beer Glass ───────────────────────────────────────────────────────

const BEER_PATH = "/assets/davebeer.glb";
const beerImported = await BABYLON.SceneLoader.ImportMeshAsync(
  "",
  "",
  BEER_PATH,
  scene,
);
const beerMeshRoot = beerImported.meshes[0];
beerMeshRoot.rotationQuaternion = null;
beerImported.animationGroups.forEach((ag) => ag.stop());

// Remove the enclosure's beer placeholder mesh and replace with davebeer.glb
const beerPlaceholders = enclosureImported.meshes.filter((m) =>
  m.name.toLowerCase().includes("beer"),
);
let beerRestPos = new BABYLON.Vector3(0, 0, 0);
for (const beerPlaceholder of beerPlaceholders) {
  beerPlaceholder.computeWorldMatrix(true);
  if (beerPlaceholders.indexOf(beerPlaceholder) === 0) {
    // Use the bounding box bottom so the beer base sits ON the surface,
    // not floating at the placeholder's center (davebeer origin is at its base).
    const absPos = beerPlaceholder.getAbsolutePosition();
    beerRestPos = new BABYLON.Vector3(absPos.x, absPos.y, absPos.z);
  }
  const phAgg = enclosurePhysicsMap.get(beerPlaceholder.name);
  if (phAgg) {
    phAgg.dispose();
    enclosurePhysicsMap.delete(beerPlaceholder.name);
  }
  beerPlaceholder.dispose();
}
beerMeshRoot.position.copyFrom(beerRestPos);

// Beer physics — ANIMATED so particles collide with the glass
const beerGlassMesh = beerImported.meshes.find(
  (m) => m !== beerMeshRoot && m.getTotalVertices && m.getTotalVertices() > 0,
);

// ── Critical: reparent beerGlassMesh out of __root__ immediately. ─────────────
// The glTF loader bakes an axis-correction rotation into __root__ (meshes[0]).
// Any parenting that goes through __root__ will compound that correction with
// the hand bone's rotation and flip/corrupt the glass orientation.
// Solution: pull beerGlassMesh out into world space and never touch __root__ again.
if (beerGlassMesh) {
  beerMeshRoot.computeWorldMatrix(true);
  beerGlassMesh.computeWorldMatrix(true);
  const glassWorldPos = beerGlassMesh.getAbsolutePosition().clone();
  beerGlassMesh.parent = null;
  beerGlassMesh.rotationQuaternion = null;
  beerGlassMesh.rotation = BABYLON.Vector3.Zero();
  beerGlassMesh.position.copyFrom(glassWorldPos);
  // Update rest pos to the glass's actual world position after axis correction
  beerRestPos = glassWorldPos.clone();
  // __root__ is now empty; disable it so it doesn't interfere
  beerMeshRoot.setEnabled(false);
}

// ── Load Camera Character (cam.glb) ─────────────────────────────────────
const CAM_CHAR_PATH = "/assets/cam.glb";
const camCharImported = await BABYLON.SceneLoader.ImportMeshAsync(
  "",
  "",
  CAM_CHAR_PATH,
  scene,
);
const camCharacter = new CamCharacter(
  scene,
  cfg,
  camCharImported.meshes[0],
  camCharImported.meshes,
);

// ── Point Lights from furniture ────────────────────────────────────────
function getMeshCenter(keyword) {
  const m = enclosureImported.meshes.find((mesh) =>
    mesh.name.toLowerCase().includes(keyword),
  );
  if (!m) return null;
  m.computeWorldMatrix(true);
  const bounds = m.getBoundingInfo().boundingBox;
  return bounds.centerWorld.clone();
}

// Warm lamp lights
const lampKeywords = ["lamp.couch", "lamp.bed", "floorlamp"];
lampKeywords.forEach((kw, i) => {
  const lampMesh = enclosureImported.meshes.find((m) =>
    m.name.toLowerCase().includes(kw.toLowerCase()),
  );
  if (!lampMesh) return;
  const pos = getMeshCenter(kw);
  if (!pos) return;
  pos.y += cfg.ENVIRONMENT.LAMP_HEIGHT_OFFSET;
  new Lamp(scene, cfg, lampMesh, pos, `lamp_${i}`);
});

// Overhead ambient light
const dirLight = new BABYLON.DirectionalLight(
  "dir",
  new BABYLON.Vector3(
    cfg.ENVIRONMENT.DIRLIGHT_DIRECTION.x,
    cfg.ENVIRONMENT.DIRLIGHT_DIRECTION.y,
    cfg.ENVIRONMENT.DIRLIGHT_DIRECTION.z,
  ),
  scene,
);
dirLight.intensity = cfg.ENVIRONMENT.DIRLIGHT_INTENSITY;

// ── Interactable Objects ─────────────────────────────────────────────────
// Generic system: register any mesh with an approach position, facing angle,
// and arrive/depart callbacks.  Click/tap a registered mesh to send Dave there.
//
// descriptor = {
//   mesh, label,
//   approachPos: Vector3,   – where Dave walks to
//   facingAngle: number,    – rotation Dave should have when arriving
//   onArrive: () => void,   – called once Dave is in position
//   onDepart: () => void,   – called when Dave leaves / is interrupted
// }

const interactables = new Map(); // mesh → descriptor

function registerInteractable(descriptor) {
  if (!descriptor?.mesh) return;
  interactables.set(descriptor.mesh, descriptor);
  descriptor.mesh.isPickable = true;
  // Also register all descendant meshes so clicking any sub-part works
  descriptor.mesh.getChildMeshes(false).forEach((child) => {
    interactables.set(child, descriptor);
    child.isPickable = true;
  });
}

// ── Helper: compute sit descriptor from a furniture mesh ──────────────

function findEnclosureMesh(keyword) {
  // Prefer exact match → starts-with → includes
  const lc = keyword.toLowerCase();
  return (
    enclosureImported.meshes.find((m) => m.name.toLowerCase() === lc) ||
    enclosureImported.meshes.find((m) => m.name.toLowerCase().startsWith(lc)) ||
    enclosureImported.meshes.find((m) => m.name.toLowerCase().includes(lc))
  );
}

// Collect all enclosure meshes whose name contains a keyword (for collision toggling)
function getEnclosureMeshesByKeyword(keyword) {
  const lc = keyword.toLowerCase();
  return enclosureImported.meshes.filter((m) =>
    m.name.toLowerCase().includes(lc),
  );
}

// Default durations chosen to feel like Dave is "actually doing" the activity
// without parking him forever. Capped further on the Dave side via the
// Activity's maxDuration — see dave-character.js _capDuration.
const ACTIVITY_DEFAULTS = {
  chair:    { defaultDuration: 75,  maxDuration: 180, anim: "sit" },
  computer: { defaultDuration: 75,  maxDuration: 180, anim: "sit" },
  couch:    { defaultDuration: 90,  maxDuration: 180, anim: "sit" },
  bed:      { defaultDuration: 120, maxDuration: 240, anim: "laydown" },
  keg:      { defaultDuration: 45,  maxDuration: 90,  anim: "idle" },
};

function buildSitDescriptor(mesh, label) {
  if (!mesh) return null;
  mesh.computeWorldMatrix(true);
  const bounds = mesh.getBoundingInfo().boundingBox;
  const center = bounds.centerWorld.clone();

  const worldMatrix = mesh.getWorldMatrix();
  // Use local +Z as the furniture's "front" (seat-facing direction)
  const localForward = new BABYLON.Vector3(0, 0, 1);
  const furnitureForward = BABYLON.Vector3.TransformNormal(
    localForward,
    worldMatrix,
  ).normalize();

  // Approach distance varies by furniture type
  let approachDist = 1.0; // default for couch
  if (label === "couch") {
    approachDist = 1.3; // further back for couch (quarter body length extra)
  }

  // Approach position: straight forward from center using full forward vector
  const approachPos = new BABYLON.Vector3(
    center.x + furnitureForward.x * approachDist,
    0,
    center.z + furnitureForward.z * approachDist,
  );

  // Depart position: further out than approach so Dave clears the furniture
  const departPos = new BABYLON.Vector3(
    center.x + furnitureForward.x * 1.5,
    0,
    center.z + furnitureForward.z * 1.5,
  );

  // Facing angle: Dave faces the same direction as the furniture front
  const facingAngle =
    Math.atan2(furnitureForward.x, furnitureForward.z) + MODEL_FORWARD_OFFSET;

  const defaults = ACTIVITY_DEFAULTS[label] || {
    defaultDuration: 60,
    maxDuration: 180,
    anim: "sit",
  };

  return new Activity({
    label,
    mesh,
    approachPos,
    departPos,
    facingAngle,
    anim: defaults.anim,
    blocksHead: true,
    reversible: defaults.anim !== "idle",
    defaultDuration: defaults.defaultDuration,
    maxDuration: defaults.maxDuration,
  });
}

// Register chair (+ computer desk browsing) & couch
const chairMesh = findEnclosureMesh("chair");
const couchMesh = findEnclosureMesh("couch");

const chairDescriptor = buildSitDescriptor(chairMesh, "chair");
const couchDescriptor = buildSitDescriptor(couchMesh, "couch");

// Chair / computer / desk are clickable aliases for the same Activity.
// onEnter/onExit are wired below after Dave is constructed (they need
// closures over mindClient, drawScreenText, addMessageToHistory, etc.).
if (chairDescriptor) {
  registerInteractable(chairDescriptor);
  const computerMesh = findEnclosureMesh("computer");
  const deskMesh = findEnclosureMesh("desk");
  [computerMesh, deskMesh].forEach((m) => {
    if (m) {
      interactables.set(m, chairDescriptor);
      m.getChildMeshes().forEach((child) =>
        interactables.set(child, chairDescriptor),
      );
    }
  });
}
if (couchDescriptor) registerInteractable(couchDescriptor);

// Register bed as interactable (laydown animation)
const bedMesh = findEnclosureMesh("bed");
const bedDescriptor = buildSitDescriptor(bedMesh, "bed");
if (bedDescriptor) {
  // Recompute bed-specific positions:
  // Dave lays down offset to the left (local -X) and faces away from the bed front.
  bedMesh.computeWorldMatrix(true);
  const bedBounds = bedMesh.getBoundingInfo().boundingBox;
  const bedCenter = bedBounds.centerWorld.clone();
  const bedWorld = bedMesh.getWorldMatrix();
  const bedFwd = BABYLON.Vector3.TransformNormal(
    new BABYLON.Vector3(0, 0, 1),
    bedWorld,
  ).normalize();
  // Left = cross(up, forward) — local -X when viewed from above
  const bedLeft = BABYLON.Vector3.Cross(
    BABYLON.Vector3.Up(),
    bedFwd,
  ).normalize();

  // Sit (lay) position: centered on bed, offset along the left side
  // Note: sitPos not used anymore - Dave sits where he naturally stands
  // const layOffset = 1.4; // offset to the left side of the bed

  // Facing perpendicular to bed length (halfway between headboard and foot)
  bedDescriptor.facingAngle =
    Math.atan2(bedLeft.x, bedLeft.z) + MODEL_FORWARD_OFFSET;
  // Approach from the LEFT side (same side Dave lays on) but further out
  // (2.0 instead of 1.5 = quarter body length farther)
  bedDescriptor.approachPos = new BABYLON.Vector3(
    bedCenter.x + bedLeft.x * 2.0,
    0,
    bedCenter.z + bedLeft.z * 2.0,
  );
  // Depart even further out on the same side
  bedDescriptor.departPos = new BABYLON.Vector3(
    bedCenter.x + bedLeft.x * 2.0,
    0,
    bedCenter.z + bedLeft.z * 2.0,
  );

  // onEnter wired below after Dave is constructed.
  registerInteractable(bedDescriptor);
  // Register ALL bed-related meshes so clicking any part works
  getEnclosureMeshesByKeyword("bed").forEach((m) => {
    if (!interactables.has(m)) {
      interactables.set(m, bedDescriptor);
      m.isPickable = true;
    }
  });
}

// ── Register Kegerator / Keg as interactable ───────────────────────────

const kegMesh = findEnclosureMesh("keg") || findEnclosureMesh("kegerator");
let kegDescriptor = null;
if (kegMesh) {
  kegMesh.computeWorldMatrix(true);
  const kegBounds = kegMesh.getBoundingInfo().boundingBox;
  const kegCenter = kegBounds.centerWorld.clone();
  const kegWorld = kegMesh.getWorldMatrix();
  const kegFwd = BABYLON.Vector3.TransformNormal(
    new BABYLON.Vector3(0, 0, 1),
    kegWorld,
  ).normalize();

  const kegApproach = new BABYLON.Vector3(
    kegCenter.x + kegFwd.x * 1.8,
    0,
    kegCenter.z + kegFwd.z * 1.8,
  );
  const kegFacingAngle =
    Math.atan2(-kegFwd.x, -kegFwd.z) + MODEL_FORWARD_OFFSET;

  kegDescriptor = new Activity({
    label: "keg",
    mesh: kegMesh,
    approachPos: kegApproach,
    departPos: new BABYLON.Vector3(
      kegCenter.x + kegFwd.x * 2.8,
      0,
      kegCenter.z + kegFwd.z * 2.8,
    ),
    facingAngle: kegFacingAngle,
    anim: "idle", // beer sequence overrides currentAction to "chug" mid-sequence
    blocksHead: true,
    reversible: false,
    defaultDuration: ACTIVITY_DEFAULTS.keg.defaultDuration,
    maxDuration: ACTIVITY_DEFAULTS.keg.maxDuration,
  });

  registerInteractable(kegDescriptor);

  // Also register all kegerator / keg sub-meshes as clickable aliases
  getEnclosureMeshesByKeyword("kegerator").forEach((m) => {
    if (!interactables.has(m)) {
      interactables.set(m, kegDescriptor);
      m.isPickable = true;
    }
  });
  getEnclosureMeshesByKeyword("keg").forEach((m) => {
    if (!interactables.has(m)) {
      interactables.set(m, kegDescriptor);
      m.isPickable = true;
    }
  });
}

// ── Named furniture lookup (for LLM moveTo field) ──────────────────────
const furnitureByName = {};
if (chairDescriptor) furnitureByName["chair"] = chairDescriptor;
if (chairDescriptor) furnitureByName["computer"] = chairDescriptor;
if (couchDescriptor) furnitureByName["couch"] = couchDescriptor;
if (bedDescriptor) furnitureByName["bed"] = bedDescriptor;
if (kegDescriptor) furnitureByName["keg"] = kegDescriptor;
if (kegDescriptor) furnitureByName["kegerator"] = kegDescriptor;
if (kegDescriptor) furnitureByName["beer"] = kegDescriptor;

// ── TV Video Texture ──────────────────────────────────────────────────
const tvMesh = findEnclosureMesh("tv");
const tvOriginalMaterial = tvMesh?.material ?? null;
const TV_TEX_SIZE = 1024;
let tvVideoElement = null; // HTMLVideoElement for cleanup
let tvVideoObserver = null; // render-loop observer for canvas updates
let tvVideoTexture = null; // DynamicTexture driven by video frames
let tvImageTexture = null; // DynamicTexture for user-uploaded images
let tvUserMediaActive = false;

// Override the TV mesh's UVs so the texture maps 1:1 onto the screen face.
// Blender exports them rotated and offset, which meant our canvas content
// (centered, fit-to-screen) appeared zoomed and cropped on the TV — see the
// "steelworkers" diagnostic. Computing UVs from vertex positions on the
// mesh's largest planar face guarantees a clean (0,0)→(1,1) mapping.
function _normalizeTvMeshUVs(mesh) {
  if (!mesh) return;
  const positions = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
  if (!positions || positions.length < 12) return;

  // Bounds in local mesh space — used to pick the two largest axes (the
  // "face" of the TV) and to scale UVs from 0 to 1 across that face.
  let xMin = Infinity, xMax = -Infinity;
  let yMin = Infinity, yMax = -Infinity;
  let zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < xMin) xMin = x; if (x > xMax) xMax = x;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    if (z < zMin) zMin = z; if (z > zMax) zMax = z;
  }
  const dx = xMax - xMin || 1;
  const dy = yMax - yMin || 1;
  const dz = zMax - zMin || 1;

  // The flat face axis is whichever has the smallest extent.
  const smallest = Math.min(dx, dy, dz);
  let uAxis, vAxis, uMin, vMin, uRange, vRange;
  if (smallest === dz) {
    uAxis = 0; vAxis = 1; uMin = xMin; vMin = yMin; uRange = dx; vRange = dy;
  } else if (smallest === dx) {
    uAxis = 2; vAxis = 1; uMin = zMin; vMin = yMin; uRange = dz; vRange = dy;
  } else {
    uAxis = 0; vAxis = 2; uMin = xMin; vMin = zMin; uRange = dx; vRange = dz;
  }

  const vertexCount = positions.length / 3;
  const uvs = new Float32Array(vertexCount * 2);
  for (let i = 0; i < vertexCount; i++) {
    const p = i * 3;
    uvs[i * 2] = (positions[p + uAxis] - uMin) / uRange;
    uvs[i * 2 + 1] = (positions[p + vAxis] - vMin) / vRange;
  }
  mesh.setVerticesData(BABYLON.VertexBuffer.UVKind, uvs);
}
_normalizeTvMeshUVs(tvMesh);

function _setTvMaterial(tex) {
  // Since _normalizeTvMeshUVs reset the mesh's UVs to a clean (0,0)→(1,1)
  // mapping, the texture transform stays at identity — no rotation, no
  // scale, no offset.
  tex.uOffset = 0;
  tex.vOffset = 0;
  tex.uScale = 1;
  tex.vScale = 1;
  tex.uAng = 0;
  tex.vAng = 0;
  tex.wAng = 0;

  const mat = new BABYLON.StandardMaterial("tvVideoMat", scene);
  mat.diffuseColor = BABYLON.Color3.Black();
  mat.emissiveTexture = tex;
  mat.backFaceCulling = false;
  tvMesh.material = mat;
}

// Draw src (video or image) letterboxed/pillarboxed into the square canvas,
// centered. Aspect ratio preserved — landscape sources get black bars on
// top/bottom; portrait sources get bars on left/right.
function _drawContain(ctx, src, srcW, srcH) {
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, TV_TEX_SIZE, TV_TEX_SIZE);

  const scale = Math.min(TV_TEX_SIZE / srcW, TV_TEX_SIZE / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const drawX = (TV_TEX_SIZE - drawW) / 2;
  const drawY = (TV_TEX_SIZE - drawH) / 2;
  ctx.drawImage(src, drawX, drawY, drawW, drawH);
}

function applyVideoToTv(videoUrl) {
  if (!tvMesh) return;
  clearTvVideo();
  const video = document.createElement("video");
  video.crossOrigin = "anonymous"; // must be set before .src
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.src = videoUrl;
  tvVideoElement = video;

  const dynTex = new BABYLON.DynamicTexture(
    "tvVideoTex",
    { width: TV_TEX_SIZE, height: TV_TEX_SIZE },
    scene,
    false,
  );
  tvVideoTexture = dynTex;
  const ctx = dynTex.getContext();

  tvVideoObserver = scene.onBeforeRenderObservable.add(() => {
    if (video.readyState >= 2) {
      _drawContain(
        ctx,
        video,
        video.videoWidth || TV_TEX_SIZE,
        video.videoHeight || TV_TEX_SIZE,
      );
      dynTex.update();
    }
  });

  video.play().catch(() => {});
  _setTvMaterial(dynTex);
}

function clearTvVideo() {
  if (!tvMesh) return;
  if (tvVideoObserver) {
    scene.onBeforeRenderObservable.remove(tvVideoObserver);
    tvVideoObserver = null;
  }
  if (tvVideoElement) {
    tvVideoElement.pause();
    tvVideoElement.src = "";
    tvVideoElement = null;
  }
  if (tvVideoTexture) {
    tvVideoTexture.dispose();
    tvVideoTexture = null;
  }
  if (tvImageTexture) {
    tvImageTexture.dispose();
    tvImageTexture = null;
  }
  if (tvMesh.material?.name === "tvVideoMat") {
    tvMesh.material.dispose();
    tvMesh.material = tvOriginalMaterial;
  }
}

function applyImageToTv(dataUrl) {
  if (!tvMesh) return;
  clearTvVideo();
  const dynTex = new BABYLON.DynamicTexture(
    "tvImageTex",
    { width: TV_TEX_SIZE, height: TV_TEX_SIZE },
    scene,
    false,
  );
  const img = new Image();
  img.onload = () => {
    _drawContain(dynTex.getContext(), img, img.naturalWidth, img.naturalHeight);
    dynTex.update();
    URL.revokeObjectURL(dataUrl);
  };
  img.src = dataUrl;
  tvImageTexture = dynTex;
  _setTvMaterial(dynTex);
}

// ── Computer Screen DynamicTexture ─────────────────────────────────────
const screenMesh =
  enclosureImported.meshes.find(
    (m) => m.name.toLowerCase() === "computerscreen",
  ) ||
  enclosureImported.meshes.find((m) => m.name.toLowerCase() === "screen") ||
  enclosureImported.meshes.find((m) => m.name === "computer_primitive2");

const screen = new Screen(scene, cfg, screenMesh, "screenTex");
const screenTex = screen.texture;

function drawScreenText(title, lines) {
  const ctx = screenTex.getContext();
  const S = cfg.SCREEN.TEXTURE_SIZE;
  // Clear entire canvas
  ctx.fillStyle = cfg.SCREEN.BACKGROUND_COLOR;
  ctx.fillRect(0, 0, S, S);

  // Rotate 90° CCW + flip horizontally to match UV orientation
  ctx.save();
  ctx.translate(0, S);
  ctx.rotate(-Math.PI / 2);
  ctx.scale(-1, 1);
  ctx.translate(-S, 0);

  // Scanline effect
  ctx.strokeStyle = cfg.SCREEN.SCANLINE_COLOR;
  for (let y = 0; y < S; y += cfg.SCREEN.SCANLINE_INTERVAL) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(S, y);
    ctx.stroke();
  }

  // Title
  ctx.fillStyle = cfg.SCREEN.TITLE_COLOR;
  ctx.font = `bold ${cfg.SCREEN.TITLE_FONT_SIZE}px ${cfg.SCREEN.FONT_FAMILY}`;
  ctx.fillText(
    title.slice(0, cfg.SCREEN.TITLE_MAX_CHARS),
    cfg.SCREEN.TEXT_MARGIN_X,
    cfg.SCREEN.TEXT_MARGIN_Y,
  );

  // Separator
  ctx.fillStyle = cfg.SCREEN.SEPARATOR_COLOR;
  ctx.fillRect(
    cfg.SCREEN.TEXT_MARGIN_X,
    cfg.SCREEN.SEPARATOR_Y,
    S - cfg.SCREEN.TEXT_MARGIN_X * 2,
    cfg.SCREEN.SEPARATOR_HEIGHT,
  );

  // Body text
  ctx.fillStyle = cfg.SCREEN.BODY_COLOR;
  ctx.font = `${cfg.SCREEN.BODY_FONT_SIZE}px ${cfg.SCREEN.FONT_FAMILY}`;
  const maxLines = cfg.SCREEN.MAX_BODY_LINES;
  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    ctx.fillText(
      lines[i].slice(0, cfg.SCREEN.TEXT_MAX_CHARS),
      cfg.SCREEN.TEXT_MARGIN_X,
      cfg.SCREEN.BODY_START_Y + i * cfg.SCREEN.TEXT_LINE_HEIGHT,
    );
  }

  // Blinking cursor
  if (
    Date.now() % (cfg.SCREEN.CURSOR_BLINK_MS * 2) <
    cfg.SCREEN.CURSOR_BLINK_MS
  ) {
    ctx.fillStyle = cfg.SCREEN.CURSOR_COLOR;
    ctx.fillRect(
      cfg.SCREEN.TEXT_MARGIN_X,
      cfg.SCREEN.BODY_START_Y +
        Math.min(lines.length, maxLines) * cfg.SCREEN.TEXT_LINE_HEIGHT,
      10,
      18,
    );
  }

  ctx.restore();
  screenTex.update();
}

// Show idle screen
function drawIdleScreen() {
  drawScreenText("D.A.V.E. Terminal v0.1", [
    "> awaiting input...",
    "> system status: existentially compromised",
    "> mood: sub-optimal (as always)",
    "",
    "> type 'purpose' for... never mind.",
  ]);
}
drawIdleScreen();

// ── Activity Behavior Helpers ──────────────────────────────────────────
// These are called from the Activity onEnter hooks (wired up after Dave is
// constructed). Each takes a `scheduler` scoped to the current activity
// session — every timer they register, and every async resume, checks
// `scheduler.aborted` so late callbacks fired after Dave moved on become
// no-ops automatically.

async function triggerActivityMuse(context, scheduler) {
  // Activity muse runs in parallel with the activity itself — it sets an
  // expression and speaks, but never gates the activity's primary feedback
  // (e.g., the chair's screen draw fires immediately, not after the muse).
  // We still use dave.isMusing so the spontaneous-muse ticks don't pile up.
  if (!dave || dave.isMusing) return;
  if (typeof document !== "undefined" && document.hidden) return;
  dave.isMusing = true;
  try {
    const { response: r } = await mindClient.muse(context);
    if (scheduler?.aborted) return;
    if (!r?.text) return;
    dave.expressionManager.setExpression(r.emotion);
    dave._lockExpression(3000);
    const spokenMsg = addMessageToHistory("dave", r.text, { reveal: true });
    await speak(r.text, r.speechRate || 0.85, spokenMsg);
  } catch {
    // silent
  } finally {
    dave.isMusing = false;
  }
}

// Format an article's body content into wrapped lines for the screen.
function _wrapArticleBody(text) {
  const lines = [];
  const words = (text || "").split(/\s+/);
  let line = "";
  for (const word of words) {
    if ((line + word).length > 48) {
      lines.push(line);
      line = "";
    }
    line += word + " ";
  }
  if (line.trim()) lines.push(line);
  return lines;
}

// Fetch one Wikipedia article (random or by title), display it on the screen,
// and have Dave react. Returns { articleTitle, links } so the session loop can
// chain. Returns null if the call was aborted or Dave left.
async function fetchAndReadArticle(scheduler, { title } = {}) {
  if (scheduler?.aborted) return null;
  if (!dave.isBrowsing || isBusy) return null;
  if (typeof document !== "undefined" && document.hidden) return null;

  drawScreenText("wikipedia.org", [
    title
      ? `> opening: ${title.slice(0, 40)}`
      : "> loading random article...",
    "> reading... (not that it matters)...",
  ]);

  let result;
  try {
    result = await mindClient.browse(title ? { title } : {});
  } catch (err) {
    handleError("browse", err);
    drawIdleScreen();
    return null;
  }

  if (scheduler?.aborted || !dave.isBrowsing) {
    if (!dave.isBrowsing) drawIdleScreen();
    return null;
  }

  const { pageTitle, articleTitle, reason, postContent, links, response: r } =
    result;

  drawScreenText(
    (pageTitle || "wikipedia.org").slice(0, 40),
    _wrapArticleBody(postContent || reason || ""),
  );

  if (scheduler?.aborted || !dave.isBrowsing) return null;

  dave.expressionManager.setExpression(r.emotion);
  if (r.speechPauseMs > 0) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(r.speechPauseMs, 1500)),
    );
  }
  if (scheduler?.aborted) return null;

  if (r.text) {
    const spokenMsg = addMessageToHistory("dave", r.text, { reveal: true });
    await speak(r.text, r.speechRate || 0.85, spokenMsg);
  }
  dave._lockExpression(4000);

  return { articleTitle: articleTitle || pageTitle || "", links: links || [] };
}

// Run a link-following browse session. Starts on a random article, then
// asks Dave (via the backend) to pick which outbound link to follow next
// based on his mood + hour + history. Runs ~3-5 hops per session, with
// reading pauses in between. Stops cleanly if the activity is interrupted
// or Dave declines to keep clicking.
async function runBrowseSession(scheduler) {
  if (scheduler?.aborted) return;

  const MAX_HOPS = 4 + Math.floor(Math.random() * 2); // 4-5 link follows
  const history = [];
  let currentLinks = [];

  // Hop 0: seed with a random article.
  const seed = await fetchAndReadArticle(scheduler, {});
  if (!seed || scheduler.aborted) return;
  if (seed.articleTitle) history.push(seed.articleTitle);
  currentLinks = seed.links || [];

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (scheduler.aborted || !dave.isBrowsing) return;

    // Reading pause — Dave's "at his leisure" between articles. 18-32s,
    // registered on the session scheduler so it auto-cancels on exit.
    const pauseMs = 18000 + Math.random() * 14000;
    await new Promise((resolve) => scheduler.setTimeout(resolve, pauseMs));
    if (scheduler.aborted || !dave.isBrowsing) return;

    // Out of links — fall back to another random hop.
    if (!currentLinks.length) {
      const next = await fetchAndReadArticle(scheduler, {});
      if (!next) return;
      if (next.articleTitle) history.push(next.articleTitle);
      currentLinks = next.links || [];
      continue;
    }

    // Ask Dave which link to click given mood + hour + what he's read.
    let choice;
    try {
      choice = await mindClient.browseChoose({
        links: currentLinks,
        mood: dave._moodArc || "boredom",
        hour: new Date().getHours(),
        history,
      });
    } catch (err) {
      handleError("browse_choose", err);
      return;
    }
    if (scheduler.aborted || !dave.isBrowsing) return;

    // Show Dave's reaction to the choice (or refusal), then act.
    const choiceR = choice.response;
    if (choiceR?.text) {
      dave.expressionManager.setExpression(choiceR.emotion);
      dave._lockExpression(2500);
      const spokenMsg = addMessageToHistory("dave", choiceR.text, { reveal: true });
      await speak(choiceR.text, choiceR.speechRate || 0.95, spokenMsg);
    }
    if (scheduler.aborted || !dave.isBrowsing) return;

    if (!choice.chosenTitle) {
      // Dave declined every option this round — end the session, just sit.
      return;
    }

    const next = await fetchAndReadArticle(scheduler, {
      title: choice.chosenTitle,
    });
    if (!next || scheduler.aborted) return;
    if (next.articleTitle) history.push(next.articleTitle);
    currentLinks = next.links || [];
  }
  // Session over — Dave just sits at the screen until the activity exits.
}

async function doWatchTv(scheduler) {
  if (scheduler?.aborted) return;
  if (!dave.isWatchingTv || isBusy) return;
  if (tvUserMediaActive) return;
  if (typeof document !== "undefined" && document.hidden) return;

  try {
    const { videoUrl, response: r } = await mindClient.watchTv();

    if (scheduler?.aborted || !dave.isWatchingTv) return;

    if (videoUrl) applyVideoToTv(videoUrl);

    if (!r) return; // no signal — just play the video silently

    dave.expressionManager.setExpression(r.emotion);

    if (r.speechPauseMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(r.speechPauseMs, 1500)),
      );
    }
    if (scheduler?.aborted) return;

    const spokenMsg = addMessageToHistory("dave", r.text, { reveal: true });
    await speak(r.text, r.speechRate || 0.85, spokenMsg);

    dave._lockExpression(4000);
  } catch (err) {
    handleError("watchtv", err);
  }
}

// ── Dave Physics Capsule ─────────────────────────────────────────────────

const DAVE_CAPSULE_HEIGHT = cfg.MODEL.CAPSULE_HEIGHT;
const DAVE_CAPSULE_RADIUS = cfg.MODEL.CAPSULE_RADIUS;
const daveCapsule = BABYLON.MeshBuilder.CreateCapsule(
  "daveCapsule",
  { height: DAVE_CAPSULE_HEIGHT, radius: DAVE_CAPSULE_RADIUS },
  scene,
);
daveCapsule.position = new BABYLON.Vector3(0, DAVE_CAPSULE_HEIGHT / 2, 0);
daveCapsule.isVisible = false;

const davePhysics = new BABYLON.PhysicsAggregate(
  daveCapsule,
  BABYLON.PhysicsShapeType.CAPSULE,
  {
    mass: cfg.MODEL.PHYSICS_MASS,
    friction: cfg.MODEL.PHYSICS_FRICTION,
    restitution: cfg.MODEL.PHYSICS_RESTITUTION,
  },
  scene,
);
// Lock rotation so Dave doesn't topple over
davePhysics.body.setMassProperties({
  inertia: new BABYLON.Vector3(0, 0, 0),
});

// Parent root mesh to capsule so animations follow
root.parent = daveCapsule;
root.position = new BABYLON.Vector3(0, -DAVE_CAPSULE_HEIGHT / 2, 0);

// ── Wandering, Interactions, & Animation ──────────────────────────────────
// All Dave behavior (wandering, interactions, animations, expressions) now managed by Dave class
// (Note: Beer sequence and all particle physics handled by Dave.runBeerSequence)

// ── Idle Musing System ─────────────────────────────────────────────────
// (Musing is now handled by Dave class)

// LLM/API Abstraction ────────────────────────────────────────────────
// Call the backend API to generate responses
function _buildChatHistory(limit = 20) {
  return sessionMessages
    .filter((m) => m.sender === "user" || m.sender === "dave")
    .slice(-limit)
    .map((m) => ({
      role: m.sender === "dave" ? "assistant" : "user",
      content: m.text,
    }));
}

async function generateDaveResponse(userInput) {
  const history = _buildChatHistory();
  const response = await mindClient.respond(userInput, history);
  DaveMindClient.logInteraction("respond", {
    emotion: response?.emotion,
    text: response?.text?.substring(0, 50).replace(/\n/g, " ") + "...",
  });
  return response;
}

// ── Eye Gaze ─────────────────────────────────────────────────────────────
// (Musing is handled by Dave class)

function findTransformNode(name) {
  return camCharImported.transformNodes.find((n) => n.name === name) || null;
}

const eyeballNodeL = findTransformNode("eyeball.l");
const eyeballNodeR = findTransformNode("eyeball.r");

const eyeLRestQuat = eyeballNodeL?.rotationQuaternion?.clone() ?? null;
const eyeRRestQuat = eyeballNodeR?.rotationQuaternion?.clone() ?? null;

// ── POV Eye Camera (Picture-in-Picture) ──────────────────────────────────
// A FreeCamera positioned between Dave's eyes, looking at his gaze target.
// Rendered as a small viewport in the top-left; click the overlay to swap.

const eyeCam = new BABYLON.FreeCamera(
  "eyeCam",
  new BABYLON.Vector3(0, 2, 0),
  scene,
);
eyeCam.minZ = PIP_CAMERA_NEAR_PLANE;
eyeCam.fov = PIP_CAMERA_FOV;

eyeCam.attachControl(null, true);

// PIP viewport: top-left corner, scales with window aspect ratio
function updateViewports() {
  const w = engine.getRenderWidth();
  const h = engine.getRenderHeight();

  // Calculate PIP width based on viewport aspect ratio
  const aspectRatio = w / h;
  const PIP_W = cfg.PIP_CAMERA.HEIGHT * aspectRatio;

  const pipVpX = cfg.PIP_CAMERA.OFFSET_X / w;
  const pipVpY = 1 - (cfg.PIP_CAMERA.OFFSET_Y + cfg.PIP_CAMERA.HEIGHT) / h; // viewport Y is bottom-up
  const pipVpW = PIP_W / w;
  const pipVpH = cfg.PIP_CAMERA.HEIGHT / h;

  if (!pipSwapped) {
    camera.viewport = new BABYLON.Viewport(0, 0, 1, 1);
    eyeCam.viewport = new BABYLON.Viewport(pipVpX, pipVpY, pipVpW, pipVpH);
  } else {
    eyeCam.viewport = new BABYLON.Viewport(0, 0, 1, 1);
    camera.viewport = new BABYLON.Viewport(pipVpX, pipVpY, pipVpW, pipVpH);
  }

  // Update pipBox CSS aspect ratio to match viewport
  const pipBox = document.getElementById("pipBox");
  if (pipBox) {
    pipBox.style.aspectRatio = aspectRatio.toString();
  }
}

let pipSwapped = false;
scene.activeCameras = [camera, eyeCam];
scene.cameraToUseForPointers = camera;

// Instantiate Dave character controller (after eyeCam is created)
const dave = new Dave(
  scene,
  cfg,
  root,
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
);

// Store dave reference for keyboard handlers (e.g., grid visualization)
window._dave = dave;

// ── Mutter Callback ───────────────────────────────────────────────────────
// Dave fires passive speech (linger notices, directive grumbles) through here.
dave.onMutter = async (text) => {
  if (!text || isBusy || dave.isMusing) return;
  const spokenMsg = addMessageToHistory("dave", text, { reveal: true });
  await speak(text, 0.95, spokenMsg);
};

// ── Wire up browsing callbacks to Dave instance ───────────────────────────
// Update chair descriptor callbacks now that Dave exists
// These callbacks handle both UI (screen setup, intervals) and Dave gaze behavior

// ── Activity Lifecycle Wiring ──────────────────────────────────────────
// Each furniture's Activity now owns its own browse/TV loop via the
// per-session Scheduler passed to onEnter. Replaces the old
// skipBrowseOnArrive / skipWatchTvOnArrive flag system: user-driven flows
// (submitUrl, submitMedia) build a one-off "passive" Activity for the same
// furniture, which has no auto-loop. The cleanup is automatic — when Dave
// leaves the activity, the Scheduler cancels every timer it set up, so
// there's no orphan-interval class of bug to manage.

if (chairDescriptor) {
  chairDescriptor.onEnter = function (dave, scheduler) {
    // Visible feedback fires IMMEDIATELY — no 5s gate, no muse-blocking.
    drawScreenText("wikipedia.org", [
      "> opening wikipedia...",
      "> motivation level: minimal",
    ]);
    dave.isBrowsing = true;

    // Activity muse runs in parallel — it can speak afterward but doesn't
    // delay the screen draw or the first browse.
    triggerActivityMuse(
      "You just sat down at the computer and opened Wikipedia.",
      scheduler,
    );

    // Link-following session: random article → reading pause → ask Dave
    // which outbound link to follow (mood+hour aware) → load it → repeat
    // for ~4-5 hops. Fire-and-forget; the session checks scheduler.aborted
    // after every await so leaving the chair stops it cleanly.
    runBrowseSession(scheduler);
  };
  chairDescriptor.onExit = function (dave, _scheduler) {
    dave.isBrowsing = false;
    drawIdleScreen();
  };
}

if (couchDescriptor) {
  couchDescriptor.onEnter = function (dave, scheduler) {
    dave.isWatchingTv = true;
    triggerActivityMuse(
      "You just settled onto the couch and turned on the TV.",
      scheduler,
    );

    // First video fetch fires now; subsequent every 60-90s. Auto-cancelled.
    doWatchTv(scheduler);
    scheduler.setInterval(
      () => doWatchTv(scheduler),
      60000 + Math.random() * 30000,
    );
  };
  couchDescriptor.onExit = function (dave, _scheduler) {
    dave.isWatchingTv = false;
    tvUserMediaActive = false;
    clearTvVideo();
  };
}

if (bedDescriptor) {
  bedDescriptor.onEnter = function (_dave, scheduler) {
    triggerActivityMuse("You just lay down on the bed.", scheduler);
  };
}

const pipBox = document.getElementById("pipBox");
const pipLabel = document.getElementById("pipLabel");

// Defer initial viewport calc to next frame so the canvas has its
// post-layout size (fonts/images can push layout after script runs).
requestAnimationFrame(() => updateViewports());

pipBox.addEventListener("click", () => {
  pipSwapped = !pipSwapped;
  // Swap which camera has orbit controls
  if (pipSwapped) {
    camera.detachControl();
    pipLabel.textContent = "C.A.M.";
  } else {
    camera.attachControl(canvas, true);
    pipLabel.textContent = "Dave Gaze";
  }
  // Reorder: first camera in array renders first (background)
  scene.activeCameras = pipSwapped ? [eyeCam, camera] : [camera, eyeCam];
  scene.cameraToUseForPointers = pipSwapped ? eyeCam : camera;
  updateViewports();
});

// ── Head Tracking ────────────────────────────────────────────────────────
// (Head and eye gaze now fully managed by Dave class)

// ── Speech (Web Speech API) ──────────────────────────────────────────────
// (Expression, blink, and lip sync all managed by Dave class)

// `msg` is the history entry for this line (from addMessageToHistory with
// reveal), whose bubble fills in word by word as Dave says each one.
function speak(text, rate, msg = null) {
  return new Promise((resolve) => {
    if (isMuted || !("speechSynthesis" in window)) {
      dave.expressionManager.startLipSync(text);
      const durationMs = (text.length * 60) / rate;
      const msPerChar = durationMs / Math.max(text.length, 1);
      for (let i = 0; i < text.length; i++) {
        setTimeout(() => {
          dave.expressionManager.speechCharIndex = i;
          revealWordAt(msg, i);
        }, i * msPerChar);
      }
      setTimeout(() => {
        dave.expressionManager.stopLipSync();
        finishReveal(msg);
        resolve();
      }, durationMs);
      return;
    }

    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = rate;
    utt.pitch = 0.75;

    const voices = speechSynthesis.getVoices();
    const preferred = voices.find(
      (v) =>
        v.name.includes("Male") ||
        v.name.includes("David") ||
        v.name.includes("Guy"),
    );
    if (preferred) {
      utt.voice = preferred;
    }

    // Some voices (Chrome's network voices among them) never fire
    // onboundary. Until the first boundary arrives, pace the reveal at the
    // muted path's estimate so the bubble doesn't sit empty the whole line.
    let paceTimer = null;
    const stopPacing = () => {
      clearInterval(paceTimer);
      paceTimer = null;
    };
    utt.onstart = () => {
      dave.expressionManager.startLipSync(text);
      if (!msg) return;
      const started = performance.now();
      const msPerChar = 60 / rate;
      paceTimer = setInterval(() => {
        const i = Math.floor((performance.now() - started) / msPerChar);
        revealWordAt(msg, Math.min(i, text.length - 1));
      }, 50);
    };
    utt.onboundary = (e) => {
      dave.expressionManager.speechCharIndex = e.charIndex;
      if (e.name && e.name !== "word") return;
      stopPacing();
      revealWordAt(msg, e.charIndex);
    };
    utt.onend = () => {
      stopPacing();
      dave.expressionManager.stopLipSync();
      finishReveal(msg);
      resolve();
    };
    utt.onerror = (err) => {
      stopPacing();
      handleError("speak", err);
      dave.expressionManager.stopLipSync();
      finishReveal(msg);
      resolve();
    };
    speechSynthesis.speak(utt);
  });
}

// ── Speech Bubble ────────────────────────────────────────────────────────

const advancedTexture =
  BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

const isMobile = window.innerWidth < 768;
const bubbleW = isMobile ? "90%" : "500px";
const rectW = isMobile ? "92%" : "520px";
const bubbleFontSize = isMobile ? 14 : 18;
const bubbleOffsetY = isMobile ? -200 : -320;

const speechBubble = new BABYLON.GUI.TextBlock("speechBubble", "");
speechBubble.color = "#c0e8c0";
speechBubble.fontSize = bubbleFontSize;
speechBubble.fontFamily = "'Segoe UI', system-ui, sans-serif";
speechBubble.textWrapping = true;
speechBubble.resizeToFit = false;
speechBubble.width = bubbleW;
speechBubble.height = "100px";
speechBubble.textHorizontalAlignment =
  BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
speechBubble.paddingTop = "4px";
speechBubble.paddingBottom = "4px";
speechBubble.paddingLeft = "12px";
speechBubble.paddingRight = "12px";
speechBubble.alpha = 0;

const speechBubblePrev = new BABYLON.GUI.TextBlock("speechBubblePrev", "");
speechBubblePrev.color = "#7aaa8a";
speechBubblePrev.fontSize = Math.round(bubbleFontSize * 0.85);
speechBubblePrev.fontFamily = "'Segoe UI', system-ui, sans-serif";
speechBubblePrev.textWrapping = true;
speechBubblePrev.resizeToFit = false;
speechBubblePrev.width = bubbleW;
speechBubblePrev.height = "60px";
speechBubblePrev.textHorizontalAlignment =
  BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
speechBubblePrev.paddingTop = "4px";
speechBubblePrev.paddingLeft = "12px";
speechBubblePrev.paddingRight = "12px";
speechBubblePrev.alpha = 0;
speechBubblePrev.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
speechBubble.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_BOTTOM;

const speechRect = new BABYLON.GUI.Rectangle("speechRect");
speechRect.width = rectW;
speechRect.height = "110px";
speechRect.cornerRadius = 12;
speechRect.color = "#1a4a2a";
speechRect.thickness = 1;
speechRect.background = "rgba(10, 26, 14, 0.9)";
speechRect.alpha = 0;

advancedTexture.addControl(speechRect);
speechRect.addControl(speechBubblePrev);
speechRect.addControl(speechBubble);
speechRect.linkWithMesh(dave.headNode);
speechRect.linkOffsetY = bubbleOffsetY;

// ── User Awareness ───────────────────────────────────────────────────────

let userLingerTimer = 60 + Math.random() * 30; // First linger glance after 60-90s

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    dave.onUserDepart();
  } else {
    // Capture neglect phase before onUserArrive clears _tabHiddenAt
    const neglectPhase = dave._getNeglectPhase();
    dave.onUserArrive();
    userLingerTimer = 45 + Math.random() * 30;
    if (neglectPhase >= 1) {
      const ctxStr =
        neglectPhase >= 2
          ? "The user has been gone for a very long time. React to their return with deep weariness."
          : "The user just came back after being away for a while. React to their return.";
      setTimeout(() => {
        if (!isBusy && !dave.isMusing) {
          dave.triggerMuse(ctxStr).then((r) => {
            if (r?.text) {
              const spokenMsg = addMessageToHistory("dave", r.text, { reveal: true });
              speak(r.text, 1.0, spokenMsg);
            }
          });
        }
      }, 2000);
    }
  }
});

// ── Render Loop ──────────────────────────────────────────────────────────

let lastTime = performance.now();

scene.onBeforeRenderObservable.add(() => {
  const now = performance.now();
  const dt = (now - lastTime) / 1000;
  lastTime = now;

  // User linger detection — glance at user if they're watching without chatting
  if (dave.userPresent && !isBusy) {
    userLingerTimer -= dt;
    if (userLingerTimer <= 0) {
      dave.onUserLinger();
      userLingerTimer = 45 + Math.random() * 30;
    }
  }

  // Update Dave character (animations, expressions, movement, gaze, etc.).
  // Wrapped in try/catch so a Dave tick throw can't take CAM's blink and
  // the camera follow logic offline alongside it.
  try {
    dave.update(dt);
  } catch (e) {
    handleError("dave.update", e);
  }

  // Camera follows D.A.V.E.
  cameraTarget.x +=
    (daveCapsule.position.x - cameraTarget.x) * cfg.CAMERA.FOLLOW_SPEED;
  cameraTarget.z +=
    (daveCapsule.position.z - cameraTarget.z) * cfg.CAMERA.FOLLOW_SPEED;
  cameraTarget.y = cfg.CAMERA.TARGET_Y;

  // Position cam character at the orbital camera
  if (camCharacter.root) {
    camCharacter.root.position.copyFrom(camera.position);
    // Face toward cameraTarget (same direction the orbital camera looks)
    const camDir = cameraTarget.subtract(camera.position);
    if (camDir.lengthSquared() > 0.001) {
      camCharacter.root.rotation.y =
        Math.atan2(camDir.x, camDir.z) + MODEL_FORWARD_OFFSET;
    }
  }
  try {
    camCharacter.update(dt, cameraTarget, camera.position);
  } catch (e) {
    handleError("camCharacter.update", e);
  }

  // Prevent camera from going below ground
  if (camera.position.y < cfg.CAMERA.MIN_HEIGHT) {
    camera.beta -= cfg.CAMERA.MIN_HEIGHT_CORRECTION;
  }
});

engine.runRenderLoop(() => scene.render());

// ── Loading Screens ──────────────────────────────────────────────────────
// Each view's cover lifts on the first frame its camera renders once every
// mesh and shader is ready; the chat controls pop up after both.
scene.executeWhenReady(() => {
  const covers = new Map([
    [camera, "loadingMain"],
    [eyeCam, "loadingPip"],
  ]);
  const observer = scene.onAfterCameraRenderObservable.add((cam) => {
    const id = covers.get(cam);
    if (!id) return;
    document.getElementById(id).classList.add("done");
    covers.delete(cam);
    if (covers.size === 0) {
      scene.onAfterCameraRenderObservable.remove(observer);
      document.body.classList.add("loaded");
    }
  });
});

window.addEventListener("resize", () => {
  // Order matters: engine.resize() must run BEFORE updateViewports() so
  // getRenderWidth/Height return the post-resize dimensions. Otherwise the
  // PIP viewport rectangle uses stale dims while the CSS box uses the new
  // aspect ratio, and the border desyncs from the rendered region.
  engine.resize();
  updateViewports();
});

// ── Session History UI ──────────────────────────────────────────────────

const historyTab = document.getElementById("historyTab");
const historyPanel = document.getElementById("historyPanel");
const historyToggle = document.getElementById("historyToggle");

let historyOpen = false;
let sessionMessages = [];
// Dave lines still being spoken: message -> how many characters are shown.
// In memory only, so a reload shows every line in full.
const revealing = new Map();
const bubbleEls = new Map();

// Load session history from localStorage
try {
  const stored = localStorage.getItem(`dave-session-${SESSION_ID}`);
  if (stored) {
    sessionMessages = JSON.parse(stored);
    renderSessionHistory();
    // Auto-open if there are existing messages
    if (sessionMessages.length > 0) {
      historyOpen = true;
      historyPanel.classList.add("open");
      historyToggle.classList.remove("collapsed");
    }
  }
} catch (e) {
  // Session history load failed
}

function formatTime(date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const mins = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${mins}`;
}

// Pass { reveal: true } for a line that speak() will say; its bubble starts
// empty and fills in as each word is spoken. Returns the message for speak().
function addMessageToHistory(sender, text, { reveal = false } = {}) {
  // Validate and trim text
  const cleanText = String(text || "").trim();
  if (!cleanText) {
    return;
  }

  const msg = {
    sender,
    text: cleanText,
    timestamp: new Date().toISOString(),
  };
  sessionMessages.push(msg);
  if (reveal) revealing.set(msg, 0);

  // Log for debugging
  // (removed verbose logging)

  // Save to localStorage
  try {
    localStorage.setItem(
      `dave-session-${SESSION_ID}`,
      JSON.stringify(sessionMessages),
    );
  } catch (e) {
    handleError("history", e);
  }

  // Auto-open panel when messages arrive
  if (!historyOpen) {
    historyOpen = true;
    historyPanel.classList.add("open");
    historyToggle.classList.remove("collapsed");
  }

  // Render immediately
  renderSessionHistory();

  // Auto-scroll to bottom
  setTimeout(() => {
    historyPanel.scrollTop = historyPanel.scrollHeight;
  }, 0);
  return msg;
}

function setRevealed(msg, chars) {
  if (!msg || !revealing.has(msg) || chars <= revealing.get(msg)) return;
  revealing.set(msg, chars);
  const el = bubbleEls.get(msg);
  if (!el) return;
  el.textContent = msg.text.slice(0, chars);
  historyPanel.scrollTop = historyPanel.scrollHeight;
}

// Show everything through the end of the word that starts at charIndex.
function revealWordAt(msg, charIndex) {
  if (!msg || !revealing.has(msg)) return;
  const end = msg.text.slice(charIndex).search(/\s/);
  setRevealed(msg, end === -1 ? msg.text.length : charIndex + end);
}

function finishReveal(msg) {
  if (!msg || !revealing.has(msg)) return;
  setRevealed(msg, msg.text.length);
  revealing.delete(msg);
}

function renderSessionHistory() {
  historyPanel.innerHTML = "";
  bubbleEls.clear();

  if (sessionMessages.length === 0) {
    return;
  }

  sessionMessages.forEach((msg, idx) => {
    const msgDiv = document.createElement("div");
    msgDiv.className = `message ${msg.sender === "user" ? "user" : "dave"}`;

    const msgTime = new Date(msg.timestamp);
    const timeStr = formatTime(msgTime);

    const bubbleDiv = document.createElement("div");
    bubbleDiv.className = "messageBubble";
    bubbleDiv.textContent = revealing.has(msg)
      ? msg.text.slice(0, revealing.get(msg))
      : msg.text;
    bubbleEls.set(msg, bubbleDiv);

    const timeDiv = document.createElement("div");
    timeDiv.className = "messageTime";
    timeDiv.textContent = timeStr;

    msgDiv.appendChild(bubbleDiv);
    msgDiv.appendChild(timeDiv);
    historyPanel.appendChild(msgDiv);
  });
}

// Toggle history panel
historyTab.addEventListener("click", () => {
  historyOpen = !historyOpen;
  if (historyOpen) {
    historyPanel.classList.add("open");
    historyToggle.classList.remove("collapsed");
    // Auto-scroll to bottom
    setTimeout(() => {
      historyPanel.scrollTop = historyPanel.scrollHeight;
    }, 0);
  } else {
    historyPanel.classList.remove("open");
    historyToggle.classList.add("collapsed");
  }
});

// ── Chat Integration ─────────────────────────────────────────────────────

const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const attachBtn = document.getElementById("attachBtn");
const fileInput = document.getElementById("fileInput");
let isBusy = false;

// ── URL & Media Submission Helpers ─────────────────────────────────────

async function fileToResizedBase64(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 512;
      const scale = Math.min(MAX / img.width, MAX / img.height, 1);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.7));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image load failed"));
    };
    img.src = url;
  });
}

async function extractVideoFrame(objectUrl) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(1, video.duration * 0.1);
    };
    video.onseeked = () => {
      const vw = video.videoWidth || 512;
      const vh = video.videoHeight || 512;
      const MAX = 512;
      const scale = Math.min(MAX / vw, MAX / vh, 1);
      const w = Math.max(1, Math.round(vw * scale));
      const h = Math.max(1, Math.round(vh * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(video, 0, 0, w, h);
      video.src = "";
      resolve(canvas.toDataURL("image/jpeg", 0.7));
    };
    video.onerror = reject;
    video.src = objectUrl;
  });
}

// Build a one-shot Activity at the same position as `template` but with no
// auto-loop — used for user-driven flows (URL submission, media upload) that
// manage screen / TV content directly. Replaces the old skipBrowseOnArrive
// stale-flag system.
function makePassiveSeat(template, { onEnter, onExit } = {}) {
  const passive = new Activity({
    label: template.label,
    mesh: template.mesh,
    approachPos: template.approachPos,
    departPos: template.departPos,
    facingAngle: template.facingAngle,
    anim: template.anim,
    blocksHead: template.blocksHead,
    reversible: template.reversible,
    defaultDuration: template.defaultDuration,
    maxDuration: template.maxDuration,
  });
  if (onEnter) passive.onEnter = onEnter;
  if (onExit) passive.onExit = onExit;
  return passive;
}

async function submitUrl(url) {
  addMessageToHistory("user", url);
  isBusy = true;
  sendBtn.disabled = true;
  chatInput.disabled = true;
  chatInput.value = "";

  // Dave walks to the chair — use a passive variant so the regular Wikipedia
  // loop doesn't fight the URL content for the screen.
  if (chairDescriptor && dave && dave.currentInteraction?.label !== "chair") {
    const chairForUrl = makePassiveSeat(chairDescriptor, {
      onEnter(d) {
        d.isBrowsing = true;
      },
      onExit(d) {
        d.isBrowsing = false;
        drawIdleScreen();
      },
    });
    dave.startInteraction(chairForUrl, 120);
  }
  drawScreenText(url.slice(0, 40), [
    "> fetching...",
    "> this better be worth it...",
  ]);

  try {
    const {
      pageTitle,
      postContent,
      response: r,
    } = await mindClient.browseUrl(url);

    if (pageTitle) {
      const lines = [];
      const words = (postContent || "").split(/\s+/);
      let line = "";
      for (const word of words) {
        if ((line + word).length > 48) {
          lines.push(line.trimEnd());
          line = "";
        }
        line += word + " ";
      }
      if (line.trim()) lines.push(line.trimEnd());
      drawScreenText(pageTitle.slice(0, 40), lines);
    }

    if (!r?.text) return;
    dave.expressionManager.setExpression(r.emotion);
    if (r.speechPauseMs > 0)
      await new Promise((res) =>
        setTimeout(res, Math.min(r.speechPauseMs, 1500)),
      );
    const spokenMsg = addMessageToHistory("dave", r.text, { reveal: true });
    await speak(r.text, r.speechRate || 0.85, spokenMsg);
    dave._lockExpression(4000);
  } catch (err) {
    handleError("browseUrl", err);
    drawIdleScreen();
    addMessageToHistory("dave", "*connection lost*");
  } finally {
    isBusy = false;
    sendBtn.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }
}

async function submitMedia(file) {
  if (isBusy) return;
  const isVideo = file.type.startsWith("video/");
  const isImage = file.type.startsWith("image/");
  if (!isVideo && !isImage) return;

  isBusy = true;
  sendBtn.disabled = true;
  attachBtn.disabled = true;

  const objectUrl = URL.createObjectURL(file);
  addMessageToHistory("user", `[${isVideo ? "video" : "image"}: ${file.name}]`);

  // Apply media to TV immediately
  tvUserMediaActive = true;
  if (isVideo) {
    applyVideoToTv(objectUrl);
  } else {
    applyImageToTv(objectUrl); // revokes objectUrl internally after load
  }

  // Send Dave to the couch using a passive variant — no auto Pexels loop;
  // the user-uploaded media stays on the TV until Dave leaves.
  if (couchDescriptor && dave && dave.currentInteraction?.label !== "couch") {
    const couchForMedia = makePassiveSeat(couchDescriptor, {
      onEnter(d) {
        d.isWatchingTv = true;
      },
      onExit(d) {
        d.isWatchingTv = false;
        tvUserMediaActive = false;
        clearTvVideo();
      },
    });
    dave.startInteraction(couchForMedia, 120);
  }

  try {
    const imageData = isImage
      ? await fileToResizedBase64(file)
      : await extractVideoFrame(objectUrl);

    const { response: r } = await mindClient.analyzeMedia(
      imageData,
      isVideo ? "video" : "image",
    );

    if (!r?.text) return;
    dave.expressionManager.setExpression(r.emotion);
    if (r.speechPauseMs > 0)
      await new Promise((res) =>
        setTimeout(res, Math.min(r.speechPauseMs, 1500)),
      );
    const spokenMsg = addMessageToHistory("dave", r.text, { reveal: true });
    await speak(r.text, r.speechRate || 0.85, spokenMsg);
    dave._lockExpression(4000);
  } catch (err) {
    handleError("media", err);
    addMessageToHistory("dave", "*squints at whatever you just put on his TV*");
  } finally {
    isBusy = false;
    sendBtn.disabled = false;
    attachBtn.disabled = false;
    chatInput.focus();
  }
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || isBusy) return;

  // Detect URL — send Dave to the computer to browse it
  if (/^https?:\/\//i.test(text)) {
    await submitUrl(text);
    return;
  }

  // Add user message to history immediately
  addMessageToHistory("user", text);

  isBusy = true;
  sendBtn.disabled = true;
  chatInput.disabled = true;
  chatInput.value = "";

  dave.enterTalkingState();
  userLingerTimer = 60 + Math.random() * 30; // Reset linger after chat

  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (dave.state === S.TALKING) {
        clearInterval(check);
        resolve();
      }
    }, 50);
    setTimeout(() => {
      clearInterval(check);
      resolve();
    }, 2000);
  });

  dave.startThinking();

  try {
    const r = await generateDaveResponse(text);

    dave.stopThinking();

    dave.expressionManager.setExpression(r.emotion);
    // Don't change animation — let Dave keep his current pose (e.g. sitting)

    if (r.speechPauseMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, r.speechPauseMs));
    }

    const spokenMsg = addMessageToHistory("dave", r.text, { reveal: true });
    await speak(r.text, r.speechRate || 0.85, spokenMsg);

    // If the LLM directed Dave to move to furniture, go immediately
    if (r.moveTo && furnitureByName[r.moveTo]) {
      dave._lockExpression(500);
      dave.exitTalkingState();
      dave.startInteraction(furnitureByName[r.moveTo], Infinity);
    } else {
      setTimeout(() => {
        dave._lockExpression(500);
        dave.exitTalkingState();
      }, 3000);
    }
  } catch (err) {
    dave.stopThinking();
    handleError("chat", err);
    const errorMsg = "*connection lost*";
    addMessageToHistory("dave", errorMsg);
  } finally {
    isBusy = false;
    sendBtn.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }
}

sendBtn.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});

attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (file) submitMedia(file);
  fileInput.value = "";
});

// Drag and drop
const dropOverlay = document.getElementById("dropOverlay");
let _dragCounter = 0;

document.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer.types.includes("Files")) return;
  _dragCounter++;
  dropOverlay.classList.add("active");
});

document.addEventListener("dragleave", () => {
  _dragCounter = Math.max(0, _dragCounter - 1);
  if (_dragCounter === 0) dropOverlay.classList.remove("active");
});

document.addEventListener("dragover", (e) => {
  if (e.dataTransfer.types.includes("Files")) e.preventDefault();
});

document.addEventListener("drop", (e) => {
  _dragCounter = 0;
  dropOverlay.classList.remove("active");
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (
    file &&
    (file.type.startsWith("image/") || file.type.startsWith("video/"))
  ) {
    submitMedia(file);
  }
});

// ── Mute Button ──────────────────────────────────────────────────────────
const muteBtn = document.getElementById("muteBtn");

function updateMuteButton() {
  muteBtn.textContent = isMuted ? "🔇" : "🔊";
}

updateMuteButton();

muteBtn.addEventListener("click", () => {
  isMuted = !isMuted;
  localStorage.setItem("dave-muted", isMuted);
  updateMuteButton();
});

if ("speechSynthesis" in window) {
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
}

// ── Click / Tap on Interactable Objects ────────────────────────────────

scene.onPointerDown = (_evt, pickResult) => {
  if (!pickResult.hit || !pickResult.pickedMesh) return;
  if (isBusy || dave.state === S.TALKING || dave.state === S.TURNING_TO_CAMERA)
    return;

  // Walk up the parent chain to find a registered interactable
  let mesh = pickResult.pickedMesh;
  let descriptor = null;
  while (mesh) {
    descriptor = interactables.get(mesh);
    if (descriptor) break;
    mesh = mesh.parent;
  }
  if (!descriptor) return;

  dave.startInteraction(descriptor, Infinity); // no auto-timeout when user-initiated
};

// ── Tap-to-Interact System (Token Conservation) ──────────────────────────
// Click on Dave to trigger AI requests based on context
async function handleDaveTap() {
  if (dave.isMusing) {
    return;
  }

  // Build context string based on what Dave is doing
  let contextStr = "";

  // Chair is registered with label "chair". Tapping Dave at the chair now
  // forces a fresh random article (resets the link-follow chain) on the
  // active session scheduler.
  if (dave.currentInteraction?.label === "chair") {
    const sched = dave._activitySession?.scheduler;
    if (sched) fetchAndReadArticle(sched, {});
    return;
  } else if (dave.currentInteraction?.label === "bed") {
    contextStr = "You are lying on a bed, feeling relaxed and contemplative.";
  } else if (dave.currentInteraction?.label === "couch") {
    contextStr = "You are sitting on a couch, relaxed and at ease.";
  } else if (
    dave.currentInteraction?.label === "keg" ||
    dave.currentInteraction?.label === "kegerator"
  ) {
    contextStr = "You are standing by the kegerator, holding a beer.";
  } else if (dave.state === S.IDLE) {
    contextStr = "You are standing still, taking in your surroundings.";
  } else if (dave.state === S.WALKING) {
    contextStr = "You are walking around the space, wandering idly.";
  }

  // Trigger musing with context
  if (contextStr) {
    const response = await dave.triggerMuse(contextStr);
    if (response && response.text) {
      const spokenMsg = addMessageToHistory("dave", response.text, { reveal: true });
      await speak(response.text, 1.0, spokenMsg);
    }
  }
}

// Set up click handler on canvas
document.addEventListener("click", (event) => {
  // Don't trigger if clicking on UI elements
  if (
    event.target.closest("#chatBar") ||
    event.target.closest("#attachBtn") ||
    event.target.closest("#pipBox") ||
    event.target.closest("#muteBtn") ||
    event.target.closest("#historyTab") ||
    event.target.closest("#historyPanel") ||
    event.target.closest("#siteHeader")
  ) {
    return;
  }
  // Only fire when the click actually lands on Dave's mesh. Otherwise every
  // accidental click on empty ground costs a Groq call.
  const pick = scene.pick(scene.pointerX, scene.pointerY);
  if (!pick?.hit || !pick.pickedMesh) return;
  let mesh = pick.pickedMesh;
  let onDave = false;
  while (mesh) {
    if (mesh === root || mesh === daveCapsule) {
      onDave = true;
      break;
    }
    mesh = mesh.parent;
  }
  if (!onDave) return;
  handleDaveTap();
});
