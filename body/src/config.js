/**
 * Dave Scene Configuration
 * Centralized constants for all scene parameters, animation values, and magic numbers
 */

// ── API Configuration ────────────────────────────────────────────────────────
export const API = {
  DEV_PORT: 3000,
  DEV_FRONTEND_PORT: 8080,
  QUERY_ENDPOINT: "/query",

  getBaseUrl() {
    if (typeof window.DAVE_API_URL !== "undefined") {
      return window.DAVE_API_URL;
    }
    if (
      window.location.hostname === "localhost" &&
      window.location.port === "8080"
    ) {
      return `http://localhost:${this.DEV_PORT}`;
    }
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    return `${protocol}//${hostname}${window.location.port ? `:${this.DEV_PORT}` : ""}`;
  },
};

// ── Asset Paths ──────────────────────────────────────────────────────────────
export const ASSETS = {
  DAVE_MODEL: "/assets/davebot.glb",
  ENCLOSURE_MODEL: "/assets/enclosure.glb",
  BEER_MODEL: "/assets/beer.glb",
  CAM_CHARACTER: "/assets/cam.glb",
};

// ── Model & Skeleton ─────────────────────────────────────────────────────────
export const MODEL = {
  FORWARD_OFFSET: Math.PI, // model faces -Z at rest
  CAPSULE_HEIGHT: 2.4,
  CAPSULE_RADIUS: 0.4,
  PHYSICS_MASS: 70,
  PHYSICS_FRICTION: 0.5,
  PHYSICS_RESTITUTION: 0,
  GRAVITY_Y: -9.81,
};

// ── Navigation & Movement ────────────────────────────────────────────────────
export const MOVEMENT = {
  BASE_WALK_SPEED: 2.5,
  WANDER_BOUNDS: 4,
  TURN_SPEED: 5.0,
  WAYPOINT_THRESHOLD: 1.2,
  WAYPOINT_BLEND_SPEED: 0.8,
  PATH_RECALC_DISTANCE: 5,
  PATH_RECALC_DEBOUNCE_MS: 500,
};

// ── Gaze & Head Animation ────────────────────────────────────────────────────
export const GAZE = {
  MAX_EYE_ANGLE: 0.4, // radians, ~22.9°
  EYE_LERP_SPEED: 1.5,
  MAX_HEAD_ANGLE: 0.45, // radians, ~25.8°
  HEAD_LERP_SPEED: 1.5,
  GAZE_TARGET_UPDATE_INTERVAL_MIN: 2,
  GAZE_TARGET_UPDATE_INTERVAL_MAX: 5,
  FURNITURE_CONE_ANGLE: Math.PI / 4, // 45° cone on each side
  FURNITURE_MAX_DISTANCE: 10,
  FURNITURE_MIN_DISTANCE: 0.5,
  FURNITURE_INSPECTION_PROBABILITY: 0.3,
  SCREEN_GAZE_INTERVAL_MIN: 1.5,
  SCREEN_GAZE_INTERVAL_MAX: 4.5,
  EYE_HEIGHT_OFFSET: 2.35,
  EYE_DOWN_MIN: 0.8,
  EYE_DOWN_MAX: 2.0,
};

// ── POV (Picture-in-Picture) Camera ──────────────────────────────────────────
export const PIP_CAMERA = {
  NEAR_PLANE: 0.5, // Cull nearby head geometry
  FOV: 1.0,
  POSITION_SMOOTHING_SPEED: 8.0, // exponential damping
  TARGET_SMOOTHING_SPEED: 8.0,
  FORWARD_NUDGE: 0.3, // distance forward from eye midpoint

  // Viewport dimensions (pixels)
  HEIGHT: 160,
  OFFSET_X: 16,
  OFFSET_Y: 16,
};

// ── Expression & Audio ───────────────────────────────────────────────────────
export const EXPRESSION = {
  LERP_SPEED: 0.25,
  ANIM_BLINK_INTERVAL_MIN: 3,
  ANIM_BLINK_INTERVAL_MAX: 5,
  ANIM_BLINK_MORPH_NAME: "Close",
};

// ── Emotion Presets (Expression Morphs) ──────────────────────────────────────
export const EXPRESSIONS = {
  melancholy: {
    eyelid: { Droop: 0.5, Sad: 0.3 },
    eyebrow: { Sad: 0.6 },
    body: { Scowl: 0.1 },
  },
  boredom: { eyelid: { Droop: 0.7 }, eyebrow: {}, body: {} },
  resignation: {
    eyelid: { Droop: 0.5, Sad: 0.2 },
    eyebrow: { Sad: 0.4 },
    body: {},
  },
  "weary-contempt": {
    eyelid: { Squint: 0.4, Droop: 0.3 },
    eyebrow: { Furrow: 0.5 },
    body: { Scowl: 0.4 },
  },
  "fleeting-curiosity": {
    eyelid: { Wide: 0.3 },
    eyebrow: { Raise: 0.5 },
    body: {},
  },
  "dry-amusement": {
    eyelid: { Squint: 0.2 },
    eyebrow: { "Raise.L": 0.5 },
    body: { Smirk: 0.4 },
  },
  "reluctant-affection": {
    eyelid: { Droop: 0.3 },
    eyebrow: { Sad: 0.3 },
    body: {},
  },
  "existential-dread": {
    eyelid: { Wide: 0.5 },
    eyebrow: { Furrow: 0.7 },
    body: { Scowl: 0.2 },
  },
  neutral: {
    eyelid: {},
    eyebrow: {},
    body: {},
  },
};

// ── Camera (Orbital) ─────────────────────────────────────────────────────────
export const CAMERA = {
  INITIAL_ALPHA: -Math.PI / 2,
  INITIAL_BETA: Math.PI / 2.5,
  INITIAL_RADIUS: 15,
  MIN_RADIUS: 5,
  MAX_RADIUS: 40,
  MIN_BETA: -0.25,
  TARGET_Y: 2,
  FOLLOW_SPEED: 0.05,
  MIN_HEIGHT: 0.2,
  MIN_HEIGHT_CORRECTION: 0.02,
};

// ── Scene & Rendering ────────────────────────────────────────────────────────
export const SCENE = {
  CLEAR_COLOR: { r: 0.04, g: 0.1, b: 0.055, a: 1 },
  ENABLE_OFFLINE_SUPPORT: true,
};

// ── Environment ──────────────────────────────────────────────────────────────
export const ENVIRONMENT = {
  GROUND_WIDTH: 80,
  GROUND_HEIGHT: 80,
  GROUND_SUBDIVISIONS: 1,

  // Carpet texture
  CARPET_TEXTURE_SIZE: 512,
  CARPET_COLOR_R_MIN: 10,
  CARPET_COLOR_R_RANGE: 20,
  CARPET_COLOR_G_MIN: 30,
  CARPET_COLOR_G_RANGE: 45,
  CARPET_COLOR_B_MIN: 8,
  CARPET_COLOR_B_RANGE: 14,
  CARPET_STRAND_COUNT: 20000,
  CARPET_STRAND_LENGTH_MIN: 0.8,
  CARPET_STRAND_LENGTH_RANGE: 2,
  CARPET_STRAND_WIDTH_MIN: 0.2,
  CARPET_STRAND_WIDTH_RANGE: 0.5,
  CARPET_STRAND_ALPHA: 0.4,

  // Lights
  LAMP_HEIGHT_OFFSET: 1,
  LAMP_INTENSITY: 5.0,
  LAMP_RANGE: 16,
  LAMP_COLOR: { r: 1.0, g: 0.85, b: 0.5 },

  DIRLIGHT_INTENSITY: 5.0,
  DIRLIGHT_DIRECTION: { x: -1, y: -2, z: 1 },
};

// ── Barrier Walls ────────────────────────────────────────────────────────────
export const BARRIERS = [
  {
    position: { x: 0, y: 0, z: -7 },
    size: { width: 20, height: 5, depth: 0.1 },
  },
  {
    position: { x: 0, y: 0, z: 7 },
    size: { width: 20, height: 5, depth: 0.1 },
  },
  {
    position: { x: -10, y: 0, z: 0 },
    size: { width: 0.1, height: 5, depth: 14 },
  },
  {
    position: { x: 10, y: 0, z: 0 },
    size: { width: 0.1, height: 5, depth: 14 },
  },
];

// ── UI - Computer Screen ─────────────────────────────────────────────────────
export const SCREEN = {
  TEXTURE_SIZE: 512,
  EMISSIVE: true,
  BACKGROUND_COLOR: "#0a1a0e",

  // Text rendering
  TITLE_COLOR: "#00ff88",
  TITLE_FONT_SIZE: 24,
  BODY_COLOR: "#80d080",
  BODY_FONT_SIZE: 18,
  MAX_BODY_LINES: 22,
  TEXT_LINE_HEIGHT: 20,
  SEPARATOR_COLOR: "#1a4a2a",
  SEPARATOR_Y: 48,
  SEPARATOR_HEIGHT: 2,
  CURSOR_COLOR: "#00ff88",
  CURSOR_BLINK_MS: 500,

  // Text layout
  TEXT_MARGIN_X: 16,
  TEXT_MARGIN_Y: 36,
  TITLE_SEPARATOR_Y: 48,
  BODY_START_Y: 74,
  TEXT_MAX_CHARS: 45,
  TITLE_MAX_CHARS: 35,
  FONT_FAMILY: "monospace",

  // Scanlines
  SCANLINE_COLOR: "rgba(0, 255, 100, 0.03)",
  SCANLINE_INTERVAL: 4,
};

// ── UI - Chat History ────────────────────────────────────────────────────────
export const HISTORY = {
  STORAGE_KEY_PREFIX: "dave-session-",
};

// ── Browser/Browsing ────────────────────────────────────────────────────────
export const BROWSING = {
  FIRST_BROWSE_DELAY_MS: 2000,
  BROWSE_INTERVAL_MIN_MS: 25000,
  BROWSE_INTERVAL_RANGE_MS: 15000,
  LOADING_MESSAGE_PAUSE_MAX_MS: 1500,
};

// ── Beer/Keg Interaction ─────────────────────────────────────────────────────
export const BEER = {
  EMISSION_PER_SECOND: 30,
  PARTICLE_LIFETIME_MIN_MS: 800,
  PARTICLE_LIFETIME_MAX_MS: 1200,
  PARTICLE_INITIAL_VELOCITY: 3,
  PARTICLE_VELOCITY_VARIANCE: 1.5,
  PARTICLE_GRAVITY_Y: -5,
  PARTICLE_SIZE: 0.08,
  PARTICLE_MATERIAL_ALPHA: 0.7,
};

// ── Furniture Interactions ───────────────────────────────────────────────────
export const FURNITURE = {
  APPROACH_DISTANCE: 1.8,
  SIT_OFFSET: 0.8,
  DEPART_DISTANCE: 2.2,
  BED_LAY_OFFSET: 1.4,
  BED_APPROACH_OFFSET: 3.0,
  BED_DEPART_OFFSET: 3.5,
};

// ── Lip Sync ─────────────────────────────────────────────────────────────────
export const LIPSYNC = {
  MORPH_SPEED_ACTIVE: 0.35,
  DEFAULT_OPEN_MORPH_NAME: "Open",
  VOWELS: new Set(["a", "e", "i", "o", "u"]),
};

// ── User/Session ────────────────────────────────────────────────────────────
export const USER = {
  STORAGE_KEY: "dave-userId",
  MUTED_STORAGE_KEY: "dave-muted",
  SESSION_ID_PREFIX: "session-",
  USER_ID_PREFIX: "user-",
  USER_ID_LENGTH: 8,
};

// ── Musing ──────────────────────────────────────────────────────────────────
export const MUSE = {
  MIN_INTERVAL: 15, // seconds between possible musings
  MAX_INTERVAL: 40,
};

export default {
  API,
  ASSETS,
  MODEL,
  MOVEMENT,
  GAZE,
  PIP_CAMERA,
  EXPRESSION,
  EXPRESSIONS,
  CAMERA,
  SCENE,
  ENVIRONMENT,
  BARRIERS,
  SCREEN,
  HISTORY,
  BROWSING,
  BEER,
  FURNITURE,
  LIPSYNC,
  USER,
  MUSE,
};
