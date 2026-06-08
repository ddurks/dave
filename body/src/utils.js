/**
 * Utility functions for D.A.V.E.
 */

/**
 * Centralized error handler for consistent error logging
 * @param {string} context - Context identifier (e.g., 'browse', 'speak', 'history')
 * @param {Error} error - The error object
 */
export function handleError(context, error) {
  const message = error?.message || String(error);
  console.error(`[${context}]`, message);
}

/**
 * Clamp a value between min and max
 * @param {number} v - Value to clamp
 * @param {number} min - Minimum bound
 * @param {number} max - Maximum bound
 * @returns {number} Clamped value
 */
export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Normalize an angle to the range [-π, π]
 * @param {number} angle - Angle in radians
 * @returns {number} Normalized angle
 */
export function normalizeAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

export default { handleError, clamp, normalizeAngle };
