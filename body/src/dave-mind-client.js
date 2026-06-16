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
    // Exponential backoff state — shared across all method types. When the
    // backend 429s (rate limit) or 5xxs (real error), block further requests
    // for an exponentially increasing window so the polling idle/browse loops
    // don't hammer a failing endpoint at full rate.
    this._consecutiveFailures = 0;
    this._backoffUntil = 0;
    this._BACKOFF_MIN_MS = 1000;
    this._BACKOFF_MAX_MS = 60000;
  }

  /**
   * Fetch a Wikipedia article for Dave to read. With no args, picks a
   * random article (session start). With { title }, fetches that specific
   * article — used when Dave follows a link picked via browseChoose().
   *
   * Returns { pageTitle, reason, postContent, articleTitle, links, response }
   * — `links` is the list of outbound article titles for the next hop.
   */
  async browse({ title } = {}) {
    const body = {
      type: "browse",
      sessionId: this.sessionId,
      userId: this.userId,
    };
    if (title) body.title = title;
    const data = await this._post(body);
    return {
      pageTitle: data.pageTitle || "Unknown Page",
      articleTitle: data.articleTitle || "",
      reason: data.reason || "",
      postContent: data.postContent || "",
      links: Array.isArray(data.links) ? data.links : [],
      response: data.response || {},
    };
  }

  /**
   * Ask the backend to pick which outbound link Dave clicks next, given his
   * current mood, the time of day, and the articles he's already read this
   * session. Returns { choiceIndex, chosenTitle, reason, response } —
   * chosenTitle is null if Dave declines all the options.
   */
  async browseChoose({ links, mood, hour, history } = {}) {
    const data = await this._post({
      type: "browse_choose",
      sessionId: this.sessionId,
      userId: this.userId,
      links: Array.isArray(links) ? links : [],
      mood: mood || "neutral",
      hour: hour ?? new Date().getHours(),
      history: Array.isArray(history) ? history : [],
    });
    return {
      choiceIndex: data.choiceIndex ?? null,
      chosenTitle: data.chosenTitle || null,
      reason: data.reason || "",
      response: data.response || {},
    };
  }

  /**
   * Watch a short video on the TV
   * Returns videoUrl (or null if Pexels isn't configured) and an optional reaction
   */
  async watchTv() {
    const data = await this._post({
      type: "watchtv",
      sessionId: this.sessionId,
      userId: this.userId,
    });
    return {
      pageTitle: data.pageTitle || "tv",
      videoUrl: data.videoUrl || null,
      response: data.response || null,
    };
  }

  /**
   * Generate a response to user input
   * @param {string} userInput - The user's message
   * @param {Array} history - Recent turns [{role:"user"|"assistant", content:"..."}]
   * @returns {object} Response object with emotion, text, speechRate, speechPauseMs
   */
  async respond(userInput, history = []) {
    const data = await this._post({
      type: "respond",
      sessionId: this.sessionId,
      userId: this.userId,
      userInput: userInput,
      history,
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

  async browseUrl(url) {
    const data = await this._post({
      type: "browse_url",
      url,
      sessionId: this.sessionId,
      userId: this.userId,
    });
    return {
      pageTitle: data.pageTitle || url,
      postContent: data.postContent || "",
      response: data.response || {},
    };
  }

  async analyzeMedia(imageData, mediaType = "image") {
    const data = await this._post({
      type: "analyze_media",
      imageData,
      mediaType,
      sessionId: this.sessionId,
      userId: this.userId,
    });
    return { response: data.response || null };
  }

  /**
   * Internal: Send a POST request to the backend with exponential backoff.
   * @private
   */
  async _post(body) {
    const now = Date.now();
    if (now < this._backoffUntil) {
      const waitMs = this._backoffUntil - now;
      throw new Error(`API backoff: retry in ${waitMs}ms`);
    }

    let res;
    try {
      res = await fetch(this.queryUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (networkErr) {
      // Network-level failure (DNS, offline, CORS preflight reject). Same
      // treatment as a 5xx — back off so we don't hammer.
      this._bumpBackoff();
      throw networkErr;
    }

    if (res.ok) {
      this._consecutiveFailures = 0;
      this._backoffUntil = 0;
      return await res.json();
    }

    // Back off on rate limits and server errors. Don't back off on 4xx-other
    // (those are caller bugs and won't get better by waiting).
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = res.headers.get("Retry-After");
      const retryAfterMs =
        retryAfter && !isNaN(parseFloat(retryAfter))
          ? parseFloat(retryAfter) * 1000
          : null;
      this._bumpBackoff(retryAfterMs);
    }

    const errorBody = await res.text();
    console.error(`API error ${res.status}: ${errorBody}`);
    throw new Error(`API error ${res.status}: ${errorBody}`);
  }

  /**
   * Compute the next backoff window. Doubles each consecutive failure up to
   * BACKOFF_MAX_MS. A non-null explicitMs (from a Retry-After header) wins.
   * @private
   */
  _bumpBackoff(explicitMs = null) {
    this._consecutiveFailures += 1;
    const exp = Math.min(
      this._BACKOFF_MAX_MS,
      this._BACKOFF_MIN_MS * 2 ** (this._consecutiveFailures - 1),
    );
    const delay = explicitMs && explicitMs > 0 ? explicitMs : exp;
    this._backoffUntil = Date.now() + delay;
  }

  /**
   * Log API interaction for debugging
   */
  static logInteraction(type, data) {
    console.log(`[api:${type}]`, data);
  }
}

export default DaveMindClient;
