(() => {
  "use strict";

  const NAMESPACE = "urn:x-cast:com.jwein.mosaic.multiview.v1";
  const shell = document.getElementById("multiview");
  const grid = document.getElementById("slot-grid");
  const records = new Map();
  const LAYOUTS = new Set(["auto", "grid", "heroLeft", "heroTop", "quad"]);
  const GAP = 0.012;
  const ATTACH_STAGGER_MS = 900;
  const FOCUSED_MAX_HEIGHT = 720;
  const FOCUSED_MAX_BITRATE = 3600000;
  const FOUR_UP_FOCUSED_MAX_HEIGHT = 360;
  const FOUR_UP_FOCUSED_MAX_BITRATE = 1400000;
  const SECONDARY_MAX_HEIGHT = 360;
  const SECONDARY_MAX_BITRATE = 1000000;
  const FOUR_UP_SECONDARY_MAX_HEIGHT = 234;
  const FOUR_UP_SECONDARY_MAX_BITRATE = 500000;
  const DENSE_SECONDARY_MAX_HEIGHT = 234;
  const DENSE_SECONDARY_MAX_BITRATE = 420000;
  let currentSessionId = null;
  let latestSequence = 0;

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

  function setIdle() {
    currentSessionId = null;
    latestSequence = 0;
    shell.dataset.mode = "idle";
    shell.dataset.count = "0";
    shell.dataset.layout = "auto";
    for (const record of records.values()) {
      destroyRecord(record);
    }
    records.clear();
    grid.replaceChildren();
  }

  function normalizeLayout(layout, count) {
    const value = typeof layout === "string" && LAYOUTS.has(layout) ? layout : "auto";
    if (value === "quad" && count > 4) return "grid";
    if ((value === "heroLeft" || value === "heroTop") && count < 2) return "auto";
    return value;
  }

  function setMultiviewMode(count, layout) {
    const clampedCount = Math.max(0, Math.min(9, count));
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
    if (record.hls) {
      record.hls.destroy();
      record.hls = null;
    }
    record.video.pause();
    record.video.removeAttribute("src");
    record.video.load();
    record.url = null;
    record.policyKey = null;
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

    return {
      id: slot.id,
      element,
      video,
      error,
      hls: null,
      url: null,
      attachTimer: null,
      policyKey: null,
    };
  }

  function qualityPolicy(slot, board, frame, index, count) {
    const focused = slot.id === board.focusedSlotId;
    const dense = count >= 7;
    const fourUp = count >= 4;
    const relaxed = count <= 2;
    const maxHeight = focused
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
    const maxBitrate = focused
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
    return {
      focused,
      maxHeight,
      maxBitrate,
      attachDelayMs: Math.max(0, index) * ATTACH_STAGGER_MS,
      key: `${focused ? "focused" : "secondary"}:${maxHeight}:${maxBitrate}:${Math.round(frame.width * 100)}x${Math.round(frame.height * 100)}`,
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
    record.hls.autoLevelCapping = cap;
    if (record.hls.currentLevel > cap) {
      record.hls.nextLevel = cap;
    }
    if (record.hls.loadLevel > cap) {
      record.hls.loadLevel = cap;
    }
  }

  function playRecord(record) {
    record.video.play().catch(() => {
      record.element.dataset.error = "true";
    });
  }

  function startStream(record, url, policy) {
    if (record.url !== url) return;
    record.element.dataset.error = "false";

    if (record.video.canPlayType("application/vnd.apple.mpegurl")) {
      record.video.src = url;
      playRecord(record);
    } else if (window.Hls && window.Hls.isSupported()) {
      record.hls = new window.Hls({
        liveSyncDurationCount: policy.focused ? 5 : 6,
        maxLiveSyncPlaybackRate: 1,
        capLevelToPlayerSize: true,
        lowLatencyMode: false,
        enableWorker: true,
        startLevel: 0,
        maxBufferLength: policy.focused ? 12 : 7,
        maxMaxBufferLength: policy.focused ? 16 : 10,
        maxBufferSize: policy.focused ? 14000000 : 7000000,
        backBufferLength: 0,
        abrEwmaFastLive: 2,
        abrEwmaSlowLive: 5,
      });
      record.hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        applyQualityPolicy(record, policy);
        playRecord(record);
      });
      record.hls.on(window.Hls.Events.ERROR, (_event, data) => {
        if (data && data.fatal) {
          record.element.dataset.error = "true";
          if (record.hls) record.hls.destroy();
          record.hls = null;
          record.url = null;
        }
      });
      record.hls.loadSource(url);
      record.hls.attachMedia(record.video);
    } else {
      record.video.src = url;
      playRecord(record);
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
    if (record.attachTimer) {
      window.clearTimeout(record.attachTimer);
      record.attachTimer = null;
    }
    if (record.hls) {
      record.hls.destroy();
      record.hls = null;
    }
    record.video.pause();
    record.video.removeAttribute("src");
    record.video.load();
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

    currentSessionId = board.sessionId;
    const slots = board.slots.filter((slot) => slot.id && slot.hlsUrl).slice(0, 9);
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
    setIdle();
    return request;
  });

  context.addCustomMessageListener(NAMESPACE, handleEnvelope);
  context.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, (event) => {
    send(event.senderId, nowMessage("ready", { sessionId: currentSessionId }));
  });
  context.start({ disableIdleTimeout: true });
})();
