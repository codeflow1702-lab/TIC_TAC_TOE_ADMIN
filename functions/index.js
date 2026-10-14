const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

initializeApp();
const auth = getAuth();
const db = getFirestore();
const REGION = "us-central1";
const SETTINGS_PATH = "publicConfig/game";
const DEFAULT_SETTINGS = Object.freeze({
  quickMatchEnabled: true,
  privateRoomsEnabled: true,
  maintenanceMode: false,
  maintenanceMessage: "We'll be back shortly.",
  announcement: "",
  gameWebsiteUrl: ""
});
const ALLOWED_STATUSES = new Set(["waiting", "playing", "finished", "closed"]);

async function requireAdmin(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");

  const uid = request.auth.uid;
  const [userDoc, banDoc] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`bannedUsers/${uid}`).get()
  ]);

  if (banDoc.exists || !userDoc.exists || userDoc.data()?.role !== "admin") {
    throw new HttpsError("permission-denied", "Administrator access is required.");
  }
}
function validString(value, maxLength = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
function text(value, fallback = "") {
  return typeof value === "string" ? value.slice(0, 256) : fallback;
}
function serializeTime(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  return null;
}
function serializeRoom(snap) {
  const data = snap.data() || {};
  const player = value => value && typeof value === "object" ? {
    uid: text(value.uid),
    name: text(value.name, "Player")
  } : null;
  return {
    id: snap.id,
    mode: data.mode === "private" ? "private" : "quick",
    status: text(data.status, "unknown"),
    code: data.mode === "private" ? text(data.code) : "",
    players: { X: player(data.players?.X), O: player(data.players?.O) },
    turn: text(data.turn),
    winner: data.winner ?? null,
    createdAt: serializeTime(data.createdAt),
    updatedAt: serializeTime(data.updatedAt)
  };
}
function settingsShape(raw = {}) {
  return {
    quickMatchEnabled: typeof raw.quickMatchEnabled === "boolean" ? raw.quickMatchEnabled : DEFAULT_SETTINGS.quickMatchEnabled,
    privateRoomsEnabled: typeof raw.privateRoomsEnabled === "boolean" ? raw.privateRoomsEnabled : DEFAULT_SETTINGS.privateRoomsEnabled,
    maintenanceMode: typeof raw.maintenanceMode === "boolean" ? raw.maintenanceMode : DEFAULT_SETTINGS.maintenanceMode,
    maintenanceMessage: typeof raw.maintenanceMessage === "string" ? raw.maintenanceMessage.slice(0, 160) : DEFAULT_SETTINGS.maintenanceMessage,
    announcement: typeof raw.announcement === "string" ? raw.announcement.slice(0, 180) : DEFAULT_SETTINGS.announcement,
    gameWebsiteUrl: typeof raw.gameWebsiteUrl === "string" ? raw.gameWebsiteUrl.slice(0, 300) : DEFAULT_SETTINGS.gameWebsiteUrl
  };
}
function normalizeGameWebsiteUrl(value) {
  if (typeof value !== "string" || value.length > 300) throw new HttpsError("invalid-argument", "The game website URL must be 300 characters or fewer.");
  const raw = value.trim();
  if (!raw) return "";
  let url;
  try { url = new URL(raw); }
  catch { throw new HttpsError("invalid-argument", "Enter a complete website URL, including https://."); }
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(localHost && url.protocol === "http:"))) {
    throw new HttpsError("invalid-argument", "Use an HTTPS game website URL. HTTP is allowed only for localhost testing.");
  }
  if (url.search || url.hash) throw new HttpsError("invalid-argument", "Use the game website address without query parameters or a fragment.");
  return url.href;
}
async function getSettings() {
  const snap = await db.doc(SETTINGS_PATH).get();
  return settingsShape(snap.exists ? snap.data() : {});
}
async function countAuthUsers(cap = 5000) {
  let count = 0;
  let pageToken;
  do {
    const page = await auth.listUsers(Math.min(1000, cap - count), pageToken);
    count += page.users.length;
    pageToken = page.pageToken;
    if (!pageToken || count >= cap) break;
  } while (true);
  return { count, exact: !pageToken };
}
async function collectionCount(query) {
  const result = await query.count().get();
  return result.data().count;
}
async function recentRooms(limit = 10) {
  const snap = await db.collection("rooms").orderBy("updatedAt", "desc").limit(limit).get();
  return snap.docs.map(serializeRoom);
}
let roomHintsCache = null;
let roomHintsCacheAt = 0;
let roomHintsPromise = null;
async function recentRoomPlayerHints() {
  if (roomHintsCache && Date.now() - roomHintsCacheAt < 30000) return roomHintsCache;
  if (roomHintsPromise) return roomHintsPromise;
  roomHintsPromise = (async () => {
    const snap = await db.collection("rooms").orderBy("updatedAt", "desc").limit(1500).get();
    const names = new Map();
    const activity = new Map();
    for (const roomDoc of snap.docs) {
      const room = roomDoc.data() || {};
      const time = serializeTime(room.updatedAt || room.createdAt);
      for (const mark of ["X", "O"]) {
        const player = room.players?.[mark];
        if (!player?.uid || typeof player.uid !== "string") continue;
        if (!names.has(player.uid) && typeof player.name === "string" && player.name.trim()) names.set(player.uid, player.name.trim().slice(0, 18));
        if (!activity.has(player.uid) && time) activity.set(player.uid, time);
      }
    }
    roomHintsCache = { names, activity };
    roomHintsCacheAt = Date.now();
    return roomHintsCache;
  })();
  try { return await roomHintsPromise; }
  finally { roomHintsPromise = null; }
}

exports.adminDashboard = onCall({ region: REGION, timeoutSeconds: 60, memory: "512MiB" }, async request => {
  await requireAdmin(request);
  try {
    const rooms = db.collection("rooms");
    const [players, totalRooms, waiting, playing, finished, closed, latestRooms, settings] = await Promise.all([
      countAuthUsers(5000),
      collectionCount(rooms),
      collectionCount(rooms.where("status", "==", "waiting")),
      collectionCount(rooms.where("status", "==", "playing")),
      collectionCount(rooms.where("status", "==", "finished")),
      collectionCount(rooms.where("status", "==", "closed")),
      recentRooms(8),
      getSettings()
    ]);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    const activitySnap = await rooms.where("createdAt", ">=", Timestamp.fromDate(start)).orderBy("createdAt", "asc").limit(5000).get();
    const dayBins = new Map();
    for (let offset = 0; offset < 7; offset++) {
      const date = new Date(start); date.setDate(start.getDate() + offset);
      dayBins.set(date.toISOString().slice(0, 10), 0);
    }
    for (const doc of activitySnap.docs) {
      const at = doc.get("createdAt");
      if (!at?.toDate) continue;
      const key = at.toDate().toISOString().slice(0, 10);
      if (dayBins.has(key)) dayBins.set(key, dayBins.get(key) + 1);
    }
    const dailyActivity = [...dayBins.entries()].map(([date, count]) => ({
      date,
      label: new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`)),
      count
    }));
    return {
      counts: {
        players: players.count,
        playersLabel: `${players.count}${players.exact ? "" : "+"}`,
        playersExact: players.exact,
        totalRooms, waiting, playing, finished, closed,
        activeRooms: waiting + playing
      },
      dailyActivity,
      recentRooms: latestRooms,
      settings,
      meta: { totalRooms, activityRoomsIncluded: activitySnap.size }
    };
  } catch (error) {
    logger.error("adminDashboard failed", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Unable to load dashboard data.");
  }
});

exports.adminListPlayers = onCall({ region: REGION, timeoutSeconds: 60, memory: "512MiB" }, async request => {
  await requireAdmin(request);
  const pageToken = typeof request.data?.pageToken === "string" ? request.data.pageToken : undefined;
  try {
    const [page, hints] = await Promise.all([
      auth.listUsers(50, pageToken),
      recentRoomPlayerHints()
    ]);
    const bannedRefs = page.users.map(user => db.doc(`bannedUsers/${user.uid}`));
    const roleRefs = page.users.map(user => db.doc(`users/${user.uid}`));
    const [bannedSnaps, roleSnaps] = await Promise.all([
      bannedRefs.length ? db.getAll(...bannedRefs) : Promise.resolve([]),
      roleRefs.length ? db.getAll(...roleRefs) : Promise.resolve([])
    ]);
    const bannedMap = new Map(page.users.map((user, index) => [user.uid, bannedSnaps[index]?.exists ? bannedSnaps[index].data() : null]));
    const adminMap = new Map(page.users.map((user, index) => [user.uid, roleSnaps[index]?.exists && roleSnaps[index].data()?.role === "admin"]));
    return {
      players: page.users.map(user => {
        const banned = bannedMap.get(user.uid);
        return {
          uid: user.uid,
          name: user.displayName || hints.names.get(user.uid) || (user.email ? user.email.split("@")[0] : "Guest player"),
          email: user.email || "",
          isAnonymous: user.providerData.length === 0,
          isAdmin: adminMap.get(user.uid) === true,
          disabled: !!user.disabled,
          banned: !!banned,
          createdAt: user.metadata?.creationTime ? Date.parse(user.metadata.creationTime) : null,
          lastActivity: hints.activity.get(user.uid) || null
        };
      }),
      nextPageToken: page.pageToken || null
    };
  } catch (error) {
    logger.error("adminListPlayers failed", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Unable to load player accounts.");
  }
});

exports.adminListRooms = onCall({ region: REGION, timeoutSeconds: 60, memory: "512MiB" }, async request => {
  await requireAdmin(request);
  const status = typeof request.data?.status === "string" ? request.data.status : "all";
  if (status !== "all" && !ALLOWED_STATUSES.has(status)) throw new HttpsError("invalid-argument", "Invalid room status filter.");
  const cursor = typeof request.data?.cursor === "string" ? request.data.cursor : "";
  const pageSize = 50;
  try {
    let query = db.collection("rooms");
    if (status !== "all") query = query.where("status", "==", status);
    query = query.orderBy("updatedAt", "desc");
    if (cursor) {
      const cursorSnap = await db.collection("rooms").doc(cursor).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }
    const page = await query.limit(pageSize + 1).get();
    const hasMore = page.docs.length > pageSize;
    const docs = page.docs.slice(0, pageSize);
    return { rooms: docs.map(serializeRoom), nextCursor: hasMore ? docs[docs.length - 1].id : null };
  } catch (error) {
    logger.error("adminListRooms failed", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Unable to load rooms. Check the Firestore indexes are deployed.");
  }
});

exports.adminListAudit = onCall({ region: REGION }, async request => {
  await requireAdmin(request);
  const limit = Math.max(1, Math.min(100, Number.parseInt(request.data?.limit, 10) || 50));
  try {
    const snap = await db.collection("adminAudit").orderBy("at", "desc").limit(limit).get();
    return { entries: snap.docs.map(doc => ({
      id: doc.id,
      action: text(doc.get("action"), "adminAction"),
      targetType: text(doc.get("targetType"), "system"),
      targetId: text(doc.get("targetId")),
      actorUid: text(doc.get("actorUid")),
      actorEmail: text(doc.get("actorEmail")),
      details: doc.get("details") && typeof doc.get("details") === "object" ? doc.get("details") : {},
      at: serializeTime(doc.get("at"))
    })) };
  } catch (error) {
    logger.error("adminListAudit failed", error);
    throw new HttpsError("internal", "Unable to load the audit log.");
  }
});

exports.adminGetSettings = onCall({ region: REGION }, async request => {
  await requireAdmin(request);
  try { return { settings: await getSettings() }; }
  catch (error) { logger.error("adminGetSettings failed", error); throw new HttpsError("internal", "Unable to load game settings."); }
});

exports.adminSaveSettings = onCall({ region: REGION }, async request => {
  await requireAdmin(request);
  const input = request.data || {};
  for (const key of ["quickMatchEnabled", "privateRoomsEnabled", "maintenanceMode"]) {
    if (typeof input[key] !== "boolean") throw new HttpsError("invalid-argument", `Setting ${key} must be a boolean.`);
  }
  if (typeof input.maintenanceMessage !== "string" || input.maintenanceMessage.length > 160) throw new HttpsError("invalid-argument", "Maintenance message must be 160 characters or less.");
  if (typeof input.announcement !== "string" || input.announcement.length > 180) throw new HttpsError("invalid-argument", "Announcement must be 180 characters or less.");
  let gameWebsiteUrl;
  try {
    gameWebsiteUrl = typeof input.gameWebsiteUrl === "string"
      ? normalizeGameWebsiteUrl(input.gameWebsiteUrl)
      : (await getSettings()).gameWebsiteUrl;
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error("Could not read current game settings", error);
    throw new HttpsError("internal", "Unable to validate the current game website setting.");
  }
  const settings = {
    quickMatchEnabled: input.quickMatchEnabled,
    privateRoomsEnabled: input.privateRoomsEnabled,
    maintenanceMode: input.maintenanceMode,
    maintenanceMessage: input.maintenanceMessage.trim() || DEFAULT_SETTINGS.maintenanceMessage,
    announcement: input.announcement.trim(),
    gameWebsiteUrl
  };
  try {
    const batch = db.batch();
    const auditRef = db.collection("adminAudit").doc();
    batch.set(db.doc(SETTINGS_PATH), { ...settings, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    batch.set(auditRef, {
      action: "saveGameSettings", targetType: "settings", targetId: "game",
      details: {
        quickMatchEnabled: settings.quickMatchEnabled,
        privateRoomsEnabled: settings.privateRoomsEnabled,
        maintenanceMode: settings.maintenanceMode,
        hasAnnouncement: !!settings.announcement,
        hasGameWebsiteUrl: !!settings.gameWebsiteUrl
      },
      actorUid: request.auth.uid, actorEmail: text(request.auth.token.email), at: FieldValue.serverTimestamp()
    });
    await batch.commit();
    return { settings };
  } catch (error) {
    logger.error("adminSaveSettings failed", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Unable to save game settings.");
  }
});

exports.adminCloseRoom = onCall({ region: REGION }, async request => {
  await requireAdmin(request);
  const roomId = request.data?.roomId;
  if (!validString(roomId, 150)) throw new HttpsError("invalid-argument", "A valid room ID is required.");
  const roomRef = db.collection("rooms").doc(roomId);
  const auditRef = db.collection("adminAudit").doc();
  try {
    await db.runTransaction(async transaction => {
      const roomSnap = await transaction.get(roomRef);
      if (!roomSnap.exists) throw new HttpsError("not-found", "Room does not exist.");
      const room = roomSnap.data();
      if (room.status === "closed") throw new HttpsError("failed-precondition", "This room is already closed.");
      if (!ALLOWED_STATUSES.has(room.status)) throw new HttpsError("failed-precondition", "This room has an unknown status and cannot be closed safely.");
      let codeSnap = null;
      let codeRef = null;
      if (room.status === "waiting" && room.mode === "private" && typeof room.code === "string" && room.code) {
        codeRef = db.collection("roomCodes").doc(room.code);
        codeSnap = await transaction.get(codeRef);
      }
      transaction.update(roomRef, { status: "closed", updatedAt: FieldValue.serverTimestamp() });
      if (codeSnap?.exists && codeSnap.data().roomId === roomId) transaction.delete(codeRef);
      transaction.set(auditRef, {
        action: "closeRoom", targetType: "room", targetId: roomId,
        details: { previousStatus: text(room.status), mode: text(room.mode) },
        actorUid: request.auth.uid, actorEmail: text(request.auth.token.email), at: FieldValue.serverTimestamp()
      });
    });
    return { ok: true, roomId };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error("adminCloseRoom failed", error);
    throw new HttpsError("internal", "Unable to close this room.");
  }
});

exports.adminSetPlayerBan = onCall({ region: REGION }, async request => {
  await requireAdmin(request);
  const uid = request.data?.uid;
  const banned = request.data?.banned;
  const reason = typeof request.data?.reason === "string" ? request.data.reason.trim().slice(0, 180) : "Admin action";
  if (!validString(uid, 128) || typeof banned !== "boolean") throw new HttpsError("invalid-argument", "A user ID and ban status are required.");
  if (uid === request.auth.uid) throw new HttpsError("failed-precondition", "You cannot suspend your own administrator account.");
  try {
    const target = await auth.getUser(uid);
    const targetRole = await db.doc(`users/${uid}`).get();
    if (targetRole.exists && targetRole.data()?.role === "admin") throw new HttpsError("failed-precondition", "Administrator accounts cannot be suspended here.");
    const banRef = db.collection("bannedUsers").doc(uid);
    const auditRef = db.collection("adminAudit").doc();
    const batch = db.batch();
    if (banned) batch.set(banRef, {
      uid,
      reason: reason || "Admin action",
      bannedBy: request.auth.uid,
      bannedAt: FieldValue.serverTimestamp()
    });
    else batch.delete(banRef);
    batch.set(auditRef, {
      action: banned ? "banPlayer" : "unbanPlayer",
      targetType: "player", targetId: uid,
      details: { reason: reason || "Admin action" },
      actorUid: request.auth.uid, actorEmail: text(request.auth.token.email), at: FieldValue.serverTimestamp()
    });
    await batch.commit();
    return { ok: true, uid, banned };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error("adminSetPlayerBan failed", error);
    if (error.code === "auth/user-not-found") throw new HttpsError("not-found", "This Firebase Authentication account no longer exists.");
    throw new HttpsError("internal", "Unable to update this player's status.");
  }
});
