(() => {
  "use strict";

  const NAMESPACE = "urn:x-cast:com.jwein.mosaic.multiview.v1";
  const shell = document.getElementById("multiview");
  const grid = document.getElementById("slot-grid");
  const records = new Map();
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
    for (const record of records.values()) {
      destroyRecord(record);
    }
    records.clear();
    grid.replaceChildren();
  }

  function setMultiviewMode(count) {
    shell.dataset.mode = "multiview";
    shell.dataset.count = String(Math.max(0, Math.min(9, count)));
  }

  function destroyRecord(record) {
    if (record.hls) {
      record.hls.destroy();
      record.hls = null;
    }
    record.video.pause();
    record.video.removeAttribute("src");
    record.video.load();
  }

  function createRecord(slot) {
    const element = document.createElement("article");
    element.className = "slot";
    element.dataset.slotId = slot.id;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.controls = false;

    const chrome = document.createElement("div");
    chrome.className = "slot-chrome";

    const titleWrap = document.createElement("div");
    titleWrap.className = "slot-text";

    const title = document.createElement("div");
    title.className = "slot-title";

    const subtitle = document.createElement("div");
    subtitle.className = "slot-subtitle";

    const error = document.createElement("div");
    error.className = "slot-error";
    error.textContent = "Unable to play this stream";

    titleWrap.append(title, subtitle);
    chrome.append(titleWrap);
    element.append(video, chrome, error);
    grid.append(element);

    return {
      id: slot.id,
      element,
      video,
      title,
      subtitle,
      error,
      hls: null,
      url: null,
    };
  }

  function attachStream(record, url) {
    if (record.url === url) return;
    record.url = url;
    record.element.dataset.error = "false";
    if (record.hls) {
      record.hls.destroy();
      record.hls = null;
    }
    record.video.pause();
    record.video.removeAttribute("src");
    record.video.load();

    if (record.video.canPlayType("application/vnd.apple.mpegurl")) {
      record.video.src = url;
    } else if (window.Hls && window.Hls.isSupported()) {
      record.hls = new window.Hls({
        liveSyncDurationCount: 3,
        maxLiveSyncPlaybackRate: 1.5,
      });
      record.hls.on(window.Hls.Events.ERROR, (_event, data) => {
        if (data && data.fatal) {
          record.element.dataset.error = "true";
          if (record.hls) record.hls.destroy();
          record.hls = null;
        }
      });
      record.hls.loadSource(url);
      record.hls.attachMedia(record.video);
    } else {
      record.video.src = url;
    }

    record.video.play().catch(() => {
      record.element.dataset.error = "true";
    });
  }

  function updateRecord(record, slot, board) {
    const focused = slot.id === board.focusedSlotId;
    record.title.textContent = slot.title || "Live Feed";
    record.subtitle.textContent = slot.subtitle || "";
    record.element.dataset.focused = focused ? "true" : "false";
    record.video.muted = !focused || board.focusedAudioMuted;
    record.video.volume = focused && !board.focusedAudioMuted ? 1 : 0;
    attachStream(record, slot.hlsUrl);
  }

  function renderBoard(board) {
    if (!board || !Array.isArray(board.slots)) {
      throw new Error("Invalid multiview board.");
    }

    currentSessionId = board.sessionId;
    setMultiviewMode(board.slots.length);

    const liveIds = new Set(board.slots.map((slot) => slot.id));
    for (const [id, record] of records.entries()) {
      if (!liveIds.has(id)) {
        destroyRecord(record);
        record.element.remove();
        records.delete(id);
      }
    }

    for (const slot of board.slots) {
      if (!slot.id || !slot.hlsUrl) continue;
      let record = records.get(slot.id);
      if (!record) {
        record = createRecord(slot);
        records.set(slot.id, record);
      }
      updateRecord(record, slot, board);
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
