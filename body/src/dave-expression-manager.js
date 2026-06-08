/**
 * Dave Expression Manager
 * Manages facial expressions through morphtarget interpolation
 * Supports smooth transitions between emotional states
 */

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
  }

  stopLipSync() {
    this.lipSyncActive = false;
    this.lipSyncTarget = 0;
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

    const char = this.speechText[this.speechCharIndex] || "";
    const nextChar = this.speechText[this.speechCharIndex + 1] || "";

    let mouthOpen = 0;

    if ("aæ".includes(char.toLowerCase())) {
      mouthOpen = 0.9;
    } else if ("eiouəɔ".includes(char.toLowerCase())) {
      mouthOpen = 0.75;
    } else if ("iɪy".includes(char.toLowerCase())) {
      mouthOpen = 0.65;
    } else if (["s", "S", "z", "Z", "f", "F", "v", "V"].includes(char)) {
      mouthOpen = 0.48;
    } else if (["b", "B", "p", "P", "m", "M"].includes(char)) {
      mouthOpen = 0.55;
    } else if (["t", "T", "d", "D", "n", "N", "l", "L"].includes(char)) {
      mouthOpen = 0.42;
    } else if (["k", "K", "g", "G", "w", "W", "j", "J"].includes(char)) {
      mouthOpen = 0.35;
    } else if (["h", "H", "r", "R"].includes(char)) {
      mouthOpen = 0.3;
    } else if (nextChar.match(/[bBcCdDfFgGhHjJkKlLmMnNpPrRsStTvVwWzZ]/)) {
      mouthOpen = Math.max(0.1, mouthOpen * 0.7);
    } else if (char === " " || !char) {
      mouthOpen = 0.08;
    } else {
      mouthOpen = 0.05;
    }

    const variation = Math.sin(this.speechCharIndex * 0.5) * 0.03;
    mouthOpen = Math.max(0.05, Math.min(1, mouthOpen + variation));

    this.lipSyncTarget = mouthOpen;
    // Apply directly to morph target, bypassing expression state so expression
    // changes don't clobber mouth-open each frame
    mouthMorph.influence =
      mouthMorph.influence +
      (mouthOpen - mouthMorph.influence) * Math.min(this.lerpSpeed * 8, 1);
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

    for (const morphName in morphMap) {
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
