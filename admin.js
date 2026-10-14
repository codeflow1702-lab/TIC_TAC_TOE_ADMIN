import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyC8tJuU-3dnSqHwxBwIFpV60WC5Qs8fFWU",
  authDomain: "multiplayer-tic-tac-toe-8aac0.firebaseapp.com",
  projectId: "multiplayer-tic-tac-toe-8aac0",
  storageBucket: "multiplayer-tic-tac-toe-8aac0.firebasestorage.app",
  messagingSenderId: "130348640052",
  appId: "1:130348640052:web:e4edb00fb6da0d79072761",
  measurementId: "G-MJ5GP11WPN"
};

// A named Firebase app keeps admin sign-in persistence separate from the game's anonymous player session.
const app = initializeApp(firebaseConfig, "admin-console");
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "us-central1");
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const callableCache = new Map();
const state = {
  user: null, page: "overview", dashboard: null, settings: null,
  players: [], playerCursor: null, playersLoading: false, playerRequestVersion: 0,
  rooms: [], roomCursor: null, roomStatus: "all", roomsLoading: false, roomRequestVersion: 0,
  audit: [], toastTimer: null, pendingConfirm: null, refreshing: false
};
const pageInfo = {
  overview: ["Overview", "A clear view of your game and community."],
  players: ["Players", "Browse accounts, review status, and protect your community."],
  rooms: ["Live rooms", "Monitor active rooms and resolve stuck matches."],
  activity: ["Activity log", "A traceable record of administrative actions."],
  settings: ["Game settings", "Control matchmaking, maintenance, and player-facing notices."]
};
const defaultSettings = {
  quickMatchEnabled: true, privateRoomsEnabled: true, maintenanceMode: false,
  maintenanceMessage: "We'll be back shortly.", announcement: "", gameWebsiteUrl: ""
};

function call(name) {
  if (!callableCache.has(name)) callableCache.set(name, httpsCallable(functions, name));
  return callableCache.get(name);
}
async function invoke(name, payload = {}) {
  if (!state.user) throw new Error("Please sign in again to continue.");
  try {
    const result = await call(name)(payload);
    return result.data;
  } catch (error) {
    console.error(`[admin:${name}]`, error);
    throw new Error(friendlyError(error));
  }
}
function friendlyError(error) {
  const code = String(error?.code || "");
  if (code.includes("unauthenticated")) return "Your session expired. Sign in again.";
  if (code.includes("permission-denied")) return "This account does not have administrator permission.";
  if (code.includes("not-found")) return "That account or room no longer exists.";
  if (code.includes("failed-precondition")) return error.message || "The requested action is not allowed in the current state.";
  if (code.includes("resource-exhausted")) return "Too many requests. Please try again in a moment.";
  if (code.includes("unavailable") || code.includes("deadline-exceeded")) return "Firebase is temporarily unavailable. Check your connection and retry.";
  if (error?.message && !error.message.startsWith("internal")) return error.message;
  return "Something went wrong. Please retry; details are available in the browser console.";
}
function toggleView(isAuthed) {
  $("#auth-view").classList.toggle("hidden", isAuthed);
  $("#app-view").classList.toggle("hidden", !isAuthed);
}
function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.previousLabel = button.innerHTML;
    button.disabled = true;
    if (label) button.textContent = label;
  } else {
    button.disabled = false;
    if (button.dataset.previousLabel) {
      button.innerHTML = button.dataset.previousLabel;
      delete button.dataset.previousLabel;
    }
  }
}
function showNotice(kind, message) {
  const target = kind === "error" ? $("#global-error") : $("#global-success");
  const other = kind === "error" ? $("#global-success") : $("#global-error");
  other.classList.add("hidden");
  target.textContent = message;
  target.classList.remove("hidden");
  clearTimeout(target._hideTimer);
  target._hideTimer = setTimeout(() => target.classList.add("hidden"), kind === "error" ? 7000 : 3600);
}
function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.classList.remove("visible"), 2600);
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]));
}
function normalizeGameWebsiteUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.length > 300) throw new Error("The game website URL must be 300 characters or fewer.");
  let url;
  try { url = new URL(raw); }
  catch { throw new Error("Enter a complete website URL, including https://."); }
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(localHost && url.protocol === "http:"))) {
    throw new Error("Use an HTTPS game website URL. HTTP is allowed only for localhost testing.");
  }
  if (url.search || url.hash) throw new Error("Use the game website address without query parameters or a fragment.");
  return url.href;
}
function updateGameWebsiteLinks(value) {
  let url = "";
  try { url = normalizeGameWebsiteUrl(value); } catch { /* invalid stored value stays disabled */ }
  $$('[data-game-link]').forEach(link => {
    link.href = url || "#";
    link.setAttribute("aria-disabled", url ? "false" : "true");
    link.title = url ? "Open the game website in a new tab" : "Set the game website URL in Game settings";
    link.tabIndex = 0;
  });
  const status = $("#game-url-status");
  if (status) status.textContent = url ? "Configured" : "Not configured";
}
function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value) || 0;
  if (typeof value.seconds === "number") return value.seconds * 1000;
  if (typeof value._seconds === "number") return value._seconds * 1000;
  return 0;
}
function fmtDate(value, withTime = false) {
  const ms = timestampMs(value);
  if (!ms) return "—";
  const date = new Date(ms);
  return new Intl.DateTimeFormat(undefined, withTime
    ? {month:"short", day:"numeric", hour:"numeric", minute:"2-digit"}
    : {month:"short", day:"numeric", year:"numeric"}).format(date);
}
function relativeTime(value) {
  const ms = timestampMs(value);
  if (!ms) return "Unknown";
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
function avatarText(value) {
  const text = String(value || "P").trim();
  return text ? text.slice(0, 1).toUpperCase() : "P";
}
function badge(status) {
  const allowed = ["playing", "waiting", "finished", "closed", "active", "banned", "disabled", "private"];
  const key = String(status || "unknown").toLowerCase();
  return `<span class="status-pill ${allowed.includes(key) ? key : ""}">${esc(key.charAt(0).toUpperCase() + key.slice(1))}</span>`;
}
function playerLabel(player, fallback) {
  return player?.name || fallback || "Open seat";
}
function roomSummaryMarkup(room, compact = false) {
  const id = esc(room.id || "—");
  const x = playerLabel(room.players?.X, "Player X");
  const o = room.players?.O?.name || (room.status === "waiting" ? "Waiting for opponent" : "Player O");
  return `<div class="primary-cell"><div class="mini-avatar">${esc(avatarText(x))}</div><div><strong>${esc(x)} <span style="color:#a3aab4;font-weight:500">vs</span> ${esc(o)}</strong><small>${compact ? "Room " : ""}${id}</small></div></div>`;
}
function setPage(page) {
  if (!pageInfo[page]) return;
  state.page = page;
  $$(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.page === page));
  $$(".page").forEach(section => {
    const active = section.id === `page-${page}`;
    section.classList.toggle("active", active);
    section.classList.toggle("hidden", !active);
  });
  $("#page-title").textContent = pageInfo[page][0];
  $("#page-subtitle").textContent = pageInfo[page][1];
  $("#breadcrumb-current").textContent = page.toUpperCase();
  if (page === "players" && !state.players.length && !state.playersLoading) loadPlayers(false);
  if (page === "rooms" && !state.rooms.length && !state.roomsLoading) loadRooms(false);
  if (page === "activity" && !state.audit.length) loadAudit();
  window.scrollTo({top:0, behavior:"smooth"});
}
function modalConfirm({title, message, confirmText = "Confirm", danger = true}) {
  $("#modal-title").textContent = title;
  $("#modal-copy").textContent = message;
  $("#modal-confirm").textContent = confirmText;
  $("#modal-confirm").classList.toggle("danger", danger);
  $("#modal-symbol").textContent = danger ? "!" : "✓";
  $("#modal-symbol").style.background = danger ? "#fff2f0" : "#e7f4eb";
  $("#modal-symbol").style.color = danger ? "#c34f56" : "#37865b";
  $("#confirm-modal").classList.remove("hidden");
  return new Promise(resolve => { state.pendingConfirm = resolve; setTimeout(() => $("#modal-cancel").focus(), 0); });
}
function closeModal(result) {
  $("#confirm-modal").classList.add("hidden");
  if (state.pendingConfirm) state.pendingConfirm(result);
  state.pendingConfirm = null;
}

async function refreshDashboard() {
  state.refreshing = true;
  setBusy($("#refresh-button"), true, "Refreshing…");
  try {
    const data = await invoke("adminDashboard");
    state.dashboard = data;
    state.settings = data.settings || {...defaultSettings};
    renderDashboard(data);
    renderSettings(state.settings);
    $("#players-nav-count").textContent = data.counts?.playersLabel || "";
    $("#rooms-nav-count").textContent = data.counts?.activeRooms ?? "";
    $("#rooms-nav-count").classList.toggle("hidden", !data.counts?.activeRooms);
    $("#players-nav-count").classList.toggle("hidden", !data.counts?.playersLabel);
  } catch (error) {
    showNotice("error", error.message);
  } finally {
    state.refreshing = false;
    setBusy($("#refresh-button"), false);
  }
}
function renderDashboard(data) {
  const counts = data.counts || {};
  $("#stat-players").textContent = counts.playersLabel || "—";
  $("#stat-players-note").textContent = counts.playersExact === false ? "At least this many accounts" : "Firebase Authentication";
  $("#stat-playing").textContent = counts.playing ?? "—";
  $("#stat-waiting").textContent = counts.waiting ?? "—";
  $("#stat-finished").textContent = counts.finished ?? "—";
  renderChart(data.dailyActivity || []);
  renderSummarySettings(data.settings || defaultSettings);
  renderRecentRooms(data.recentRooms || []);
}
function renderChart(points) {
  const chart = $("#activity-chart");
  chart.replaceChildren();
  if (!points.length) {
    chart.innerHTML = '<div class="empty-state">No match activity to chart yet.</div>';
    return;
  }
  const max = Math.max(1, ...points.map(point => Number(point.count) || 0));
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const col = document.createElement("div"); col.className = "chart-col";
    const count = document.createElement("span"); count.className = "bar-count"; count.textContent = point.count;
    const track = document.createElement("div"); track.className = "bar-track";
    const fill = document.createElement("div"); fill.className = `bar-fill${index === points.length - 1 ? " today" : ""}`;
    fill.style.height = `${Math.max(3, ((Number(point.count) || 0) / max) * 100)}%`;
    fill.title = `${point.label}: ${point.count} rooms`;
    track.append(fill); const label = document.createElement("span"); label.className = "bar-label"; label.textContent = point.label;
    col.append(count, track, label); chart.append(col);
  }
}
function renderSummarySettings(settings) {
  const rows = [
    ["↔", "Quick Match", !!settings.quickMatchEnabled],
    ["⌁", "Private rooms", !!settings.privateRoomsEnabled],
    ["⚠", "Maintenance", !!settings.maintenanceMode]
  ];
  $("#settings-summary").innerHTML = rows.map(([icon, label, enabled]) => `<div class="summary-row"><span>${icon}</span><div><strong>${label}</strong><small>${label === "Maintenance" && enabled ? "New games are paused" : enabled ? "Available to players" : "Currently disabled"}</small></div><span class="mini-state ${enabled ? "" : "off"}">${enabled ? "On" : "Off"}</span></div>`).join("");
}
function renderRecentRooms(rooms) {
  const root = $("#recent-rooms");
  if (!rooms.length) { root.innerHTML = '<div class="empty-state">No rooms have been created yet.</div>'; return; }
  root.innerHTML = `<table class="data-table"><thead><tr><th>Players / room</th><th>Type</th><th>Status</th><th>Last update</th></tr></thead><tbody>${rooms.map(room => `<tr><td>${roomSummaryMarkup(room, true)}</td><td><span class="mode-label">${room.mode === "private" ? "Private room" : "Quick match"}</span></td><td>${badge(room.status)}</td><td>${esc(relativeTime(room.updatedAt || room.createdAt))}</td></tr>`).join("")}</tbody></table>`;
}

async function loadPlayers(append) {
  if (append && state.playersLoading) return;
  if (append && !state.playerCursor) return;
  const requestVersion = append ? state.playerRequestVersion : ++state.playerRequestVersion;
  state.playersLoading = true;
  const button = $("#players-load-more");
  setBusy(button, true, "Loading…");
  if (!append) {
    state.players = [];
    state.playerCursor = null;
    $("#players-table").innerHTML = '<div class="empty-state">Loading player accounts…</div>';
  }
  try {
    const data = await invoke("adminListPlayers", {pageToken: append ? state.playerCursor : null});
    if (requestVersion !== state.playerRequestVersion) return;
    if (append) state.players.push(...(data.players || []));
    else state.players = data.players || [];
    state.playerCursor = data.nextPageToken || null;
    $("#players-caption").textContent = `${state.players.length}${state.playerCursor ? "+" : ""} accounts loaded from Firebase Authentication.`;
    renderPlayers();
  } catch (error) {
    if (requestVersion !== state.playerRequestVersion) return;
    $("#players-table").innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
    showNotice("error", error.message);
  } finally {
    if (requestVersion === state.playerRequestVersion) {
      state.playersLoading = false;
      setBusy(button, false);
      button.classList.toggle("hidden", !state.playerCursor);
    }
  }
}
function renderPlayers() {
  const query = $("#players-search").value.trim().toLowerCase();
  const visible = state.players.filter(player => [player.name, player.uid, player.email].some(value => String(value || "").toLowerCase().includes(query)));
  const root = $("#players-table");
  if (!visible.length) { root.innerHTML = `<div class="empty-state">${state.players.length ? "No loaded accounts match your search." : "No accounts found."}</div>`; return; }
  root.innerHTML = `<table class="data-table"><thead><tr><th>Player</th><th>Account type</th><th>Created</th><th>Last activity</th><th>Status</th><th>Action</th></tr></thead><tbody>${visible.map(player => `<tr><td><div class="primary-cell"><div class="mini-avatar">${esc(avatarText(player.name))}</div><div><strong>${esc(player.name || "Player")}</strong><small title="${esc(player.uid)}">${esc(player.uid.slice(0, 8))}…</small></div></div></td><td><span class="mode-label">${player.isAnonymous ? "Anonymous" : "Email account"}</span></td><td>${esc(fmtDate(player.createdAt))}</td><td>${esc(player.lastActivity ? relativeTime(player.lastActivity) : "No room history")}</td><td>${badge(player.banned ? "banned" : player.disabled ? "disabled" : "active")}</td><td>${player.isAdmin ? '<span class="mode-label">Protected admin</span>' : `<button class="row-action ${player.banned ? "" : "danger-action"}" data-player-action="${player.banned ? "unban" : "ban"}" data-player-uid="${esc(player.uid)}" type="button">${player.banned ? "Restore" : "Suspend"}</button>`}</td></tr>`).join("")}</tbody></table>`;
}
async function handlePlayerAction(button) {
  const uid = button.dataset.playerUid;
  const player = state.players.find(item => item.uid === uid);
  if (!player) return;
  const ban = button.dataset.playerAction === "ban";
  const confirmed = await modalConfirm({
    title: ban ? `Suspend ${player.name || "this player"}?` : `Restore ${player.name || "this player"}?`,
    message: ban ? "This blocks the account from reading or changing game data. Existing tokens are checked against the ban record by Firestore rules." : "This removes the ban record so the account can access game data again.",
    confirmText: ban ? "Suspend player" : "Restore access", danger: ban
  });
  if (!confirmed) return;
  setBusy(button, true, ban ? "Suspending…" : "Restoring…");
  try {
    await invoke("adminSetPlayerBan", {uid, banned: ban, reason: ban ? "Suspended from admin console" : "Restored from admin console"});
    player.banned = ban;
    renderPlayers();
    showNotice("success", ban ? `${player.name || "Player"} has been suspended.` : `${player.name || "Player"} has been restored.`);
  } catch (error) { showNotice("error", error.message); setBusy(button, false); }
}

async function loadRooms(append) {
  if (append && state.roomsLoading) return;
  if (append && !state.roomCursor) return;
  const requestVersion = append ? state.roomRequestVersion : ++state.roomRequestVersion;
  const status = state.roomStatus;
  state.roomsLoading = true;
  const button = $("#rooms-load-more");
  setBusy(button, true, "Loading…");
  if (!append) {
    state.rooms = [];
    state.roomCursor = null;
    $("#rooms-table").innerHTML = '<div class="empty-state">Loading rooms…</div>';
  }
  try {
    const data = await invoke("adminListRooms", {status, cursor: append ? state.roomCursor : null});
    if (requestVersion !== state.roomRequestVersion) return;
    if (append) state.rooms.push(...(data.rooms || []));
    else state.rooms = data.rooms || [];
    state.roomCursor = data.nextCursor || null;
    renderRooms();
  } catch (error) {
    if (requestVersion !== state.roomRequestVersion) return;
    $("#rooms-table").innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
    showNotice("error", error.message);
  } finally {
    if (requestVersion === state.roomRequestVersion) {
      state.roomsLoading = false;
      setBusy(button, false);
      button.classList.toggle("hidden", !state.roomCursor);
    }
  }
}
function renderRooms() {
  const query = $("#rooms-search").value.trim().toLowerCase();
  const visible = state.rooms.filter(room => [room.id, room.code, room.players?.X?.name, room.players?.O?.name, room.players?.X?.uid, room.players?.O?.uid].some(value => String(value || "").toLowerCase().includes(query)));
  const root = $("#rooms-table");
  if (!visible.length) { root.innerHTML = `<div class="empty-state">${state.rooms.length ? "No loaded rooms match your search." : "No rooms found for this filter."}</div>`; return; }
  root.innerHTML = `<table class="data-table"><thead><tr><th>Players / room</th><th>Type</th><th>Invite code</th><th>Status</th><th>Updated</th><th>Action</th></tr></thead><tbody>${visible.map(room => `<tr><td>${roomSummaryMarkup(room)}</td><td><span class="mode-label">${room.mode === "private" ? "Private" : "Quick"}</span></td><td>${room.code ? `<span class="mode-label">${esc(room.code)}</span>` : "—"}</td><td>${badge(room.status)}</td><td>${esc(relativeTime(room.updatedAt || room.createdAt))}</td><td>${room.status === "closed" ? '<span class="mode-label">—</span>' : `<button class="row-action danger-action" data-room-close="${esc(room.id)}" type="button">Close room</button>`}</td></tr>`).join("")}</tbody></table>`;
}
async function handleCloseRoom(button) {
  const roomId = button.dataset.roomClose;
  const room = state.rooms.find(item => item.id === roomId);
  if (!room) return;
  const accepted = await modalConfirm({title:"Close this room?",message:`This will close room ${roomId} and return connected players to the lobby. Use this for stuck or invalid matches.`,confirmText:"Close room",danger:true});
  if (!accepted) return;
  setBusy(button, true, "Closing…");
  try {
    await invoke("adminCloseRoom", {roomId});
    room.status = "closed";
    renderRooms();
    showNotice("success", `Room ${roomId} has been closed.`);
    refreshDashboard();
  } catch (error) { showNotice("error", error.message); setBusy(button, false); }
}

async function loadAudit() {
  $("#audit-list").innerHTML = '<div class="empty-state">Loading activity…</div>';
  try {
    const data = await invoke("adminListAudit", {limit: 100});
    state.audit = data.entries || [];
    renderAudit();
  } catch (error) {
    $("#audit-list").innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
    showNotice("error", error.message);
  }
}
function renderAudit() {
  const root = $("#audit-list");
  if (!state.audit.length) { root.innerHTML = '<div class="empty-state">No admin actions recorded yet.</div>'; return; }
  root.innerHTML = state.audit.map(entry => {
    const details = entry.details && Object.keys(entry.details).length ? ` · ${Object.entries(entry.details).map(([key, value]) => `${key}: ${value}`).join(" · ")}` : "";
    return `<div class="audit-item"><div class="audit-symbol">${entry.action?.includes("ban") ? "♙" : entry.action?.includes("room") ? "▦" : "⚙"}</div><div class="audit-main"><strong>${esc((entry.action || "Admin action").replace(/([A-Z])/g, " $1"))}</strong><p>${esc(entry.actorEmail || entry.actorUid || "Administrator")} · ${esc(entry.targetType || "system")} ${esc(entry.targetId || "")}${esc(details)}</p></div><time class="audit-time" datetime="">${esc(fmtDate(entry.at, true))}</time></div>`;
  }).join("");
}

function renderSettings(settings) {
  const values = {...defaultSettings, ...(settings || {})};
  $("#setting-quick").checked = !!values.quickMatchEnabled;
  $("#setting-private").checked = !!values.privateRoomsEnabled;
  $("#setting-maintenance").checked = !!values.maintenanceMode;
  $("#setting-maintenance-message").value = values.maintenanceMessage || defaultSettings.maintenanceMessage;
  $("#setting-announcement").value = values.announcement || "";
  $("#setting-game-url").value = values.gameWebsiteUrl || "";
  $("#maintenance-message-wrap").classList.toggle("hidden", !values.maintenanceMode);
  $("#announcement-count").textContent = `${($("#setting-announcement").value || "").length} / 180`;
  updateGameWebsiteLinks(values.gameWebsiteUrl || "");
  renderSummarySettings(values);
}
async function saveSettings(event) {
  event.preventDefault();
  const settings = {
    quickMatchEnabled: $("#setting-quick").checked,
    privateRoomsEnabled: $("#setting-private").checked,
    maintenanceMode: $("#setting-maintenance").checked,
    maintenanceMessage: $("#setting-maintenance-message").value.trim().slice(0, 160) || defaultSettings.maintenanceMessage,
    announcement: $("#setting-announcement").value.trim().slice(0, 180),
    gameWebsiteUrl: $("#setting-game-url").value.trim().slice(0, 300)
  };
  try { settings.gameWebsiteUrl = normalizeGameWebsiteUrl(settings.gameWebsiteUrl); }
  catch (error) { showNotice("error", error.message); $("#setting-game-url").focus(); return; }
  const button = $("#settings-save");
  setBusy(button, true, "Saving…");
  $("#settings-save-state").textContent = "Saving changes…";
  try {
    const data = await invoke("adminSaveSettings", settings);
    state.settings = data.settings || settings;
    renderSettings(state.settings);
    $("#settings-save-state").textContent = `Saved ${new Date().toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})}`;
    showNotice("success", "Game settings saved. New lobby actions will use the updated configuration.");
    refreshDashboard();
  } catch (error) {
    $("#settings-save-state").textContent = "Save failed";
    showNotice("error", error.message);
  } finally { setBusy(button, false); }
}

async function refreshCurrentPage() {
  if (state.page === "overview") return refreshDashboard();
  if (state.page === "players") return loadPlayers(false);
  if (state.page === "rooms") return loadRooms(false);
  if (state.page === "activity") return loadAudit();
  if (state.page === "settings") {
    try { const data = await invoke("adminGetSettings"); state.settings = data.settings; renderSettings(data.settings); }
    catch (error) { showNotice("error", error.message); }
  }
}
function bindEvents() {
  $("#login-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = $("#login-button");
    $("#login-error").textContent = "";
    setBusy(button, true, "Signing in…");
    try {
      await signInWithEmailAndPassword(auth, $("#login-email").value.trim(), $("#login-password").value);
    } catch (error) {
      const code = String(error?.code || "");
      $("#login-error").textContent = code.includes("operation-not-allowed")
        ? "Email/password sign-in is not enabled in Firebase Authentication."
        : code.includes("invalid-credential") || code.includes("user-not-found") || code.includes("wrong-password")
          ? "Email or password is incorrect."
          : friendlyError(error);
      setBusy(button, false);
    }
  });
  $("#logout-button").addEventListener("click", () => signOut(auth));
  $("#mobile-logout").addEventListener("click", () => signOut(auth));
  $("#refresh-button").addEventListener("click", refreshCurrentPage);
  $("#audit-refresh").addEventListener("click", loadAudit);
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#setting-maintenance").addEventListener("change", () => $("#maintenance-message-wrap").classList.toggle("hidden", !$("#setting-maintenance").checked));
  $("#setting-announcement").addEventListener("input", () => $("#announcement-count").textContent = `${$("#setting-announcement").value.length} / 180`);
  $("#setting-game-url").addEventListener("input", () => {
    try { updateGameWebsiteLinks(normalizeGameWebsiteUrl($("#setting-game-url").value)); }
    catch { updateGameWebsiteLinks(""); if ($("#setting-game-url").value.trim()) $("#game-url-status").textContent = "Check URL"; }
  });
  $$('[data-game-link]').forEach(link => link.addEventListener("click", event => {
    if (link.getAttribute("aria-disabled") === "true") {
      event.preventDefault();
      showNotice("error", "Set the public game website URL under Game settings before opening the game from this console.");
      setPage("settings");
      $("#setting-game-url").focus();
    }
  }));
  $("#players-search").addEventListener("input", renderPlayers);
  $("#players-load-more").addEventListener("click", () => loadPlayers(true));
  $("#rooms-search").addEventListener("input", renderRooms);
  $("#rooms-status").addEventListener("change", () => { state.roomStatus = $("#rooms-status").value; loadRooms(false); });
  $("#rooms-load-more").addEventListener("click", () => loadRooms(true));
  $("#players-table").addEventListener("click", event => { const button = event.target.closest("[data-player-action]"); if (button) handlePlayerAction(button); });
  $("#rooms-table").addEventListener("click", event => { const button = event.target.closest("[data-room-close]"); if (button) handleCloseRoom(button); });
  $$(".nav-item").forEach(button => button.addEventListener("click", () => setPage(button.dataset.page)));
  $$('[data-go-page]').forEach(button => button.addEventListener("click", () => setPage(button.dataset.goPage)));
  $("#modal-cancel").addEventListener("click", () => closeModal(false));
  $("#modal-confirm").addEventListener("click", () => closeModal(true));
  $("#confirm-modal").addEventListener("click", event => { if (event.target === $("#confirm-modal")) closeModal(false); });
  $("#year-now").textContent = new Date().getFullYear();
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    state.user = null;
    toggleView(false);
    return;
  }
  try {
    // Admin role is stored in Firestore at users/{Firebase Auth UID}.
    // The matching Firestore rules permit a user to read only their own user document
    // and deny all client-side writes to user documents.
    const userDoc = await getDoc(doc(db, "users", user.uid));
    if (!userDoc.exists() || userDoc.data()?.role !== "admin") {
      await signOut(auth);
      $("#login-error").textContent = "This account is not an administrator. Check that users/{your Firebase UID} has the string field role = admin.";
      setBusy($("#login-button"), false);
      return;
    }
    setBusy($("#login-button"), false);
    $("#login-error").textContent = "";
    state.user = user;
    toggleView(true);
    const label = user.displayName || user.email?.split("@")[0] || "Administrator";
    $("#admin-name").textContent = label;
    $("#admin-email").textContent = user.email || "Admin account";
    $("#admin-avatar").textContent = avatarText(label);
    await refreshDashboard();
  } catch (error) {
    console.error("Admin authentication check failed", error);
    await signOut(auth);
    setBusy($("#login-button"), false);
    $("#login-error").textContent = friendlyError(error);
  }
});

bindEvents();
