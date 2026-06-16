/**
 * Dave Expression Manager
 * Manages facial expressions through morphtarget interpolation
 * Supports smooth transitions between emotional states
 */

// Morph targets that are exclusively owned by a different system. The
// expression manager must NOT iterate over these in _updateMorphs — that
// would clobber the owning system's per-frame writes:
//   - "Close" on the eyelid is owned by updateBlink (Dave class)
//   - "Open"  on the body   is owned by _updateLipSync below
// (CamCharacter's updateExpression has the same Close carve-out — Dave's
// was missing, which is why the blink appeared to "get cut off".)
const CONTROL_MORPHS = {
  eyelid: new Set(["Close"]),
  body: new Set(["Open"]),
  eyebrow: new Set(),
};

export class ExpressionManager {
  /**
   * Constructor
   * @param {object} morphMaps - { eyelid, eyebrow, body } morphtarget maps
   * @param {object} expressions - Expression presets config
   * @param {object} config - Configuration with LERP_SPEED
   */
  constructor(morphMaps, expressions, config = {}) {
    this.morphMaps = morphMaps;
    this.expressions = expressions;
    this.config = config;

    // Current expression state (target values)
    this.expressionState = {
      eyelid: this._createEmptyMorphState(morphMaps.eyelid),
      eyebrow: this._createEmptyMorphState(morphMaps.eyebrow),
      body: this._createEmptyMorphState(morphMaps.body),
    };

    // Current blend state (actual values)
    this.blendState = {
      eyelid: this._createEmptyMorphState(morphMaps.eyelid),
      body: this._createEmptyMorphState(morphMaps.body),
      eyebrow: this._createEmptyMorphState(morphMaps.eyebrow),
    };

    this.currentEmotion = "neutral";
    this.lerpSpeed = config.LERP_SPEED || 0.1;

    // ── Lip Sync ────────────────────────────────────────────────────────────
    this.lipSyncActive = false;
    this.lipSyncTarget = 0;
    this.speechText = "";
    this._speechCharIndex = 0;
  }

  /**
   * Set expression by emotion name
   * @param {string} emotion - Emotion key from expressions config
   */
  setExpression(emotion) {
    const expr = this.expressions[emotion] || this.expressions.neutral;
    if (!expr) {
      console.warn(`[ExpressionManager] Unknown emotion: "${emotion}"`);
      return;
    }
    if (this.currentEmotion === emotion) return;

    this.currentEmotion = emotion;

    // Update morphtarget values
    this.expressionState.eyelid = {
      ...this._createEmptyMorphState(this.morphMaps.eyelid),
      ...expr.eyelid,
    };
    this.expressionState.eyebrow = {
      ...this._createEmptyMorphState(this.morphMaps.eyebrow),
      ...expr.eyebrow,
    };
    this.expressionState.body = {
      ...this._createEmptyMorphState(this.morphMaps.body),
      ...expr.body,
    };
  }

  /**
   * Get current emotion
   */
  getEmotion() {
    return this.currentEmotion;
  }

  /**
   * Set individual morph value directly
   * @param {string} morphMap - "eyelid", "eyebrow", or "body"
   * @param {string} morphName - Morph target name
   * @param {number} value - Value 0-1
   */
  setMorphDirect(morphMap, morphName, value) {
    if (this.expressionState[morphMap]) {
      this.expressionState[morphMap][morphName] = value;
    }
  }

  /**
   * Update morphtargets to blend toward expression state, then apply lip sync.
   * Called once per frame.
   */
  update() {
    this._updateMorphs("eyelid");
    this._updateMorphs("eyebrow");
    this._updateMorphs("body");
    this._updateLipSync();
  }

  // ── Lip Sync ──────────────────────────────────────────────────────────────

  get speechCharIndex() {
    return this._speechCharIndex;
  }
  set speechCharIndex(v) {
    this._speechCharIndex = v;
  }

  startLipSync(text) {
    this.lipSyncActive = true;
    this.speechText = text;
    this._speechCharIndex = 0;

    // Watchdog: speechSynthesis.onend is documented in Chrome to occasionally
    // not fire (long utterances, tab visibility changes, voice glitches),
    // which would leave lipSyncActive true and freeze the mouth open. Force
    // a stop once we're well past the time the utterance could possibly need.
    if (this._lipSyncWatchdog) clearTimeout(this._lipSyncWatchdog);
    const maxMs = Math.max(2000, (text?.length ?? 0) * 150 + 3000);
    this._lipSyncWatchdog = setTimeout(() => this.stopLipSync(), maxMs);
  }

  stopLipSync() {
    this.lipSyncActive = false;
    this.lipSyncTarget = 0;
    if (this._lipSyncWatchdog) {
      clearTimeout(this._lipSyncWatchdog);
      this._lipSyncWatchdog = null;
    }
  }

  _updateLipSync() {
    const mouthMorph = this.morphMaps.body?.["Open"];
    if (!mouthMorph) return;

    if (!this.lipSyncActive || !this.speechText) {
      // Mouth fully closed when inactive — blend to 0 quickly
      mouthMorph.influence =
        mouthMorph.influence +
        (0 - mouthMorph.influence) * Math.min(this.lerpSpeed * 8, 1);
      return;
    }

    // Per-character amplitude. Chrome's SpeechSynthesisUtterance.onboundary
    // only fires per WORD, so speechCharIndex jumps in chunks — but that's
    // fine, we only use it to scale the swing, not to drive the rhythm.
    // The actual open/close oscillation is driven off the clock below.
    const char = (this.speechText[this.speechCharIndex] || " ").toLowerCase();
    let amplitude;
    if ("aæɑʌ".includes(char)) amplitude = 0.9;          // wide vowels (a, ah)
    else if ("oɔ".includes(char)) amplitude = 0.8;        // rounded vowels (o)
    else if ("eɛ".includes(char)) amplitude = 0.7;        // mid vowels (e)
    else if ("uʊ".includes(char)) amplitude = 0.55;       // close-back (u, oo)
    else if ("iɪy".includes(char)) amplitude = 0.45;      // close-front (ee, i)
    else if ("mbpfv".includes(char)) amplitude = 0.35;    // bilabials/labiodentals
    else if ("tdnlszʃ".includes(char)) amplitude = 0.4;   // coronals
    else if ("kgŋhrwj".includes(char)) amplitude = 0.45;  // dorsals/glides
    else if ("'`\"-".includes(char)) amplitude = 0.3;     // punctuation that flows
    else if (",;:".includes(char)) amplitude = 0.1;       // short pauses
    else if (".!?".includes(char)) amplitude = 0;         // sentence end — close
    else if (char === " ") amplitude = 0.1;               // brief inter-word close
    else amplitude = 0.5;                                 // unknown — moderate

    // Time-based oscillation at typical syllable rates. Mixing two slightly
    // off-tempo sines breaks the metronome feel a single frequency would
    // produce. ~5 Hz primary (~5 syllables/sec, normal speech pace) plus a
    // ~8.5 Hz harmonic for finer mouth shapes.
    const t = performance.now() * 0.001;
    const osc =
      Math.sin(t * Math.PI * 10) * 0.6 + Math.sin(t * Math.PI * 17) * 0.4;
    const wave = osc * 0.5 + 0.5; // map [-1, 1] → [0, 1]

    // Small per-call jitter so identical amplitudes don't track in lockstep
    // across multiple utterances or repeated chars.
    const jitter = Math.sin(t * Math.PI * 41) * 0.04;

    const target = Math.max(0, Math.min(1, amplitude * wave + jitter));
    this.lipSyncTarget = target;

    // Lerp toward the time-driven target. Faster lerp than expression morphs
    // so the mouth tracks the oscillation tightly.
    mouthMorph.influence =
      mouthMorph.influence +
      (target - mouthMorph.influence) * Math.min(this.lerpSpeed * 12, 1);
  }

  /**
   * Get current blend value for a morph
   * @param {string} morphMap - "eyelid", "eyebrow", or "body"
   * @param {string} morphName - Morph name
   */
  getMorphValue(morphMap, morphName) {
    return this.blendState[morphMap]?.[morphName] ?? 0;
  }

  /**
   * Internal: Create empty morph state object
   * @private
   */
  _createEmptyMorphState(morphMap) {
    const state = {};
    for (const name in morphMap) {
      state[name] = 0;
    }
    return state;
  }

  /**
   * Internal: Update morphtargets for a specific map
   * @private
   */
  _updateMorphs(morphMapKey) {
    const morphMap = this.morphMaps[morphMapKey];
    const targetState = this.expressionState[morphMapKey];
    const blendState = this.blendState[morphMapKey];
    const excluded = CONTROL_MORPHS[morphMapKey];

    for (const morphName in morphMap) {
      // Skip morphs owned by other systems (blink, lipsync). Iterating them
      // would silently overwrite the owner's per-frame influence write.
      if (excluded && excluded.has(morphName)) continue;

      const targetValue = targetState[morphName] ?? 0;
      const currentValue = blendState[morphName] ?? 0;

      // Lerp toward target
      const newValue =
        currentValue + (targetValue - currentValue) * this.lerpSpeed;
      blendState[morphName] = Math.max(0, Math.min(1, newValue));

      // Apply to morphtarget
      const morphTarget = morphMap[morphName];
      if (morphTarget) {
        morphTarget.influence = blendState[morphName];
      }
    }
  }

  /**
   * Set lerp speed (interpolation speed)
   */
  setLerpSpeed(speed) {
    this.lerpSpeed = speed;
  }

  /**
   * Reset all morphs to neutral
   */
  reset() {
    this.setExpression("neutral");
  }

  /**
   * Instantly apply current expression (no lerp)
   */
  applyImmediate() {
    const expr =
      this.expressions[this.currentEmotion] || this.expressions.neutral;
    if (!expr) return;

    for (const morphMapKey in this.morphMaps) {
      const morphMap = this.morphMaps[morphMapKey];
      const exprMorphs = expr[morphMapKey] || {};

      for (const morphName in morphMap) {
        const value = exprMorphs[morphName] ?? 0;
        const morphTarget = morphMap[morphName];
        if (morphTarget) {
          morphTarget.influence = value;
        }
        this.blendState[morphMapKey][morphName] = value;
      }
    }
  }

  /**
   * Get available emotions
   */
  getAvailableEmotions() {
    return Object.keys(this.expressions);
  }

  /**
   * Cleanup
   */
  dispose() {
    this.expressionState = null;
    this.blendState = null;
  }
}

export default ExpressionManager;
