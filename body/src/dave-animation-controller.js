/**
 * Dave Animation Controller
 * Sophisticated system for playing animations forward/reverse with callbacks
 * Handles looping, frame events, speed ratios, and smooth transitions
 */

export class AnimationController {
  /**
   * Constructor
   * @param {BABYLON.Scene} scene - Babylon.js scene
   * @param {object} animationMap - Map of animation names to AnimationGroups
   * @param {object} config - Configuration with animation speeds
   */
  constructor(scene, animationMap, config = {}) {
    this.scene = scene;
    this.animationMap = animationMap;
    this.config = config;

    // Current animation state
    this.currentAnimation = null;
    this.currentAnimName = null;
    this.isLooping = false;
    this.isReversing = false;
    this.playbackSpeed = 1;

    // Frame callbacks
    this.frameCallbacks = []; // { frame: number, callback: fn, fired: bool }
    this.animationCompleteCallback = null;
    this.animationObserver = null;
  }

  /**
   * Play animation forward
   * @param {string} name - Animation name or BABYLON.AnimationGroup
   * @param {boolean} loop - Whether to loop
   * @param {number} speedRatio - Playback speed multiplier
   * @param {Function} onComplete - Callback when animation completes
   * @param {Object} frameCallbacks - Map of frame numbers to callbacks
   */
  playForward(
    name,
    loop = true,
    speedRatio = 1,
    onComplete = null,
    frameCallbacks = null,
  ) {
    const anim = typeof name === "string" ? this.animationMap[name] : name;
    if (!anim) {
      console.warn("Animation not found:", name);
      return;
    }

    // Stop previous animation
    this.stop();

    // Setup state
    this.currentAnimation = anim;
    this.currentAnimName = name;
    this.isLooping = loop;
    this.isReversing = false;
    this.playbackSpeed = speedRatio;
    this.animationCompleteCallback = onComplete;

    // Register frame callbacks AFTER stop() clears them
    if (frameCallbacks) {
      for (const [frame, callback] of Object.entries(frameCallbacks)) {
        this.onFrame(parseInt(frame), callback);
      }
    }

    // Play forward
    anim.speedRatio = speedRatio;
    anim.start(loop);

    // Setup completion observer
    if (!loop) {
      this._setupCompletionObserver();
    }
  }

  /**
   * Play animation in reverse from end to start
   * @param {string} name - Animation name
   * @param {number} speedRatio - Playback speed multiplier
   * @param {Function} onComplete - Callback when reverse completes
   * @param {Object} frameCallbacks - Map of frame numbers to callbacks
   */
  playReverse(name, speedRatio = 1, onComplete = null, frameCallbacks = null) {
    const anim = typeof name === "string" ? this.animationMap[name] : name;
    if (!anim) {
      console.warn("Animation not found:", name);
      return;
    }

    // Stop previous animation
    this.stop();

    // Setup state
    this.currentAnimation = anim;
    this.currentAnimName = name;
    this.isLooping = false;
    this.isReversing = true;
    this.playbackSpeed = speedRatio;
    this.animationCompleteCallback = onComplete;

    // Register frame callbacks AFTER stop() clears them
    if (frameCallbacks) {
      for (const [frame, callback] of Object.entries(frameCallbacks)) {
        this.onFrame(parseInt(frame), callback);
      }
    }

    // Start from end and play backwards
    anim.goToFrame(anim.to);
    anim.start(false, -speedRatio);

    // Setup completion observer
    this._setupCompletionObserver();
  }

  /**
   * Play animation and return a promise that resolves when complete
   * @param {string} name - Animation name
   * @param {boolean} loop - Whether to loop
   * @param {number} speedRatio - Playback speed
   * @param {Object} frameCallbacks - Frame callbacks to set up
   */
  playAsync(name, loop = false, speedRatio = 1, frameCallbacks = null) {
    return new Promise((resolve) => {
      this.playForward(name, loop, speedRatio, resolve, frameCallbacks);
    });
  }

  /**
   * Play animation in reverse and return a promise
   * @param {string} name - Animation name
   * @param {number} speedRatio - Playback speed
   * @param {Object} frameCallbacks - Frame callbacks to set up
   */
  playReverseAsync(name, speedRatio = 1, frameCallbacks = null) {
    return new Promise((resolve) => {
      this.playReverse(name, speedRatio, resolve, frameCallbacks);
    });
  }

  /**
   * Add a callback to fire at a specific frame
   * @param {number} frame - Frame number to trigger at
   * @param {Function} callback - Function to call
   */
  onFrame(frame, callback) {
    this.frameCallbacks.push({ frame, callback, fired: false });
  }

  /**
   * Seek to a specific frame without playing
   * @param {number} frame - Target frame
   */
  seekToFrame(frame) {
    if (this.currentAnimation) {
      this.currentAnimation.goToFrame(frame);
    }
  }

  /**
   * Get current frame of animation
   */
  getCurrentFrame() {
    if (!this.currentAnimation?.animatables?.[0]) {
      return this.isReversing
        ? (this.currentAnimation?.from ?? 0)
        : (this.currentAnimation?.to ?? 0);
    }
    return this.currentAnimation.animatables[0].masterFrame;
  }

  /**
   * Stop current animation
   * @param {boolean} jumpToEnd - Jump to end frame before stopping
   */
  stop(jumpToEnd = false) {
    if (!this.currentAnimation) return;

    const animName = this.currentAnimName;

    if (jumpToEnd && this.isReversing) {
      this.currentAnimation.goToFrame(this.currentAnimation.from);
    } else if (jumpToEnd) {
      this.currentAnimation.goToFrame(this.currentAnimation.to);
    }

    this.currentAnimation.stop();
    this._clearCompletionObserver();

    this.currentAnimation = null;
    this.currentAnimName = null;
    this.frameCallbacks = [];
  }

  /**
   * Pause current animation
   */
  pause() {
    if (this.currentAnimation) {
      this.currentAnimation.pause();
    }
  }

  /**
   * Resume paused animation
   */
  resume() {
    if (this.currentAnimation) {
      this.currentAnimation.start(this.isLooping);
    }
  }

  /**
   * Set playback speed
   */
  setSpeed(speedRatio) {
    this.playbackSpeed = speedRatio;
    if (this.currentAnimation) {
      this.currentAnimation.speedRatio = this.isReversing
        ? -speedRatio
        : speedRatio;
    }
  }

  /**
   * Check if specific animation is playing
   */
  isPlaying(name) {
    if (!this.currentAnimation) return false;
    if (typeof name === "string") {
      return this.currentAnimName === name;
    }
    return this.currentAnimation === name;
  }

  /**
   * Get duration in seconds
   */
  getDuration() {
    if (!this.currentAnimation) return 0;
    return (this.currentAnimation.to - this.currentAnimation.from) / 1000;
  }

  /**
   * Internal: Setup completion observer
   * @private
   */
  _setupCompletionObserver() {
    this._clearCompletionObserver();

    let frameStuckCounter = 0;
    let lastStuckFrame = -1;

    this.animationObserver = this.scene.onAfterAnimationsObservable.add(() => {
      if (!this.currentAnimation || !this.currentAnimation.animatables[0])
        return;

      const currentFrame = this.getCurrentFrame();

      // Check if frame is stuck (not advancing)
      if (Math.floor(currentFrame) === lastStuckFrame) {
        frameStuckCounter++;
        if (frameStuckCounter > 120) {
          // 2 seconds at 60fps
          if (this.animationCompleteCallback) {
            this.animationCompleteCallback();
          }
          this.stop();
          return;
        }
      } else {
        frameStuckCounter = 0;
        lastStuckFrame = Math.floor(currentFrame);
      }

      // Check frame callbacks
      for (const cb of this.frameCallbacks) {
        if (!cb.fired && this._frameMatches(currentFrame, cb.frame)) {
          cb.fired = true;
          cb.callback(currentFrame);
        }
      }

      // Check animation completion with tolerance
      const isReverse = this.isReversing;
      const tolerance = 5;

      let isComplete = false;
      if (isReverse) {
        // For reverse, we're going from anim.to DOWN to anim.from
        isComplete = currentFrame <= this.currentAnimation.from + tolerance;
      } else {
        // For forward, we're going from anim.from UP to anim.to
        isComplete = currentFrame >= this.currentAnimation.to - tolerance;
      }

      if (isComplete && !this.isLooping) {
        if (this.animationCompleteCallback) {
          this.animationCompleteCallback();
        }
        this.stop();
      }
    });
  }

  /**
   * Internal: Clear completion observer
   * @private
   */
  _clearCompletionObserver() {
    if (this.animationObserver) {
      this.scene.onAfterAnimationsObservable.remove(this.animationObserver);
      this.animationObserver = null;
    }
  }

  /**
   * Internal: Check if frame matches (with tolerance for playback speeds)
   * @private
   */
  _frameMatches(current, target, tolerance = 4) {
    return Math.abs(current - target) <= tolerance;
  }

  /**
   * Cleanup
   */
  dispose() {
    this.stop();
    this._clearCompletionObserver();
  }
}

export default AnimationController;
