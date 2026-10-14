function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);

  try {
    const vault = PropertiesService.getScriptProperties();
    const data = JSON.parse(e.postData.contents);
    const action = data.action;
    const room = data.room;

    if (!room) {
      return jsonOut({ status: "error", message: "Missing room hash" });
    }

    // 1. STORE ANY ENCRYPTED ENVELOPE (Future-Proof Schema-Agnostic)
    if (action === "store") {
      let raw = vault.getProperty(room);
      let queue = raw ? JSON.parse(raw) : [];

      queue.push(data.envelope);

      // Quota guard: Ensure single property stays safely under Google's 9KB limit
      while (JSON.stringify(queue).length > 8500 && queue.length > 1) {
        queue.shift();
      }

      vault.setProperty(room, JSON.stringify(queue));
      return jsonOut({ status: "stored", count: queue.length });
    }

    // 2. FETCH ALL & INSTANTLY SHRED
    if (action === "fetch_and_burn") {
      let raw = vault.getProperty(room);
      if (!raw) {
        return jsonOut({ status: "empty", envelopes: [] });
      }

      // Immediately shred from Google RAM before returning
      vault.deleteProperty(room);
      return jsonOut({ status: "burned", envelopes: JSON.parse(raw) });
    }

    // 3. MANUAL ROOM SHRED (Triggered by Dual Purge)
    if (action === "purge") {
      vault.deleteProperty(room);
      return jsonOut({ status: "purged" });
    }

    // 4. STORAGE HEALTH & CLEANUP
    if (action === "ping") {
      return jsonOut({ status: "online", timestamp: Date.now() });
    }

    return jsonOut({ status: "unknown_action" });
  } catch (err) {
    return jsonOut({ status: "error", message: err.toString() });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  return ContentService.createTextOutput("Universal Zero-Knowledge Vault Active.")
    .setMimeType(ContentService.MimeType.TEXT);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
