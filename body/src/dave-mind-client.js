/**
 * D.A.V.E. Mind Client
 * Handles all backend API communication for Dave's behavioral queries
 */

export class DaveMindClient {
  constructor(apiBaseUrl, sessionId, userId) {
    this.apiBaseUrl = apiBaseUrl;
    this.queryUrl = `${apiBaseUrl}/query`;
    this.sessionId = sessionId;
    this.userId = userId;
  }

  /**
   * Browse the web while sitting at the computer
   * Returns page title, reason, and response
   */
  async browse() {
    const data = await this._post({
      type: "browse",
      sessionId: this.sessionId,
      userId: this.userId,
    });

    return {
      pageTitle: data.pageTitle || "Unknown Page",
      reason: data.reason || "",
      postContent: data.postContent || "",
      response: data.response || {},
    };
  }

  /**
   * Generate a response to user input
   * @param {string} userInput - The user's message
   * @returns {object} Response object with emotion, text, speechRate, speechPauseMs
   */
  async respond(userInput) {
    const data = await this._post({
      type: "respond",
      sessionId: this.sessionId,
      userId: this.userId,
      userInput: userInput,
    });

    return data.response || {};
  }

  /**
   * Trigger an autonomous musing
   * @param {string} contextStr - Optional context for the musing
   * @returns {object} Object with prompt and response
   */
  async muse(contextStr = "") {
    const data = await this._post({
      type: "muse",
      sessionId: this.sessionId,
      userId: this.userId,
      ...(contextStr && { context: contextStr }),
    });

    return {
      prompt: data.prompt || "",
      response: data.response || {},
    };
  }

  /**
   * Get an idle directive for autonomous behavior
   * @param {object} [context] - Optional context about Dave's recent activity
   * @param {string} [context.lastAction] - What Dave just finished doing
   * @param {number} [context.minutesAlone] - Minutes since last user interaction
   * @returns {object} Directive object with action, target, emotion, etc.
   */
  async idle(context = {}) {
    const data = await this._post({
      type: "idle",
      sessionId: this.sessionId,
      userId: this.userId,
      ...context,
    });

    return data.directive || {};
  }

  /**
   * Internal: Send a POST request to the backend
   * @private
   */
  async _post(body) {
    const res = await fetch(this.queryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`API error ${res.status}: ${errorBody}`);
      throw new Error(`API error ${res.status}: ${errorBody}`);
    }

    return await res.json();
  }

  /**
   * Log API interaction for debugging
   */
  static logInteraction(type, data) {
    console.log(`[api:${type}]`, data);
  }
}

export default DaveMindClient;
