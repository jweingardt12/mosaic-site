(() => {
  "use strict";

  const NAMESPACE = "urn:x-cast:com.jwein.mosaic.multiview.v1";
  const shell = document.getElementById("multiview");
  const grid = document.getElementById("slot-grid");
  const records = new Map();
  const LAYOUTS = new Set(["auto", "grid", "heroLeft", "heroTop", "quad"]);
  const GAP = 0.012;
  const ATTACH_STAGGER_MS = 1200;
  const LIVE_EDGE_OFFSET_SECONDS = 3;
  const LIVE_EDGE_JOIN_ATTEMPTS = 8;
  const LIVE_EDGE_JOIN_RETRY_MS = 500;
  const FOCUSED_MAX_HEIGHT = 540;
  const FOCUSED_MAX_BITRATE = 2200000;
  const FOUR_UP_FOCUSED_MAX_HEIGHT = 360;
  const FOUR_UP_FOCUSED_MAX_BITRATE = 900000;
  const SECONDARY_MAX_HEIGHT = 270;
  const SECONDARY_MAX_BITRATE = 550000;
  const FOUR_UP_SECONDARY_MAX_HEIGHT = 180;
  const FOUR_UP_SECONDARY_MAX_BITRATE = 280000;
  const DENSE_SECONDARY_MAX_HEIGHT = 180;
  const DENSE_SECONDARY_MAX_BITRATE = 220000;
  const MAX_TILES = 2;
  const TILE_RETRY_LIMIT = 2;
  const TILE_RETRY_BACKOFF_MS = [1000, 2000];

  // --- Playback-health monitor tuning ---
  // These thresholds are first-pass guesses and NEED real-device tuning on a
  // physical Chromecast against live MLB streams (Chrome Remote Debugger →
  // getVideoPlaybackQuality / waiting events). Treat them as starting points.
  const HEALTH_SAMPLE_INTERVAL_MS = 4000;          // how often we sample tile health
  const HEALTH_WINDOW_SAMPLES = 3;                 // rolling judgement window (~12s)
  const HEALTH_DROPPED_FRAME_RATIO = 0.2;          // sum(droppedDelta)/sum(totalDelta) over window
  const HEALTH_STALL_PER_TILE = 2;                 // stall budget per tile across the window
  const HEALTH_DOWNGRADE_COOLDOWN_MS = 20000;      // min gap between downgrade recommendations

  let currentSessionId = null;
  let latestSequence = 0;
  let lastSenderId = null;
  const connectedSenders = new Set();
  document.body.dataset.mode = "idle";

  function nowMessage(type, extra = {}) {
    return {
      type,
      receiverTimeMilliseconds: Date.now(),
      ...extra,
    };
  }

  function send(senderId, message) {
    if (!senderId) return;
    context.sendCustomMessage(NAMESPACE, senderId, message);
  }

  function parseData(data) {
    if (typeof data === "string") return JSON.parse(data);
    return data;
  }

  function resetMultiviewBoard() {
    currentSessionId = null;
    latestSequence = 0;
    shell.dataset.count = "0";
    shell.dataset.layout = "auto";
    for (const record of records.values()) {
      destroyRecord(record);
    }
    records.clear();
    grid.replaceChildren();
    healthWindow = [];
    lastDowngradeAt = 0;
  }

  function setIdle() {
    resetMultiviewBoard();
    document.body.dataset.mode = "idle";
    shell.dataset.mode = "idle";
  }

  function setSingleMediaMode() {
    resetMultiviewBoard();
    document.body.dataset.mode = "single";
    shell.dataset.mode = "single";
  }

  function normalizeLayout(layout, count) {
    const value = typeof layout === "string" && LAYOUTS.has(layout) ? layout : "auto";
    if (value === "quad" && count > 4) return "grid";
    if ((value === "heroLeft" || value === "heroTop") && count < 2) return "auto";
    return value;
  }

  function setMultiviewMode(count, layout) {
    const clampedCount = Math.max(0, Math.min(MAX_TILES, count));
    document.body.dataset.mode = "multiview";
    shell.dataset.mode = "multiview";
    shell.dataset.count = String(clampedCount);
    shell.dataset.layout = normalizeLayout(layout, clampedCount);
  }

  function rect(x, y, width, height) {
    return { x, y, width, height };
  }

  function equalGridFrames(count, columns, rows) {
    const safeColumns = Math.max(1, columns);
    const safeRows = Math.max(1, rows);
    const width = (1 - GAP * (safeColumns - 1)) / safeColumns;
    const height = (1 - GAP * (safeRows - 1)) / safeRows;
    return Array.from({ length: count }, (_value, index) => {
      const column = index % safeColumns;
      const row = Math.min(Math.floor(index / safeColumns), safeRows - 1);
      return rect(column * (width + GAP), row * (height + GAP), width, height);
    });
  }

  function mapAreaFrames(count, area, maxColumns, maxRows) {
    if (count <= 0) return [];
    let columns;
    let rows;
    if (maxColumns === 2) {
      columns = count <= 2 ? 1 : 2;
      rows = Math.min(maxRows, Math.ceil(count / columns));
    } else {
      columns = count <= maxColumns ? count : maxColumns;
      rows = Math.min(maxRows, Math.ceil(count / columns));
    }
    return equalGridFrames(count, columns, rows).map((frame) => rect(
      area.x + frame.x * area.width,
      area.y + frame.y * area.height,
      frame.width * area.width,
      frame.height * area.height
    ));
  }

  function heroLeftFrames(count, leftColumns = 2, rightColumns = 2) {
    if (count === 1) return [rect(0, 0, 1, 1)];
    const heroWidth = (1 - GAP) * leftColumns / (leftColumns + rightColumns);
    const rail = rect(heroWidth + GAP, 0, 1 - heroWidth - GAP, 1);
    return [
      rect(0, 0, heroWidth, 1),
      ...mapAreaFrames(count - 1, rail, 2, 4),
    ];
  }

  function heroTopFrames(count) {
    if (count === 1) return [rect(0, 0, 1, 1)];
    const heroHeight = (1 - GAP) / 2;
    const bottom = rect(0, heroHeight + GAP, 1, 1 - heroHeight - GAP);
    return [
      rect(0, 0, 1, heroHeight),
      ...mapAreaFrames(count - 1, bottom, 4, 2),
    ];
  }

  function gridFrames(count) {
    if (count === 1) return [rect(0, 0, 1, 1)];
    if (count === 2) return equalGridFrames(count, 2, 1);
    if (count <= 4) return equalGridFrames(count, 2, 2);
    return equalGridFrames(count, 3, 3);
  }

  function autoFrames(count) {
    if (count === 1) return [rect(0, 0, 1, 1)];
    if (count === 2) return equalGridFrames(count, 2, 1);
    if (count === 3) return heroLeftFrames(count, 1.35, 1);
    if (count === 4) return equalGridFrames(count, 2, 2);
    if (count <= 6) {
      const cellWidth = (1 - GAP * 2) / 3;
      const cellHeight = (1 - GAP * 2) / 3;
      const frames = [rect(0, 0, cellWidth * 2 + GAP, cellHeight * 2 + GAP)];
      const placements = [
        { column: 2, row: 0 },
        { column: 2, row: 1 },
        { column: 0, row: 2 },
        { column: 1, row: 2 },
        { column: 2, row: 2 },
      ];
      for (let index = 1; index < count; index += 1) {
        const placement = placements[Math.min(index - 1, placements.length - 1)];
        frames.push(rect(
          placement.column * (cellWidth + GAP),
          placement.row * (cellHeight + GAP),
          cellWidth,
          cellHeight
        ));
      }
      return frames;
    }
    return equalGridFrames(count, 3, 3);
  }

  function layoutFrames(layout, count) {
    switch (normalizeLayout(layout, count)) {
      case "grid":
        return gridFrames(count);
      case "heroLeft":
        return heroLeftFrames(count);
      case "heroTop":
        return heroTopFrames(count);
      case "quad":
        return equalGridFrames(count, 2, 2);
      case "auto":
      default:
        return autoFrames(count);
    }
  }

  function applyFrame(element, frame) {
    element.style.left = `${frame.x * 100}%`;
    element.style.top = `${frame.y * 100}%`;
    element.style.width = `${frame.width * 100}%`;
    element.style.height = `${frame.height * 100}%`;
  }

  function destroyRecord(record) {
    if (record.attachTimer) {
      window.clearTimeout(record.attachTimer);
      record.attachTimer = null;
    }
    if (record.retryTimer) {
      window.clearTimeout(record.retryTimer);
      record.retryTimer = null;
    }
    if (record.hls) {
      record.hls.destroy();
      record.hls = null;
    }
    if (record.liveEdgeTimer) {
      window.clearTimeout(record.liveEdgeTimer);
      record.liveEdgeTimer = null;
    }
    record.video.pause();
    record.video.removeAttribute("src");
    record.video.load();
    record.url = null;
    record.didJoinLiveEdge = false;
    record.policyKey = null;
    record.retryCount = 0;
    record.stallCount = 0;
    record.prevDropped = 0;
    record.prevTotal = 0;
  }

  function createRecord(slot) {
    const element = document.createElement("article");
    element.className = "slot";
    element.dataset.slotId = slot.id;

    const video = document.createElement("video");
    video.autoplay = true;
    video.preload = "none";
    video.playsInline = true;
    video.controls = false;
    video.disablePictureInPicture = true;

    const error = document.createElement("div");
    error.className = "slot-error";
    error.textContent = "Unable to play this stream";

    element.append(video, error);
    grid.append(element);

    const record = {
      id: slot.id,
      element,
      video,
      error,
      hls: null,
      url: null,
      attachTimer: null,
      liveEdgeTimer: null,
      didJoinLiveEdge: false,
      policyKey: null,
      retryCount: 0,
      retryTimer: null,
      stallCount: 0,
      prevDropped: 0,
      prevTotal: 0,
    };

    // Count stalls for the health monitor. A `waiting` event fires whenever the
    // element runs out of buffered data and has to re-buffer.
    video.addEventListener("waiting", () => {
      record.stallCount += 1;
    });

    return record;
  }

  function qualityPolicy(slot, board, frame, index, count) {
    const focused = slot.id === board.focusedSlotId;
    const dense = count >= 5;
    const fourUp = count >= 4;
    const relaxed = count <= 2;
    const roleHeight = focused
      ? fourUp
        ? FOUR_UP_FOCUSED_MAX_HEIGHT
        : FOCUSED_MAX_HEIGHT
      : dense
        ? DENSE_SECONDARY_MAX_HEIGHT
        : fourUp
          ? FOUR_UP_SECONDARY_MAX_HEIGHT
        : relaxed
          ? 540
          : SECONDARY_MAX_HEIGHT;
    const roleBitrate = focused
      ? fourUp
        ? FOUR_UP_FOCUSED_MAX_BITRATE
        : FOCUSED_MAX_BITRATE
      : dense
        ? DENSE_SECONDARY_MAX_BITRATE
        : fourUp
          ? FOUR_UP_SECONDARY_MAX_BITRATE
        : relaxed
          ? 2200000
          : SECONDARY_MAX_BITRATE;

    // Serialized per-tile hints from the sender clamp the role-based ceiling
    // downward — they can only tighten the cap, never relax it.
    const hintHeight = typeof slot.maxHeight === "number" && slot.maxHeight > 0 ? slot.maxHeight : 0;
    const hintBitrate = typeof slot.maxBitrateKbps === "number" && slot.maxBitrateKbps > 0
      ? slot.maxBitrateKbps * 1000
      : 0;
    const maxHeight = hintHeight ? Math.min(roleHeight, hintHeight) : roleHeight;
    const maxBitrate = hintBitrate ? Math.min(roleBitrate, hintBitrate) : roleBitrate;

    return {
      focused,
      maxHeight,
      maxBitrate,
      attachDelayMs: Math.max(0, index) * ATTACH_STAGGER_MS,
      key: `${focused ? "focused" : "secondary"}:${maxHeight}:${maxBitrate}:${hintHeight}:${hintBitrate}:${Math.round(frame.width * 100)}x${Math.round(frame.height * 100)}`,
    };
  }

  function cappedLevelFor(hls, policy) {
    const levels = Array.isArray(hls.levels) ? hls.levels : [];
    if (!levels.length) return -1;

    let best = -1;
    for (let index = 0; index < levels.length; index += 1) {
      const level = levels[index];
      const height = Number(level.height || 0);
      const bitrate = Number(level.bitrate || level.attrs?.BANDWIDTH || 0);
      const heightOK = height <= 0 || height <= policy.maxHeight;
      const bitrateOK = bitrate <= 0 || bitrate <= policy.maxBitrate;
      if (heightOK && bitrateOK) best = index;
    }
    return best >= 0 ? best : 0;
  }

  function applyQualityPolicy(record, policy) {
    record.policyKey = policy.key;
    if (!record.hls) return;

    const cap = cappedLevelFor(record.hls, policy);
    if (cap < 0) return;
    // Multiview tiles must NOT run ABR. With up to 4 concurrent decodes on a
    // single-pipeline Cast / Android TV device, per-tile ABR probing churns the
    // decoder (each level switch flushes + re-inits) and the tiles fight over
    // bandwidth — both surface as stutter. Pin each tile to a fixed rendition at
    // its role cap and hold it (no auto level switching).
    record.hls.autoLevelCapping = cap;
    if (record.hls.currentLevel !== cap) {
      record.hls.currentLevel = cap;
    }
  }

  function seekToLiveEdge(record) {
    const ranges = record.video.seekable;
    if (!ranges || ranges.length <= 0) return false;
    const index = ranges.length - 1;
    const start = ranges.start(index);
    const end = ranges.end(index);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;

    const target = Math.max(start, end - LIVE_EDGE_OFFSET_SECONDS);
    if (Number.isFinite(target) && Math.abs(record.video.currentTime - target) > 1.5) {
      record.video.currentTime = target;
    }
    return true;
  }

  function scheduleLiveEdgeJoin(record, attempts = LIVE_EDGE_JOIN_ATTEMPTS) {
    if (record.didJoinLiveEdge) return;
    if (record.liveEdgeTimer) {
      window.clearTimeout(record.liveEdgeTimer);
      record.liveEdgeTimer = null;
    }

    const url = record.url;
    const attempt = (remaining) => {
      if (record.url !== url) return;
      if (seekToLiveEdge(record)) {
        record.didJoinLiveEdge = true;
        return;
      }
      if (remaining <= 1) return;
      record.liveEdgeTimer = window.setTimeout(() => {
        record.liveEdgeTimer = null;
        attempt(remaining - 1);
      }, LIVE_EDGE_JOIN_RETRY_MS);
    };

    attempt(attempts);
  }

  function playRecord(record) {
    scheduleLiveEdgeJoin(record);
    record.video.play()
      .then(() => scheduleLiveEdgeJoin(record, 3))
      .catch(() => {
        record.element.dataset.error = "true";
      });
  }

  function startStream(record, url, policy) {
    if (record.url !== url) return;
    record.element.dataset.error = "false";

    // Force hls.js when supported so the per-tile quality cap (applyQualityPolicy)
    // always binds — the native HLS path can't be capped, so it would leak full
    // bitrate. Chromium-based Cast WebViews support hls.js, so this is the
    // common path; the native src path is now only a fallback.
    if (window.Hls && window.Hls.isSupported()) {
      record.hls = new window.Hls({
        // Sit further behind live and tolerate a tile drifting back, so a
        // decode-bound tile coasts smoothly instead of hard-seeking to live
        // (the seek is itself a visible stutter). Cast latency is invisible
        // here — nothing syncs the receiver to a broadcast clock.
        liveSyncDurationCount: policy.focused ? 4 : 6,
        liveMaxLatencyDurationCount: policy.focused ? 12 : 15,
        maxLiveSyncPlaybackRate: 1,
        capLevelToPlayerSize: true,
        lowLatencyMode: false,
        enableWorker: true,
        startLevel: 0,
        startPosition: -1,
        maxBufferLength: policy.focused ? 8 : 4,
        maxMaxBufferLength: policy.focused ? 10 : 6,
        maxBufferSize: policy.focused ? 9000000 : 3500000,
        backBufferLength: 0,
        abrEwmaFastLive: 2,
        abrEwmaSlowLive: 5,
      });
      record.hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        applyQualityPolicy(record, policy);
        scheduleLiveEdgeJoin(record);
        playRecord(record);
      });
      record.hls.on(window.Hls.Events.LEVEL_LOADED, () => {
        scheduleLiveEdgeJoin(record, 4);
      });
      record.hls.on(window.Hls.Events.ERROR, (_event, data) => {
        if (data && data.fatal) {
          handleFatalHlsError(record, url, policy, data);
        }
      });
      record.hls.loadSource(url);
      record.hls.attachMedia(record.video);
    } else if (record.video.canPlayType("application/vnd.apple.mpegurl")) {
      record.video.addEventListener(
        "loadedmetadata",
        () => scheduleLiveEdgeJoin(record),
        { once: true }
      );
      record.video.src = url;
      playRecord(record);
    } else {
      record.video.src = url;
      playRecord(record);
    }
  }

  function hlsErrorDetail(data) {
    if (!data) return "unknown";
    return data.details || data.type || "fatal";
  }

  function handleFatalHlsError(record, url, policy, data) {
    // Guard against a teardown/replacement landing mid-error: only act if this
    // record is still bound to the same url we started with.
    if (record.url !== url) return;

    // Tear down the broken hls instance before any retry/blank.
    if (record.hls) {
      record.hls.destroy();
      record.hls = null;
    }
    if (record.retryTimer) {
      window.clearTimeout(record.retryTimer);
      record.retryTimer = null;
    }

    if (record.retryCount < TILE_RETRY_LIMIT) {
      const backoff = TILE_RETRY_BACKOFF_MS[Math.min(record.retryCount, TILE_RETRY_BACKOFF_MS.length - 1)];
      record.retryCount += 1;
      record.didJoinLiveEdge = false;
      record.retryTimer = window.setTimeout(() => {
        record.retryTimer = null;
        // The url may have been swapped out from under us while we waited.
        if (record.url !== url) return;
        startStream(record, url, policy);
      }, backoff);
      return;
    }

    // Retries exhausted: blank the tile and surface the failure to the sender.
    record.element.dataset.error = "true";
    record.url = null;
    if (lastSenderId) {
      send(lastSenderId, nowMessage("slotError", { slotId: record.id, reason: hlsErrorDetail(data) }));
    }
  }

  function attachStream(record, url, policy) {
    if (record.url === url) {
      if (record.policyKey !== policy.key) {
        applyQualityPolicy(record, policy);
      }
      return;
    }
    record.url = url;
    record.element.dataset.error = "false";
    record.retryCount = 0;
    if (record.attachTimer) {
      window.clearTimeout(record.attachTimer);
      record.attachTimer = null;
    }
    if (record.retryTimer) {
      window.clearTimeout(record.retryTimer);
      record.retryTimer = null;
    }
    if (record.liveEdgeTimer) {
      window.clearTimeout(record.liveEdgeTimer);
      record.liveEdgeTimer = null;
    }
    if (record.hls) {
      record.hls.destroy();
      record.hls = null;
    }
    record.video.pause();
    record.video.removeAttribute("src");
    record.video.load();
    record.didJoinLiveEdge = false;
    record.policyKey = policy.key;

    record.attachTimer = window.setTimeout(() => {
      record.attachTimer = null;
      startStream(record, url, policy);
    }, policy.attachDelayMs);
  }

  function updateRecord(record, slot, board, frame, index, count) {
    const focused = slot.id === board.focusedSlotId;
    record.element.dataset.focused = focused ? "true" : "false";
    record.video.muted = !focused || board.focusedAudioMuted;
    record.video.volume = focused && !board.focusedAudioMuted ? 1 : 0;
    attachStream(record, slot.hlsUrl, qualityPolicy(slot, board, frame, index, count));
  }

  function renderBoard(board) {
    if (!board || !Array.isArray(board.slots)) {
      throw new Error("Invalid multiview board.");
    }

    // A new multiview session invalidates the rolling health judgement —
    // tile set / layout changed, so prior frame/stall deltas no longer apply.
    if (board.sessionId !== currentSessionId) {
      resetHealthMonitor();
    }
    currentSessionId = board.sessionId;
    const slots = board.slots.filter((slot) => slot.id && slot.hlsUrl).slice(0, MAX_TILES);
    const layout = normalizeLayout(board.layout, slots.length);
    const frames = layoutFrames(layout, slots.length);
    setMultiviewMode(slots.length, layout);

    const liveIds = new Set(slots.map((slot) => slot.id));
    for (const [id, record] of records.entries()) {
      if (!liveIds.has(id)) {
        destroyRecord(record);
        record.element.remove();
        records.delete(id);
      }
    }

    for (const [index, slot] of slots.entries()) {
      let record = records.get(slot.id);
      if (!record) {
        record = createRecord(slot);
        records.set(slot.id, record);
      }
      applyFrame(record.element, frames[index]);
      updateRecord(record, slot, board, frames[index], index, slots.length);
      grid.append(record.element);
    }
  }

  // --- Playback-health monitor ------------------------------------------------
  // The receiver only RECOMMENDS a tile-count reduction; it never drops tiles
  // itself. The sender owns the board: on a `capability`/`fallbackToSingle`
  // message it decides whether to re-send a smaller board, and the receiver
  // keeps rendering whatever board it is given.
  let healthWindow = [];          // rolling array of per-sample aggregates
  let lastDowngradeAt = 0;        // Date.now() of the last downgrade recommendation

  function resetHealthMonitor() {
    healthWindow = [];
    lastDowngradeAt = 0;
    for (const record of records.values()) {
      record.stallCount = 0;
      record.prevDropped = 0;
      record.prevTotal = 0;
    }
  }

  function liveRecords() {
    const live = [];
    for (const record of records.values()) {
      if (record.url) live.push(record);
    }
    return live;
  }

  function sampleHealth() {
    if (document.body.dataset.mode !== "multiview") return;

    const live = liveRecords();
    if (live.length < 2) return;

    let droppedDelta = 0;
    let totalDelta = 0;
    let stallDelta = 0;
    let measured = 0;

    for (const record of live) {
      // Not all Cast platforms implement getVideoPlaybackQuality — feature-detect
      // and skip the frame stats gracefully if it's missing.
      if (typeof record.video.getVideoPlaybackQuality === "function") {
        const quality = record.video.getVideoPlaybackQuality();
        const dropped = Number(quality.droppedVideoFrames || 0);
        const total = Number(quality.totalVideoFrames || 0);
        droppedDelta += Math.max(0, dropped - record.prevDropped);
        totalDelta += Math.max(0, total - record.prevTotal);
        record.prevDropped = dropped;
        record.prevTotal = total;
        measured += 1;
      }
      stallDelta += record.stallCount;
      record.stallCount = 0;
    }

    healthWindow.push({ droppedDelta, totalDelta, stallDelta, tileCount: live.length, measured });
    if (healthWindow.length > HEALTH_WINDOW_SAMPLES) healthWindow.shift();
    if (healthWindow.length < HEALTH_WINDOW_SAMPLES) return;

    let windowDropped = 0;
    let windowTotal = 0;
    let windowStalls = 0;
    let maxTiles = 0;
    let anyMeasured = false;
    for (const sample of healthWindow) {
      windowDropped += sample.droppedDelta;
      windowTotal += sample.totalDelta;
      windowStalls += sample.stallDelta;
      maxTiles = Math.max(maxTiles, sample.tileCount);
      if (sample.measured > 0) anyMeasured = true;
    }

    const droppedRatio = anyMeasured && windowTotal > 0 ? windowDropped / windowTotal : 0;
    const stallOverload = windowStalls > maxTiles * HEALTH_STALL_PER_TILE;
    const frameOverload = droppedRatio > HEALTH_DROPPED_FRAME_RATIO;
    if (!stallOverload && !frameOverload) return;

    const now = Date.now();
    if (now - lastDowngradeAt < HEALTH_DOWNGRADE_COOLDOWN_MS) return;
    lastDowngradeAt = now;
    // Clear the window so we re-accumulate a fresh judgement after the step-down.
    healthWindow = [];

    if (!lastSenderId) return;
    const reason = "dropped_frames";
    if (maxTiles > 2) {
      send(lastSenderId, nowMessage("capability", { recommendedMaxTiles: 2, reason }));
    } else {
      send(lastSenderId, nowMessage("fallbackToSingle", { reason }));
    }
  }

  function isStaleEnvelope(envelope) {
    if (!envelope || typeof envelope.sequence !== "number") return false;
    if (currentSessionId && envelope.sessionId === currentSessionId && envelope.sequence < latestSequence) {
      return true;
    }
    latestSequence = envelope.sequence;
    return false;
  }

  function handleEnvelope(event) {
    const senderId = event.senderId;
    if (senderId) lastSenderId = senderId;
    try {
      const envelope = parseData(event.data);
      if (!envelope || envelope.schemaVersion !== 1) {
        throw new Error("Unsupported Mosaic multiview schema.");
      }
      if (isStaleEnvelope(envelope)) {
        send(senderId, nowMessage("ack", { sequence: envelope.sequence, stale: true }));
        return;
      }

      if (envelope.type === "stopBoard") {
        setIdle();
        send(senderId, nowMessage("ack", { sequence: envelope.sequence }));
        return;
      }

      if (envelope.type === "loadBoard" || envelope.type === "updateBoard") {
        try {
          playerManager.stop();
        } catch (_error) {
          // No active CAF media session; multiview owns playback from here.
        }
        renderBoard(envelope.board);
        send(senderId, nowMessage("ack", { sequence: envelope.sequence }));
        return;
      }

      throw new Error(`Unknown multiview message type: ${envelope.type}`);
    } catch (error) {
      send(senderId, nowMessage("error", { error: error.message || String(error) }));
    }
  }

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, (request) => {
    setSingleMediaMode();
    return request;
  });

  context.addCustomMessageListener(NAMESPACE, handleEnvelope);
  context.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, (event) => {
    if (event.senderId) {
      connectedSenders.add(event.senderId);
      lastSenderId = event.senderId;
    }
    send(event.senderId, nowMessage("ready", { sessionId: currentSessionId }));
  });
  context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, (event) => {
    if (event.senderId) connectedSenders.delete(event.senderId);
    if (lastSenderId === event.senderId) lastSenderId = null;
    // Idle timeout is disabled (multiview owns playback outside CAF's media
    // session), so the last sender leaving won't auto-tear-down. Do it
    // explicitly to avoid stranded decoders / orphaned video elements.
    if (connectedSenders.size === 0) {
      setIdle();
    }
  });

  // One health sampler for the lifetime of the receiver; it no-ops unless we're
  // in multiview mode with >=2 live tiles (see sampleHealth).
  window.setInterval(sampleHealth, HEALTH_SAMPLE_INTERVAL_MS);

  context.start({ disableIdleTimeout: true });
})();
