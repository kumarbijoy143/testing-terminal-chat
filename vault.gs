/**
 * Private message vault, version 2 (Google Apps Script)
 *
 * - Each message is stored as its own entry (no shared queue, no silent drops).
 * - Listing does NOT delete. The app deletes a message only after it has
 *   received it, so nothing is lost if the app crashes or loses signal.
 * - Messages expire automatically after the retention time the app asks for
 *   (1 to 30 days, default 7).
 * - Each message records who sent it, so a phone never gets its own messages back.
 * - All message content is encrypted by the app. This script never sees plain text.
 */

const PREFIX = "m:";
const DEFAULT_TTL_DAYS = 7;
const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 30;
const MAX_PER_ROOM = 300;
const MAX_ENVELOPE_CHARS = 8000;
const MAX_LIST = 100;
const MAX_DELETE = 100;

function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return out({ status: "error", code: "busy" });
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return out({ status: "error", code: "empty_request" });
    }

    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    if (action === "ping") {
      return out({ status: "online", version: 2, time: Date.now() });
    }

    const room = clean(data.room);
    if (!room) {
      return out({ status: "error", code: "missing_room" });
    }

    const props = PropertiesService.getScriptProperties();
    sweepExpired(props);

    if (action === "store") return storeMessage(props, room, data);
    if (action === "list") return listMessages(props, room, data);
    if (action === "delete") return deleteMessages(props, room, data);
    if (action === "purge") return purgeRoom(props, room);

    return out({ status: "error", code: "unknown_action" });
  } catch (err) {
    return out({ status: "error", code: "exception", message: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return ContentService.createTextOutput("Private vault v2 active.")
    .setMimeType(ContentService.MimeType.TEXT);
}

// ---------------------------------------------------------------
// Actions
// ---------------------------------------------------------------

function storeMessage(props, room, data) {
  const msgId = clean(data.msgId);
  const from = clean(data.from);
  const envelope = typeof data.envelope === "string" ? data.envelope : "";

  if (!msgId || !from || !envelope) {
    return out({ status: "error", code: "bad_message" });
  }
  if (envelope.length > MAX_ENVELOPE_CHARS) {
    return out({ status: "error", code: "too_large" });
  }

  const key = PREFIX + room + ":" + msgId;
  const alreadyThere = props.getProperty(key) !== null;

  if (!alreadyThere && countRoom(props, room) >= MAX_PER_ROOM) {
    return out({ status: "error", code: "room_full" });
  }

  const ttlDays = clampTtl(data.ttlDays);
  const now = Date.now();
  const record = {
    f: from,
    e: envelope,
    c: now,
    x: now + ttlDays * 24 * 60 * 60 * 1000
  };

  try {
    props.setProperty(key, JSON.stringify(record));
  } catch (err) {
    return out({ status: "error", code: "storage_full" });
  }

  return out({ status: "stored", duplicate: alreadyThere });
}

function listMessages(props, room, data) {
  const exclude = clean(data.exclude);
  const all = props.getProperties();
  const prefix = PREFIX + room + ":";
  const found = [];

  Object.keys(all).forEach(function (key) {
    if (key.indexOf(prefix) !== 0) return;
    try {
      const rec = JSON.parse(all[key]);
      if (exclude && rec.f === exclude) return;
      found.push({
        id: key.substring(prefix.length),
        envelope: rec.e,
        sentAt: rec.c
      });
    } catch (err) {
      props.deleteProperty(key);
    }
  });

  found.sort(function (a, b) { return a.sentAt - b.sentAt; });

  return out({
    status: "ok",
    messages: found.slice(0, MAX_LIST),
    more: found.length > MAX_LIST
  });
}

function deleteMessages(props, room, data) {
  const ids = Array.isArray(data.ids) ? data.ids.slice(0, MAX_DELETE) : [];
  let deleted = 0;

  ids.forEach(function (rawId) {
    const id = clean(rawId);
    if (!id) return;
    const key = PREFIX + room + ":" + id;
    if (props.getProperty(key) !== null) {
      props.deleteProperty(key);
      deleted++;
    }
  });

  return out({ status: "deleted", count: deleted });
}

function purgeRoom(props, room) {
  const all = props.getProperties();
  const prefix = PREFIX + room + ":";
  let removed = 0;

  Object.keys(all).forEach(function (key) {
    if (key.indexOf(prefix) === 0) {
      props.deleteProperty(key);
      removed++;
    }
  });

  return out({ status: "purged", count: removed });
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function sweepExpired(props) {
  const all = props.getProperties();
  const now = Date.now();

  Object.keys(all).forEach(function (key) {
    if (key.indexOf(PREFIX) !== 0) return;
    try {
      const rec = JSON.parse(all[key]);
      if (!rec.x || rec.x < now) props.deleteProperty(key);
    } catch (err) {
      props.deleteProperty(key);
    }
  });
}

function countRoom(props, room) {
  const prefix = PREFIX + room + ":";
  const keys = Object.keys(props.getProperties());
  let n = 0;
  keys.forEach(function (key) {
    if (key.indexOf(prefix) === 0) n++;
  });
  return n;
}

function clampTtl(value) {
  const n = parseInt(value, 10);
  if (isNaN(n)) return DEFAULT_TTL_DAYS;
  return Math.min(MAX_TTL_DAYS, Math.max(MIN_TTL_DAYS, n));
}

// Only letters, digits, underscore and dash, up to 64 characters.
function clean(value) {
  if (typeof value !== "string") return "";
  return /^[A-Za-z0-9_\-]{1,64}$/.test(value) ? value : "";
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Optional: run this ONCE by hand (Run button) to delete the old-format
 * queues left over from the first version of the vault.
 */
function cleanupOldQueues() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(PREFIX) !== 0) props.deleteProperty(key);
  });
}
