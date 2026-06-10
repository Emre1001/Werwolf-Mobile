// app.js – Werwolf Mobile v2.0 | Komplettes Rewrite mit Bugfixes & neuen Features
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, onSnapshot, updateDoc, collection, query, where, getDocs, setDoc, deleteDoc, arrayUnion, getDoc, addDoc, orderBy, runTransaction } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { LANGS, initLang, setLang, getLang, onLangChange, t, roleName, roleDesc } from "./i18n.js";

// ========== FIREBASE ==========
const firebaseConfig = {
  apiKey: "AIzaSyBy9KD3rh8-JmmNwaPi03FJnrvaUq5UZGM",
  authDomain: "werwolf-mobile.firebaseapp.com",
  projectId: "werwolf-mobile",
  storageBucket: "werwolf-mobile.firebasestorage.app",
  messagingSenderId: "527338897912",
  appId: "1:527338897912:web:a758205dd6a172e46f560d",
  measurementId: "G-2ZXMHGBRPH"
};

let db, firebaseReady = false;
try {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  firebaseReady = true;
} catch(e) { console.error("Firebase init error", e); }

// ========== CONSENT ==========
// localStorage can throw (storage disabled, some private modes) — a top-level throw
// would prevent the whole module from loading, so every access goes through these.
function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, value); } catch {} }

const CONSENT_KEY = "werwolf_consent_given";
let consentGiven = storageGet(CONSENT_KEY) === "true";

function showConsentModal() { document.getElementById("consent-modal").style.display = "flex"; }
function acceptConsent() { storageSet(CONSENT_KEY, "true"); consentGiven = true; document.getElementById("consent-modal").style.display = "none"; initApp(); setupInstallBanner(); }
function rejectConsent() { showToast(t("consentNeeded"), "warning"); }

// ========== OFFLINE ==========
let isOnline = navigator.onLine;
function showOfflineModal() { document.getElementById("offline-modal").style.display = "flex"; }
function hideOfflineModal() { document.getElementById("offline-modal").style.display = "none"; }
window.addEventListener("online", () => {
  isOnline = true;
  hideOfflineModal();
  // Don't re-init while the player is in an active lobby — that would tear them out of the
  // game into the main menu and leave the old listeners/intervals running. The Firestore
  // listener reconnects on its own.
  if (consentGiven && firebaseReady && !currentLobbyId) initApp();
});
window.addEventListener("offline", () => { isOnline = false; showOfflineModal(); });

// ========== LEGAL ==========
function showImpressum() { const modal = document.getElementById("legal-modal"); document.getElementById("legal-modal-title").innerText = t("imprint"); document.getElementById("legal-modal-body").innerHTML = `<p><strong>Angaben gemäß § 5 TMG:</strong></p><p>Emre Asik<br>E-Mail: emre.asik201060@gmail.com</p><p>Die Anschrift wird aus Datenschutzgründen nicht öffentlich angezeigt. Sie erhalten diese auf Anfrage.</p><p><strong>Verantwortlich für den Inhalt:</strong> Emre Asik</p>`; modal.style.display = "flex"; }
function showDatenschutz() { const modal = document.getElementById("legal-modal"); document.getElementById("legal-modal-title").innerText = t("privacy"); document.getElementById("legal-modal-body").innerHTML = `<p><strong>1. Verantwortlicher</strong><br>Emre Asik, emre.asik201060@gmail.com</p><p><strong>2. Erhobene Daten</strong><br>Spieler-ID, Geräte-ID (LocalStorage). Technisch notwendig.</p><p><strong>3. Rechtsgrundlage</strong><br>Art. 6 Abs. 1 lit. a, b DSGVO. Einwilligung jederzeit widerrufbar.</p><p><strong>4. Weitergabe</strong><br>Keine Weitergabe an Dritte.</p>`; modal.style.display = "flex"; }
function closeLegalModal() { document.getElementById("legal-modal").style.display = "none"; }

// ========== GLOBAL STATE ==========
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36); }

let deviceId = storageGet("ww_device_id");
if (!deviceId && consentGiven) { deviceId = uuid(); storageSet("ww_device_id", deviceId); }
let currentUser = { id: storageGet("ww_player_id") || uuid(), name: "", deviceId };
if (consentGiven) storageSet("ww_player_id", currentUser.id);

let currentLobbyId = null;
let unsubscribeLobby = null;
let heartbeatInterval = null;
let deferredPrompt = null;
let roleDisplayTimeout = null;
let roleDisplayInterval = null;
let lastStateFingerprint = null;
let unsubscribeChat = null;
let chatMessages = [];
let currentChatChannel = null;
let chatClearedAt = 0;
let inactiveCheckInterval = null;
let lastPhase = null;
let lastRevealId = null; // ensures every player sees their secret role once per game
let phaseAdvancing = false;
let viewTicker = null;

// Phase time limits (ms) – safety net so a non-responding player never freezes the game.
const NIGHT_STEP_MS = 90000;
const DAY_MS = 60000;
const VOTE_MS = 75000;
const HUNTER_MS = 45000;
const deadlineIn = (ms) => Date.now() + ms;

// Run a phase transition exactly once at a time (prevents host double-advance on rapid snapshots).
async function runLocked(fn) {
  if (phaseAdvancing) return;
  phaseAdvancing = true;
  try { await fn(); }
  catch (e) { console.warn("phase advance error", e); }
  finally { phaseAdvancing = false; }
}

const ui = document.getElementById("ui-container");

// ========== I18N HELPERS ==========
let currentRender = null; // re-renders the active screen when the language changes

function applyStaticI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach(el => { el.setAttribute("placeholder", t(el.dataset.i18nPh)); });
}

function buildLangPicker() {
  const sel = document.getElementById("lang-select");
  if (!sel) return;
  sel.innerHTML = LANGS.map(l => `<option value="${l.code}">${l.flag} ${l.label}</option>`).join("");
  sel.value = getLang();
  sel.addEventListener("change", () => setLang(sel.value));
}

// ========== THEME (Dark/Light) ==========
const THEME_KEY = "ww_theme";
let particleRGB = "96, 165, 250";
let lineRGB = "56, 189, 248";

function readThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  particleRGB = (cs.getPropertyValue("--particle-rgb").trim()) || particleRGB;
  lineRGB = (cs.getPropertyValue("--line-rgb").trim()) || lineRGB;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", (cs.getPropertyValue("--meta-color").trim()) || "#0a1733");
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const icon = document.querySelector("#theme-toggle i");
  if (icon) icon.className = theme === "light" ? "fas fa-sun" : "fas fa-moon";
  readThemeColors();
}

function toggleTheme() {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  applyTheme(next);
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  applyTheme(saved || (mq.matches ? "light" : "dark"));
  mq.addEventListener("change", (e) => {
    let manual = null;
    try { manual = localStorage.getItem(THEME_KEY); } catch (err) {}
    if (!manual) applyTheme(e.matches ? "light" : "dark");
  });
}

// ========== TOAST SYSTEM ==========
function showToast(msg, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add("toast-exit"); setTimeout(() => toast.remove(), 400); }, 3500);
}

// ========== PARTICLE SYSTEM ==========
function initParticles() {
  const canvas = document.getElementById("particles");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let w, h;
  const particles = [];
  const count = Math.min(60, Math.floor(window.innerWidth / 25));
  const maxDist = 130;

  function resize() { w = canvas.width = window.innerWidth; h = canvas.height = window.innerHeight; }
  resize();
  window.addEventListener("resize", resize);

  for (let i = 0; i < count; i++) {
    particles.push({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35, r: Math.random() * 1.8 + 0.8 });
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${particleRGB}, 0.5)`;
      ctx.fill();
      for (let j = i + 1; j < particles.length; j++) {
        const q = particles[j];
        const dx = p.x - q.x, dy = p.y - q.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < maxDist) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.strokeStyle = `rgba(${lineRGB}, ${0.14 * (1 - d / maxDist)})`;
          ctx.lineWidth = 0.6;
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(draw);
  }
  draw();
}

// ========== PHASE TRANSITION ==========
function showPhaseTransition(phase) {
  const overlay = document.getElementById("phase-overlay");
  const icon = document.getElementById("phase-overlay-icon");
  const text = document.getElementById("phase-overlay-text");
  if (!overlay) return;

  overlay.className = "phase-overlay";

  if (phase === "NIGHT") {
    icon.textContent = "🌙";
    text.textContent = t("nightFalls");
    overlay.classList.add("phase-night");
  } else if (phase === "DAY") {
    icon.textContent = "☀️";
    text.textContent = t("dayBreaks");
    overlay.classList.add("phase-day");
  } else if (phase === "VOTING") {
    icon.textContent = "🗳️";
    text.textContent = t("votingTime");
    overlay.classList.add("phase-vote");
  } else return;

  overlay.classList.add("active");
  setTimeout(() => { overlay.classList.remove("active"); }, 2200);
}

// ========== GUIDE SYSTEM ==========
function showGuide() {
  const existing = document.querySelector(".guide-overlay");
  if (existing) { existing.remove(); return; }

  const guideRoleKeys = ["Werwolf", "Dorfbewohner", "Seherin", "Hexe", "Amor", "Jäger", "Kleines Mädchen", "Beschützer", "Prinz", "Älteste"];
  const roles = guideRoleKeys.map(k => ({
    icon: getRoleIcon(k), name: roleName(k), desc: roleDesc(k),
    team: k === "Werwolf" ? t("teamWolves") : t("teamVillage")
  }));

  const overlay = document.createElement("div");
  overlay.className = "guide-overlay";
  overlay.innerHTML = `
    <div class="guide-container glass-card" style="padding:2rem;">
      <div class="guide-header">
        <h2>${t("guideTitle")}</h2>
        <p style="opacity:0.7;">${t("guideSub")}</p>
      </div>

      <div class="guide-section">
        <h3>${t("guideGoal")}</h3>
        <p>${t("guideGoalText")}</p>
      </div>

      <div class="guide-section">
        <h3>${t("guidePhases")}</h3>
        <div class="guide-phase-flow">
          <div class="guide-phase-step"><span>🌙</span>${t("phaseNight")}</div>
          <span class="guide-phase-arrow">→</span>
          <div class="guide-phase-step"><span>☀️</span>${t("phaseDay")}</div>
          <span class="guide-phase-arrow">→</span>
          <div class="guide-phase-step"><span>🗳️</span>${t("phaseVote")}</div>
          <span class="guide-phase-arrow">→</span>
          <div class="guide-phase-step"><span>🔁</span>${t("phaseRepeat")}</div>
        </div>
        <p style="font-size:0.85rem; opacity:0.8; margin-top:0.5rem;">${t("guidePhaseText")}</p>
      </div>

      <div class="guide-section">
        <h3>${t("guideRoles")}</h3>
        <div class="guide-role-grid">
          ${roles.map(r => `
            <div class="guide-role-item">
              <div class="guide-role-icon">${r.icon}</div>
              <div class="guide-role-info">
                <strong>${r.name}</strong> <span style="font-size:0.7rem; opacity:0.5;">(${r.team})</span>
                <p>${r.desc}</p>
              </div>
            </div>
          `).join("")}
        </div>
      </div>

      <div class="guide-section">
        <h3>${t("guideTips")}</h3>
        <ul style="padding-left:1.2rem; font-size:0.85rem; line-height:1.8; opacity:0.85;">
          <li>${t("tip1")}</li>
          <li>${t("tip2")}</li>
          <li>${t("tip3")}</li>
          <li>${t("tip4")}</li>
          <li>${t("tip5")}</li>
        </ul>
      </div>

      <div style="text-align:center; margin-top:1.5rem;">
        <button class="glass-button" id="closeGuide">${t("understood")}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.querySelector("#closeGuide").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}

// ========== CHOICE MODAL (replaces prompt) ==========
function showChoiceModal(title, options, callback) {
  const overlay = document.createElement("div");
  overlay.className = "choice-modal-overlay";
  overlay.innerHTML = `
    <div class="glass-card" style="max-width:420px; width:90%; padding:2rem;">
      <h3 style="text-align:center;">${title}</h3>
      <div class="vote-grid" style="margin:1.2rem 0;">
        ${options.map(o => `<div class="vote-card choice-opt" data-value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</div>`).join("")}
      </div>
      <div style="text-align:center;">
        <button class="glass-button" id="choiceConfirm" disabled>${t("confirm")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  let selected = null;
  overlay.querySelectorAll(".choice-opt").forEach(c => c.addEventListener("click", function() {
    selected = this.dataset.value;
    overlay.querySelectorAll(".choice-opt").forEach(x => x.classList.remove("selected"));
    this.classList.add("selected");
    overlay.querySelector("#choiceConfirm").disabled = false;
  }));
  overlay.querySelector("#choiceConfirm").addEventListener("click", () => {
    overlay.remove();
    if (callback) callback(selected);
  });
}

// ========== CONFIRM MODAL (replaces native confirm()) ==========
function showConfirmModal(message, onConfirm) {
  const overlay = document.createElement("div");
  overlay.className = "choice-modal-overlay";
  overlay.innerHTML = `
    <div class="glass-card" style="max-width:380px; width:90%; padding:2rem; text-align:center;">
      <h3 style="margin-bottom:1rem;">${t("confirmTitle")}</h3>
      <p style="opacity:0.85; margin-bottom:1.5rem;">${message}</p>
      <div style="display:flex; gap:1rem; justify-content:center;">
        <button class="glass-button" id="confirmYes" style="background:rgba(239,68,68,0.6);">${t("yes")}</button>
        <button class="glass-button" id="confirmNo" style="background:rgba(255,255,255,0.1);">${t("cancel")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#confirmYes").addEventListener("click", () => { overlay.remove(); onConfirm(); });
  overlay.querySelector("#confirmNo").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}

// ========== CONFETTI ==========
function spawnConfetti() {
  const colors = ["#2563eb", "#3b82f6", "#60a5fa", "#38bdf8", "#7dd3fc", "#0ea5e9", "#93c5fd", "#22c55e"];
  for (let i = 0; i < 50; i++) {
    const el = document.createElement("div");
    el.className = "confetti-piece";
    el.style.left = Math.random() * 100 + "vw";
    el.style.background = colors[Math.floor(Math.random() * colors.length)];
    el.style.animationDelay = Math.random() * 1.5 + "s";
    el.style.animationDuration = (2 + Math.random() * 2) + "s";
    el.style.width = (6 + Math.random() * 8) + "px";
    el.style.height = (6 + Math.random() * 8) + "px";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
}

// ========== UI HELPERS ==========
function render(html) {
  if (viewTicker) { clearInterval(viewTicker); viewTicker = null; }
  ui.innerHTML = html;
  ui.classList.add("fade-transition");
  setTimeout(() => ui.classList.remove("fade-transition"), 500);
}

// Live "Xs" countdown into #phaseCountdown until the given deadline (cleared on next render()).
function startCountdown(deadline) {
  if (!deadline) return;
  const tick = () => {
    const el = document.getElementById("phaseCountdown");
    if (!el) return;
    const secs = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    el.textContent = secs + "s";
    // Pulse red when time is running out so players look up from the discussion.
    el.classList.toggle("countdown-urgent", secs <= 10);
  };
  tick();
  viewTicker = setInterval(tick, 1000);
}

// Ambient page tint per game phase (CSS reacts to body[data-phase]).
function setPhaseAmbience(lobby) {
  const phase = lobby && lobby.gameStarted ? lobby.phase : "";
  if (document.body.dataset.phase !== phase) document.body.dataset.phase = phase;
}

function showModal(contentHtml, onClose) {
  const modalDiv = document.createElement("div");
  modalDiv.className = "modal";
  modalDiv.innerHTML = `<div class="modal-content glass-card">${contentHtml}<div style="text-align:center; margin-top:1.5rem;"><button class="glass-button" id="modalClose">${t("close")}</button></div></div>`;
  document.body.appendChild(modalDiv);
  modalDiv.querySelector("#modalClose")?.addEventListener("click", () => { modalDiv.remove(); if(onClose) onClose(); });
  modalDiv.addEventListener("click", (e) => { if (e.target === modalDiv) { modalDiv.remove(); if(onClose) onClose(); } });
  return modalDiv;
}

function escapeHtml(str) { const d = document.createElement("div"); d.textContent = str; return d.innerHTML; }

// ========== ROLE DISPLAY ==========
function showRoleFor10Seconds(role, description) {
  const roleDisplay = document.getElementById("role-display");
  const roleIcon = document.getElementById("role-reveal-icon");
  document.getElementById("role-name").innerText = roleName(role);
  document.getElementById("role-description").innerHTML = description;
  const timerSpan = document.getElementById("role-timer");
  const timerFill = document.getElementById("role-timer-fill");
  roleDisplay.style.display = "flex";

  roleIcon.innerHTML = `<span style="font-size:3.5rem;">${getRoleIcon(role)}</span>`;

  let seconds = 10;
  timerSpan.innerText = seconds;
  timerFill.style.transition = "none";
  timerFill.style.width = "100%";
  requestAnimationFrame(() => {
    timerFill.style.transition = "width 10s linear";
    timerFill.style.width = "0%";
  });

  // Clear any previous reveal timers so an old countdown can't keep writing into the DOM.
  if (roleDisplayTimeout) clearTimeout(roleDisplayTimeout);
  if (roleDisplayInterval) clearInterval(roleDisplayInterval);
  roleDisplayInterval = setInterval(() => {
    seconds--;
    timerSpan.innerText = seconds;
    if (seconds <= 0) { clearInterval(roleDisplayInterval); roleDisplay.style.display = "none"; }
  }, 1000);
  roleDisplayTimeout = setTimeout(() => { clearInterval(roleDisplayInterval); roleDisplay.style.display = "none"; }, 10000);
}

// ========== SHUFFLE (Fisher-Yates) ==========
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ========== HEARTBEAT & INACTIVE CHECK ==========
// Host-only tick: drop long-inactive players AND drive phase timeouts so the game never freezes.
async function hostMaintenance(lobbyId) {
  if (!currentLobbyId || !firebaseReady) return;
  try {
    const lobbyRef = doc(db, "lobbies", lobbyId);
    const lobbySnap = await getDoc(lobbyRef);
    if (!lobbySnap.exists()) return;
    const lobby = { id: lobbySnap.id, ...lobbySnap.data() };
    const now = Date.now();
    const hb = lobby.heartbeats || {};

    if (lobby.hostId !== currentUser.id) {
      // Host failover: if the host's heartbeat is stale (hard crash, no beforeunload),
      // the first living non-host player promotes itself so the game can't freeze forever.
      // Only the deterministic successor writes, so all clients agree and there's no race.
      const hostHb = hb[lobby.hostId] || 0;
      if (now - hostHb > 120000) {
        const successor = lobby.players.find(p => p.id !== lobby.hostId);
        if (successor && successor.id === currentUser.id) {
          const newPlayers = lobby.players.filter(p => p.id !== lobby.hostId);
          if (newPlayers.length === 0) { await deleteDoc(lobbyRef); return; }
          await updateDoc(lobbyRef, { players: newPlayers, hostId: currentUser.id });
        }
      }
      return;
    }

    const inactive = lobby.players.filter(p => p.id !== currentUser.id && (!hb[p.id] || now - hb[p.id] > 120000));
    if (inactive.length > 0) {
      const newPlayers = lobby.players.filter(p => !inactive.some(i => i.id === p.id));
      if (newPlayers.length === 0) { await deleteDoc(lobbyRef); return; }
      await updateDoc(lobbyRef, { players: newPlayers });
      return; // next tick re-evaluates with the updated roster
    }

    if (lobby.mode === "online" && lobby.gameStarted) await checkAutomaticAdvance(lobby);
  } catch(e) { console.warn("hostMaintenance error", e); }
}

function startHeartbeat(lobbyId) {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  const sendHB = async () => {
    if (!currentLobbyId || !firebaseReady) return;
    try {
      await updateDoc(doc(db, "lobbies", currentLobbyId), { [`heartbeats.${currentUser.id}`]: Date.now() });
    } catch(e) {}
  };
  sendHB();
  heartbeatInterval = setInterval(sendHB, 30000);
}

function startInactiveCheck(lobbyId) {
  if (inactiveCheckInterval) clearInterval(inactiveCheckInterval);
  inactiveCheckInterval = setInterval(() => hostMaintenance(lobbyId), 12000);
}

// ========== LOBBY MANAGEMENT ==========
async function createLobby(playerName, isPublic, mode, settings) {
  if (!consentGiven || !firebaseReady || !isOnline) throw new Error(t("noConnection"));
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const lobbyRef = doc(db, "lobbies", code);
  const player = { id: currentUser.id, name: playerName, deviceId, isAlive: true, role: null, hasUsedAction: false, lastSeen: Date.now() };
  const isAutoNarrator = (mode === "online");
  await setDoc(lobbyRef, {
    code, hostId: currentUser.id, gameStarted: false, phase: "LOBBY", narratorStep: null,
    players: [player], isPublic, mode, settings,
    volunteerNarratorId: null, confirmedNarratorId: isAutoNarrator ? "AUTOMATIC" : null,
    actionData: defaultActionData(),
    votes: {}, nightActionsOrder: [], currentNightIndex: 0, lastUpdate: Date.now(),
    heartbeats: { [currentUser.id]: Date.now() }, chatClearedAt: Date.now(),
    firstNightDone: false, stepDeadline: 0
  });
  currentLobbyId = code;
  startHeartbeat(code);
  startInactiveCheck(code);
  attachListener(code);
}

function defaultActionData() {
  return {
    werewolfVotes: {}, seerTarget: null,
    witch: { usedHeal: false, usedPoison: false, healTarget: null, poisonTarget: null },
    smallGirlPeeked: false, peekResult: null, lovers: [],
    nightVictim: null, publicVotes: {},
    beschützerTarget: null, lastBeschützerTarget: null,
    elderSurvivedIds: [], princeSurvivedIds: [],
    witchDone: false, amorDone: false, beschützerDone: false,
    lastNightDeaths: [],
    pendingHunterId: null, hunterReturn: null, hunterUsedIds: []
  };
}

async function joinLobby(code, playerName) {
  if (!consentGiven || !firebaseReady || !isOnline) throw new Error(t("noConnection"));
  const q2 = query(collection(db, "lobbies"), where("code", "==", code));
  const snap = await getDocs(q2);
  if (snap.empty) throw new Error(t("lobbyNotFound"));
  const lobbyDoc = snap.docs[0];
  const data = lobbyDoc.data();

  if (data.lastUpdate && (Date.now() - data.lastUpdate > 5 * 60 * 1000)) {
    await deleteDoc(lobbyDoc.ref);
    throw new Error(t("lobbyExpired"));
  }

  if (data.gameStarted) throw new Error(t("gameRunning"));
  const existing = data.players.find(p => p.deviceId === deviceId);
  if (existing) {
    const updatedPlayers = data.players.map(p => p.deviceId === deviceId ? { ...p, name: playerName, lastSeen: Date.now(), isAlive: true } : p);
    await updateDoc(lobbyDoc.ref, { players: updatedPlayers });
    currentUser.id = existing.id;
    storageSet("ww_player_id", currentUser.id);
  } else {
    const newPlayer = { id: currentUser.id, name: playerName, deviceId, isAlive: true, role: null, hasUsedAction: false, lastSeen: Date.now() };
    await updateDoc(lobbyDoc.ref, { players: arrayUnion(newPlayer) });
  }
  currentLobbyId = code;
  startHeartbeat(code);
  startInactiveCheck(code);
  attachListener(code);
}

async function cleanupStaleLobbies(lobbies) {
  const now = Date.now();
  for (const lobby of lobbies) {
    if (lobby.lastUpdate && (now - lobby.lastUpdate > 5 * 60 * 1000)) {
      await deleteDoc(doc(db, "lobbies", lobby.code));
    }
  }
}

async function kickPlayer(lobbyId, playerIdToKick) {
  const lobbyRef = doc(db, "lobbies", lobbyId);
  const lobbySnap = await getDoc(lobbyRef);
  if (!lobbySnap.exists()) return;
  const lobby = lobbySnap.data();
  if (lobby.hostId !== currentUser.id) return;
  const newPlayers = lobby.players.filter(p => p.id !== playerIdToKick);
  await updateDoc(lobbyRef, { players: newPlayers });
}

async function leaveLobby(lobbyId, playerId) {
  const lobbyRef = doc(db, "lobbies", lobbyId);
  const lobbySnap = await getDoc(lobbyRef);
  if (!lobbySnap.exists()) return;
  const lobby = lobbySnap.data();
  let newPlayers = lobby.players.filter(p => p.id !== playerId);
  // Derive the host from the freshly loaded lobby, not the (possibly null) caller argument,
  // so the leaving host always hands off and the lobby never ends up host-less and frozen.
  const currentHostId = lobby.hostId;
  let newHostId = currentHostId;
  if (currentHostId === playerId && newPlayers.length > 0) newHostId = newPlayers[0].id;
  if (newPlayers.length === 0) await deleteDoc(lobbyRef);
  else await updateDoc(lobbyRef, { players: newPlayers, hostId: newHostId });
  if (playerId === currentUser.id) {
    currentLobbyId = null;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (inactiveCheckInterval) clearInterval(inactiveCheckInterval);
    if (viewTicker) { clearInterval(viewTicker); viewTicker = null; }
    if (unsubscribeLobby) { unsubscribeLobby(); unsubscribeLobby = null; }
    hideChat();
    showLobbyMenu();
  }
}

// ========== LISTENER ==========
function attachListener(lobbyId) {
  if (unsubscribeLobby) unsubscribeLobby();
  lastStateFingerprint = null;
  lastPhase = null;
  const lobbyRef = doc(db, "lobbies", lobbyId);
  unsubscribeLobby = onSnapshot(lobbyRef, async (snap) => {
    if (!snap.exists()) {
      // Detach so later writes to a recreated lobby with the same code can't fire this again.
      if (unsubscribeLobby) { unsubscribeLobby(); unsubscribeLobby = null; }
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (inactiveCheckInterval) clearInterval(inactiveCheckInterval);
      render(`<div class="glass-card" style="text-align:center;"><h2>${t("lobbyClosed")}</h2><p style="margin:1rem 0;">${t("lobbyClosedBody")}</p><button class="glass-button" id="backHome">${t("backToMenu")}</button></div>`);
      document.getElementById("backHome")?.addEventListener("click", () => { currentLobbyId = null; hideChat(); showLobbyMenu(); });
      hideChat();
      return;
    }
    const data = { id: snap.id, ...snap.data() };
    if (!data.players.find(p => p.id === currentUser.id)) {
      // Detach first — otherwise every further lobby update re-triggers this branch
      // and keeps yanking the user back to the menu with a repeated toast.
      if (unsubscribeLobby) { unsubscribeLobby(); unsubscribeLobby = null; }
      currentLobbyId = null;
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (inactiveCheckInterval) clearInterval(inactiveCheckInterval);
      hideChat();
      showLobbyMenu();
      showToast(t("removedFromLobby"), "warning");
      return;
    }

    chatClearedAt = data.chatClearedAt || 0;
    const player = data.players.find(p => p.id === currentUser.id);
    const newChannel = determineChatChannel(data, player);
    if (newChannel !== currentChatChannel) {
      currentChatChannel = newChannel;
      if (newChannel && data.mode === "online") {
        showChat(newChannel);
        if (!unsubscribeChat) attachChatListener(lobbyId);
      } else {
        hideChat();
      }
    }
    updateChatDisplay();

    // Phase transition animation
    if (data.gameStarted && data.phase !== lastPhase && lastPhase !== null) {
      showPhaseTransition(data.phase);
    }
    lastPhase = data.phase;

    const fp = stateFingerprint(data);
    if (fp === lastStateFingerprint) return;
    lastStateFingerprint = fp;

    if (data.gameStarted && data.phase !== "HUNTER") {
      const win = checkWinCondition(data.players, data.actionData?.lovers);
      if (win) { showWinScreen(win, data); return; }
    }
    renderByState(data);
    if (data.mode === "online" && data.gameStarted && data.hostId === currentUser.id) {
      checkAutomaticAdvance(data);
    }
  });
}

// ========== STATE FINGERPRINT ==========
function stateFingerprint(lobby) {
  return JSON.stringify({
    gameStarted: lobby.gameStarted, phase: lobby.phase, narratorStep: lobby.narratorStep,
    currentNightIndex: lobby.currentNightIndex, hostId: lobby.hostId,
    players: lobby.players?.map(p => `${p.id}:${p.name}:${p.isAlive}:${p.role}`),
    votes: lobby.votes, confirmedNarratorId: lobby.confirmedNarratorId,
    volunteerNarratorId: lobby.volunteerNarratorId, settings: lobby.settings,
    actionData: {
      wv: lobby.actionData?.werewolfVotes, st: lobby.actionData?.seerTarget,
      sgp: lobby.actionData?.smallGirlPeeked, w: lobby.actionData?.witch,
      nv: lobby.actionData?.nightVictim, bt: lobby.actionData?.beschützerTarget,
      wd: lobby.actionData?.witchDone, ad: lobby.actionData?.amorDone,
      bd: lobby.actionData?.beschützerDone, ph: lobby.actionData?.pendingHunterId
    }
  });
}

// ========== WIN CONDITION ==========
function checkWinCondition(players, lovers = []) {
  const alive = players.filter(p => p.isAlive && p.role !== "ERZÄHLER");
  if (alive.length === 0) return "DRAW"; // everyone died (e.g. mutual kill) → nobody wins
  // Lovers' win: only the two lovers remain and they are a mixed (wolf + non-wolf) couple.
  if (Array.isArray(lovers) && lovers.length === 2 && alive.length === 2 &&
      alive.every(p => lovers.includes(p.id))) {
    const roles = alive.map(p => p.role);
    const mixed = roles.includes("Werwolf") && roles.some(r => r !== "Werwolf");
    if (mixed) return "LOVERS";
  }
  const wolves = alive.filter(p => p.role === "Werwolf");
  const villagers = alive.filter(p => p.role !== "Werwolf");
  if (wolves.length === 0) return "VILLAGE";
  if (wolves.length >= villagers.length) return "WEREWOLF";
  return null;
}

function showWinScreen(winner, lobby) {
  currentRender = () => showWinScreen(winner, lobby);
  hideChat();
  document.body.dataset.phase = "";
  if (winner !== "DRAW") spawnConfetti();
  const emoji = { VILLAGE: "🏘️", WEREWOLF: "🐺", LOVERS: "💘", DRAW: "🤝" }[winner] || "🐺";
  const title = { VILLAGE: t("villageWins"), WEREWOLF: t("werewolfWins"), LOVERS: t("loversWin"), DRAW: t("drawTitle") }[winner] || t("werewolfWins");
  const desc = { VILLAGE: t("villageWinsDesc"), WEREWOLF: t("werewolfWinsDesc"), LOVERS: t("loversWinDesc"), DRAW: t("drawDesc") }[winner] || t("werewolfWinsDesc");
  const theme = { VILLAGE: "win-village", WEREWOLF: "win-wolf", LOVERS: "win-lovers", DRAW: "win-draw" }[winner] || "win-wolf";
  render(`<div class="glass-card win-screen ${theme}">
    <div class="win-rays"></div>
    <div class="win-emoji">${emoji}</div>
    <h1 class="win-title">${title}</h1>
    <p class="win-desc">${desc}</p>
    <div class="win-stand">
      <strong>${t("finalStand")}</strong>
      <div class="win-stand-tags">
        ${lobby.players.filter(p => p.role !== "ERZÄHLER").map((p, i) => `<span class="player-tag win-tag ${p.isAlive ? '' : 'dead'}" style="animation-delay:${0.15 + i * 0.08}s;">${getRoleIcon(p.role)} ${escapeHtml(p.name)} · ${roleName(p.role)} ${p.isAlive ? '✅' : '💀'}</span>`).join('')}
      </div>
    </div>
    <button class="glass-button btn-hero" id="backToMenu">${t("backToMenu")}</button>
  </div>`);
  document.getElementById("backToMenu")?.addEventListener("click", async () => {
    try { await deleteDoc(doc(db, "lobbies", lobby.id)); } catch(e) {}
    currentLobbyId = null; showLobbyMenu();
  });
}

// ========== CHAT SYSTEM ==========
function determineChatChannel(lobby, player) {
  if (!lobby || !player || lobby.mode === "lokal") return null;
  if (!lobby.gameStarted) return "public";
  if (!player.isAlive) return "dead";
  if (lobby.phase === "NIGHT") return player.role === "Werwolf" ? "wolf" : null;
  return "public";
}

function attachChatListener(lobbyId) {
  if (unsubscribeChat) unsubscribeChat();
  const messagesRef = collection(db, "lobbies", lobbyId, "messages");
  const q2 = query(messagesRef, orderBy("timestamp", "asc"));
  unsubscribeChat = onSnapshot(q2, (snap) => {
    chatMessages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    updateChatDisplay();
  });
}

function updateChatDisplay() {
  const container = document.getElementById("chat-messages");
  if (!container || !currentChatChannel) return;
  const visible = chatMessages.filter(m => m.channel === currentChatChannel && m.timestamp > chatClearedAt);
  if (visible.length === 0) {
    container.innerHTML = `<div class="chat-empty">${t("noMessages")}</div>`;
    return;
  }
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
  container.innerHTML = visible.map(m => {
    let cls = "chat-msg";
    if (m.senderId === currentUser.id) cls += " chat-msg-own";
    if (m.channel === "wolf") cls += " chat-msg-wolf";
    if (m.channel === "dead") cls += " chat-msg-dead";
    return `<div class="${cls}"><span class="chat-msg-name">${escapeHtml(m.senderName)}</span><span class="chat-msg-text">${escapeHtml(m.text)}</span></div>`;
  }).join("");
  if (wasAtBottom) container.scrollTop = container.scrollHeight;
}

async function sendChatMessage(text) {
  if (!text.trim() || !currentLobbyId || !currentChatChannel) return;
  try {
    await addDoc(collection(db, "lobbies", currentLobbyId, "messages"), {
      senderId: currentUser.id, senderName: currentUser.name,
      text: text.trim().substring(0, 200), timestamp: Date.now(), channel: currentChatChannel
    });
  } catch(e) { console.warn("Chat send error", e); }
}

function showChat(channel) {
  currentChatChannel = channel;
  const container = document.getElementById("chat-container");
  if (!container) return;
  container.style.display = "flex";
  container.style.animation = "none";
  void container.offsetWidth;
  container.style.animation = "chatSlideIn 0.4s cubic-bezier(0.2, 0.9, 0.3, 1.1)";
  const title = document.getElementById("chat-title");
  if (title) {
    if (channel === "wolf") title.textContent = t("wolfChat");
    else if (channel === "dead") title.textContent = t("ghostChat");
    else title.textContent = "💬 " + t("chat");
  }
  updateChatDisplay();
}

function hideChat() {
  currentChatChannel = null;
  const container = document.getElementById("chat-container");
  if (container && container.style.display !== "none") {
    container.style.animation = "chatSlideOut 0.3s ease forwards";
    setTimeout(() => { container.style.display = "none"; container.style.animation = ""; }, 300);
  }
  if (unsubscribeChat) { unsubscribeChat(); unsubscribeChat = null; }
}

// ========== AUTOMATIC ADVANCE (Online Mode) ==========
async function checkAutomaticAdvance(lobby) {
  if (phaseAdvancing) return;
  const { phase, narratorStep, players, actionData, votes, stepDeadline } = lobby;
  const timedOut = stepDeadline && Date.now() > stepDeadline;

  if (phase === "NIGHT") {
    let done = false;
    if (narratorStep === "AMOR") done = !hasAliveRole(players, "Amor") || actionData.amorDone;
    else if (narratorStep === "BESCHÜTZER") done = !hasAliveRole(players, "Beschützer") || actionData.beschützerDone;
    else if (narratorStep === "WEREWOLF") {
      const aliveWolves = players.filter(p => p.isAlive && p.role === "Werwolf");
      const wolfIds = new Set(aliveWolves.map(p => p.id));
      const wolfVoteCount = Object.keys(actionData.werewolfVotes || {}).filter(id => wolfIds.has(id)).length;
      done = aliveWolves.length === 0 || wolfVoteCount >= aliveWolves.length;
    }
    else if (narratorStep === "SMALL_GIRL") done = !hasAliveRole(players, "Kleines Mädchen") || actionData.smallGirlPeeked;
    else if (narratorStep === "SEER") done = !hasAliveRole(players, "Seherin") || !!actionData.seerTarget;
    else if (narratorStep === "WITCH") done = !hasAliveRole(players, "Hexe") || actionData.witchDone;
    else done = true;
    if (done || timedOut) await runLocked(() => advanceNightPhase(lobby));
  } else if (phase === "DAY") {
    if (timedOut) await runLocked(() => startVoting(lobby));
  } else if (phase === "VOTING") {
    const alivePlayers = players.filter(p => p.isAlive && p.role !== "ERZÄHLER");
    const aliveIds = new Set(alivePlayers.map(p => p.id));
    const voteCount = Object.keys(votes || {}).filter(id => aliveIds.has(id)).length;
    if (voteCount >= alivePlayers.length || timedOut) await runLocked(() => resolveVoting(lobby));
  } else if (phase === "HUNTER") {
    if (timedOut) await runLocked(() => resolveHunterShot(lobby, null));
  }
}

// DAY -> VOTING (used by auto-advance, narrator button, and host skip)
async function startVoting(lobby) {
  await updateDoc(doc(db, "lobbies", lobby.id), {
    phase: "VOTING", narratorStep: "VOTING", votes: {},
    chatClearedAt: Date.now(), stepDeadline: deadlineIn(VOTE_MS)
  });
}

function hasAliveRole(players, role) {
  return players.some(p => p.isAlive && p.role === role);
}

// ========== BUILD NIGHT ORDER ==========
function buildNightOrder(players, firstNightDone) {
  const roles = players.filter(p => p.isAlive).map(p => p.role);
  const order = [];
  if (!firstNightDone && roles.includes("Amor")) order.push("AMOR");
  if (roles.includes("Beschützer")) order.push("BESCHÜTZER");
  order.push("WEREWOLF");
  if (roles.includes("Kleines Mädchen")) order.push("SMALL_GIRL");
  if (roles.includes("Seherin")) order.push("SEER");
  if (roles.includes("Hexe")) order.push("WITCH");
  return order;
}

// ========== RENDER DISPATCHER ==========
function renderByState(lobby) {
  currentRender = () => renderByState(lobby);
  setPhaseAmbience(lobby);
  const players = lobby.players || [];
  const currentPlayer = players.find(p => p.id === currentUser.id);
  const isHost = (lobby.hostId === currentUser.id);
  const isHumanNarrator = (lobby.confirmedNarratorId === currentUser.id);

  if (!lobby.gameStarted) { renderLobbyView(lobby, isHost, currentPlayer); return; }

  // Show every player their secret role once when the game starts (not just the host).
  if (currentPlayer && currentPlayer.role && currentPlayer.role !== "ERZÄHLER") {
    const revealId = `${lobby.code}:${lobby.gameStartedAt || 0}:${currentPlayer.role}`;
    if (lastRevealId !== revealId) {
      lastRevealId = revealId;
      showRoleFor10Seconds(currentPlayer.role, roleDesc(currentPlayer.role));
    }
  }

  if (isHumanNarrator) renderNarratorDashboard(lobby);
  else if (currentPlayer) renderPlayerGameView(lobby, currentPlayer);
  else if (isHost) renderHostOnlyGameView(lobby);
  else render(`<div class="glass-card"><p>${t("observerMode")}</p><button class="glass-button" onclick="location.reload()">${t("reload")}</button></div>`);
}

function getNarratorScript(lobby) {
  const { phase, nightActionsOrder, currentNightIndex } = lobby;
  if (phase === "NIGHT") {
    const step = nightActionsOrder?.[currentNightIndex];
    if (step === "AMOR") return t("scriptAmor");
    if (step === "BESCHÜTZER") return t("scriptGuard");
    if (step === "WEREWOLF") return t("scriptWolf");
    if (step === "SMALL_GIRL") return t("scriptGirl");
    if (step === "SEER") return t("scriptSeer");
    if (step === "WITCH") return t("scriptWitch");
    return t("scriptNight");
  } else if (phase === "DAY") return t("scriptDay");
  else if (phase === "VOTING") return t("scriptVote");
  else if (phase === "HUNTER") return t("scriptHunter");
  return "";
}

// ========== HOST-ONLY GAME VIEW (fixed missing div) ==========
function renderHostOnlyGameView(lobby) {
  render(`
    <div class="glass-card">
      <h2>${t("observer")}</h2>
      <p style="margin:1rem 0; opacity:0.8;">${t("observerHost")}</p>
      <div style="margin-top:1.5rem; display:flex; gap:1rem; flex-wrap:wrap;">
        <button class="glass-button" id="leaveLobbyBtn">${t("leave")}</button>
        <button class="glass-button btn-danger" id="endGame">${t("endGame")}</button>
      </div>
    </div>
  `);
  document.getElementById("leaveLobbyBtn")?.addEventListener("click", () => leaveLobby(lobby.id, currentUser.id));
  document.getElementById("endGame")?.addEventListener("click", async () => { showConfirmModal(t("endGameConfirm"), async () => { await deleteDoc(doc(db,"lobbies",lobby.id)); hideChat(); showLobbyMenu(); }) });
}

// ========== LOBBY VIEW ==========
function renderLobbyView(lobby, isHost, currentPlayer) {
  const players = lobby.players;
  const playerCount = players.length;
  const MIN_PLAYERS = 4;
  const confirmedId = lobby.confirmedNarratorId;
  const activePlayerCount = players.length - (confirmedId && confirmedId !== "AUTOMATIC" && lobby.mode === "lokal" ? 1 : 0);

  let canStart = lobby.mode === "online"
    ? (activePlayerCount >= MIN_PLAYERS)
    : (activePlayerCount >= MIN_PLAYERS && confirmedId !== null);

  const volunteerId = lobby.volunteerNarratorId;
  const alreadyVolunteered = (volunteerId === currentUser.id);

  let volunteerSection = "";
  if (lobby.mode !== "online") {
    if (!confirmedId) {
      volunteerSection = alreadyVolunteered
        ? `<p style="color:var(--success);">${t("volunteered")}</p>`
        : `<button class="glass-button glass-button-small" id="volunteerBtn">${t("volunteerNarrator")}</button>`;
    } else {
      volunteerSection = `<p>${t("narratorIs")} <strong>${escapeHtml(players.find(p => p.id === confirmedId)?.name || '?')}</strong></p>`;
    }
  } else {
    volunteerSection = `<p>${t("autoNarrator")}</p>`;
  }

  let hostControls = "";
  if (isHost) {
    const volunteerPlayer = players.find(p => p.id === volunteerId);
    const narratorConfirmHtml = lobby.mode !== "online" && volunteerId
      ? `<p>${t("volunteer")} <strong>${escapeHtml(volunteerPlayer?.name || '?')}</strong> <button class="glass-button glass-button-small" id="confirmNarratorBtn">${t("confirm")}</button></p>`
      : lobby.mode !== "online" ? `<p style='opacity:0.6;'>${t("noVolunteer")}</p>` : "";

    const sett = lobby.settings || {};
    const enabledCount = Object.entries(sett).filter(([k,v]) => v !== false && k !== "Dorfbewohner").length + 2; // +2 for 2 wolves
    // Same count the start logic uses, so the balance hint can never disagree with startability.
    const roleBalanceClass = enabledCount > activePlayerCount ? 'color:var(--warning)' : 'color:var(--success)';
    const roleBalanceMsg = enabledCount > activePlayerCount
      ? t("rolesTooMany", { r: enabledCount, p: activePlayerCount })
      : t("rolesBalanced", { r: enabledCount, p: activePlayerCount });

    hostControls = `
      <div style="margin:1.2rem 0; padding:1.2rem; background:rgba(0,0,0,0.25); border-radius:1.2rem;">
        <h3 style="margin-bottom:0.8rem;">⚙️ ${lobby.mode === 'online' ? t("settings") : t("hostSettings")}</h3>
        ${narratorConfirmHtml}
        <div style="margin-top:0.8rem;"><strong>${t("rolesLabel")}</strong></div>
        <div class="roles-grid" id="roleToggles">${renderRoleToggles(lobby.settings || {})}</div>
        <p id="roleBalanceInfo" style="margin-top:0.5rem; font-size:0.8rem; ${roleBalanceClass}">${roleBalanceMsg}</p>
        <button class="glass-button glass-button-small" id="saveSettingsBtn" style="margin-top:0.8rem;">${t("save")}</button>
      </div>
    `;
  }

  const playersHtml = players.map(p => `
    <div class="player-tag">
      ${escapeHtml(p.name)} ${p.id === lobby.hostId ? '👑' : ''} ${p.id === confirmedId ? '🎙️' : ''}
      ${isHost && p.id !== currentUser.id ? `<button class="glass-button glass-button-small kick-btn" data-player-id="${p.id}" style="margin-left:0.5rem; background:rgba(239,68,68,0.6); padding:0.2rem 0.6rem; font-size:0.75rem;">✕</button>` : ''}
    </div>
  `).join("");

  let startHint = "";
  if (!canStart) {
    if (activePlayerCount < MIN_PLAYERS) startHint = t("needPlayers", { n: MIN_PLAYERS - activePlayerCount });
    else if (lobby.mode !== "online" && confirmedId === null) startHint = t("needNarrator");
  }

  render(`
    <div class="glass-card">
      <h2><i class="fas fa-door-open"></i> ${t("lobby")}: ${lobby.code}
        <span class="public-badge ${lobby.isPublic ? 'public' : 'private'}">${lobby.isPublic ? t("public") : t("private")}</span>
        <span style="margin-left:0.5rem; font-size:0.85rem;">${lobby.mode === 'online' ? '🌐 ' + t("online") : '🏠 ' + t("local")}</span>
      </h2>
      <div class="player-list">${playersHtml}</div>
      <div style="display:flex; align-items:center; gap:0.5rem;">👥 <strong>${playerCount}</strong> / ${MIN_PLAYERS}+ ${t("players")}</div>
      <div style="margin:0.8rem 0;">${volunteerSection}</div>
      ${hostControls}
      <div style="margin-top:1.5rem; display:flex; gap:1rem; flex-wrap:wrap; align-items:center;">
        ${isHost ? `<button class="glass-button" id="startGameBtn" ${!canStart ? 'disabled' : ''}>${t("startGame")}</button>${startHint ? `<span style="font-size:0.8rem; opacity:0.6;">${startHint}</span>` : ''}` : ''}
        <button class="glass-button" id="leaveLobbyBtn" style="background:rgba(255,255,255,0.1);">${t("leave")}</button>
      </div>
    </div>
  `);

  document.querySelectorAll(".kick-btn").forEach(btn => btn.addEventListener("click", (e) => { e.stopPropagation(); kickPlayer(lobby.id, btn.dataset.playerId); }));
  if (lobby.mode !== "online" && !confirmedId && !alreadyVolunteered) {
    document.getElementById("volunteerBtn")?.addEventListener("click", async () => { await updateDoc(doc(db, "lobbies", lobby.id), { volunteerNarratorId: currentUser.id }); });
  }
  if (isHost && lobby.mode !== "online" && volunteerId) {
    document.getElementById("confirmNarratorBtn")?.addEventListener("click", async () => { await updateDoc(doc(db, "lobbies", lobby.id), { confirmedNarratorId: volunteerId }); });
  }
  if (isHost) {
    document.getElementById("saveSettingsBtn")?.addEventListener("click", async () => {
      const newSettings = {};
      document.querySelectorAll(".role-card").forEach(card => { newSettings[card.dataset.role] = card.classList.contains("selected"); });
      LOCKED_ROLES.forEach(r => newSettings[r] = true);
      await updateDoc(doc(db, "lobbies", lobby.id), { settings: newSettings });
      showToast(t("saved"), "success");
    });
    bindRoleToggleClicks(document);
  }
  document.getElementById("startGameBtn")?.addEventListener("click", () => startGame(lobby));
  document.getElementById("leaveLobbyBtn")?.addEventListener("click", () => leaveLobby(lobby.id, currentUser.id));
}

const LOCKED_ROLES = ["Dorfbewohner", "Werwolf"];

function renderRoleToggles(settings) {
  const allRoles = [
    { name: "Dorfbewohner", icon: "fa-user" },
    { name: "Werwolf", icon: "fa-paw" },
    { name: "Seherin", icon: "fa-eye" },
    { name: "Hexe", icon: "fa-flask" },
    { name: "Amor", icon: "fa-heart" },
    { name: "Jäger", icon: "fa-crosshairs" },
    { name: "Kleines Mädchen", icon: "fa-child" },
    { name: "Beschützer", icon: "fa-shield-alt" },
    { name: "Prinz", icon: "fa-crown" },
    { name: "Älteste", icon: "fa-hat-wizard" },
  ];
  return allRoles.map(r => {
    const locked = LOCKED_ROLES.includes(r.name);
    const selected = locked || settings[r.name] !== false;
    return `<div class="role-card ${selected ? 'selected' : ''} ${locked ? 'locked' : ''}" data-role="${r.name}" ${locked ? `title="${t("lockedRole")}"` : ''}><i class="fas ${r.icon}"></i> ${roleName(r.name)}${locked ? ' <i class="fas fa-lock" style="font-size:0.65rem; opacity:0.6;"></i>' : ''}</div>`;
  }).join("");
}

function bindRoleToggleClicks(container) {
  container.querySelectorAll(".role-card").forEach(card => {
    card.addEventListener("click", () => {
      if (LOCKED_ROLES.includes(card.dataset.role)) {
        showToast(t("lockedRoleToast", { role: roleName(card.dataset.role) }), "warning");
        return;
      }
      card.classList.toggle("selected");
    });
  });
}

// ========== START GAME ==========
async function startGame(lobby) {
  const { id: lobbyCode, players: playersArr, settings, confirmedNarratorId, mode } = lobby;

  let playersToAssign = [...playersArr];
  if (mode === "lokal" && confirmedNarratorId && confirmedNarratorId !== "AUTOMATIC") {
    playersToAssign = playersToAssign.filter(p => p.id !== confirmedNarratorId);
  }

  if (playersToAssign.length < 4) {
    showToast(t("minPlayers"), "error");
    return;
  }

  const numPlayers = playersToAssign.length;

  // Optional special roles (one each if enabled).
  const optionalRoles = [];
  if (settings.Seherin !== false) optionalRoles.push("Seherin");
  if (settings.Hexe !== false) optionalRoles.push("Hexe");
  if (settings.Amor !== false) optionalRoles.push("Amor");
  if (settings.Jäger !== false) optionalRoles.push("Jäger");
  if (settings["Kleines Mädchen"] !== false) optionalRoles.push("Kleines Mädchen");
  if (settings.Beschützer !== false) optionalRoles.push("Beschützer");
  if (settings.Prinz !== false) optionalRoles.push("Prinz");
  if (settings["Älteste"] !== false) optionalRoles.push("Älteste");

  // Build a pool of EXACTLY numPlayers roles. Werewolves are mandatory and added first so they
  // can never be squeezed out when more roles are enabled than there are players (which previously
  // could produce a game with zero werewolves → instant village win).
  const wolfCount = Math.min(2, numPlayers);
  const rolePool = [];
  for (let i = 0; i < wolfCount; i++) rolePool.push("Werwolf");
  // Add optional roles in random order, only as many as fit, so dropped roles are random and fair.
  for (const r of shuffle(optionalRoles)) {
    if (rolePool.length >= numPlayers) break;
    rolePool.push(r);
  }
  while (rolePool.length < numPlayers) rolePool.push("Dorfbewohner");

  const shuffledRoles = shuffle(rolePool);

  const assigned = playersArr.map(p => {
    const assignIdx = playersToAssign.findIndex(pa => pa.id === p.id);
    if (assignIdx !== -1) {
      return { ...p, role: shuffledRoles[assignIdx % shuffledRoles.length], isAlive: true };
    }
    return { ...p, role: "ERZÄHLER", isAlive: true };
  });

  // Unique per game so a player who gets the same role in the next round of the
  // same lobby still sees the reveal (the reveal key used to be code:role only).
  const gameStartedAt = Date.now();

  const myData = assigned.find(p => p.id === currentUser.id);
  if (myData && myData.role !== "ERZÄHLER") {
    lastRevealId = `${lobbyCode}:${gameStartedAt}:${myData.role}`;
    showRoleFor10Seconds(myData.role, roleDesc(myData.role));
  }

  const nightOrder = buildNightOrder(assigned, false);

  await updateDoc(doc(db, "lobbies", lobbyCode), {
    gameStarted: true, phase: "NIGHT", players: assigned,
    actionData: defaultActionData(), gameStartedAt,
    nightActionsOrder: nightOrder, currentNightIndex: 0,
    narratorStep: nightOrder[0], votes: {},
    chatClearedAt: Date.now(), firstNightDone: false,
    stepDeadline: deadlineIn(NIGHT_STEP_MS)
  });
}

// ========== NARRATOR DASHBOARD ==========
function renderNarratorDashboard(lobby) {
  const { phase, players, actionData, votes, id } = lobby;
  const script = getNarratorScript(lobby);

  let liveVotesHtml = "";
  if (phase === "NIGHT" && lobby.narratorStep === "WEREWOLF") {
    const wv = actionData.werewolfVotes || {};
    const entries = Object.entries(wv);
    liveVotesHtml = `<div class="vote-detail-list"><strong>${t("wolfVotes")}</strong>${entries.length ? entries.map(([pid, tid]) => `<div class="vote-detail-item"><span>${escapeHtml(players.find(p=>p.id===pid)?.name||"?")}</span><span>→ ${escapeHtml(players.find(p=>p.id===tid)?.name||"?")}</span></div>`).join("") : `<div style="opacity:0.5;">${t("waitingVotes")}</div>`}</div>`;
  } else if (phase === "VOTING") {
    const v = votes || {};
    const entries = Object.entries(v);
    liveVotesHtml = `<div class="vote-detail-list"><strong>${t("votingLabel")}</strong>${entries.length ? entries.map(([pid, tid]) => `<div class="vote-detail-item"><span>${escapeHtml(players.find(p=>p.id===pid)?.name||"?")}</span><span>→ ${escapeHtml(players.find(p=>p.id===tid)?.name||"?")}</span></div>`).join("") : `<div style="opacity:0.5;">${t("waitingVotes")}</div>`}</div>`;
  }

  // Local mode: the narrator picks the hunter's target on behalf of the dead hunter.
  let hunterHtml = "";
  if (phase === "HUNTER") {
    const pendingId = actionData?.pendingHunterId;
    const hunterName = players.find(p => p.id === pendingId)?.name || roleName("Jäger");
    const targets = players.filter(p => p.isAlive && p.role !== "ERZÄHLER" && p.id !== pendingId);
    hunterHtml = `<div class="vote-detail-list"><strong>${t("narratorHunter", { name: escapeHtml(hunterName) })}</strong>
      <div class="vote-grid" id="narratorHunterTargets" style="margin-top:0.6rem;">${targets.map(tp => `<div class="vote-card" data-id="${tp.id}">${escapeHtml(tp.name)}</div>`).join('')}</div>
      <button class="glass-button" id="narratorHunterSkip" style="margin-top:0.6rem; background:rgba(255,255,255,0.1);">${t("narratorHunterSkip")}</button>
    </div>`;
  }

  render(`
    <div class="glass-card">
      <h2><i class="fas fa-torah"></i> ${t("narratorConsole")} — ${lobby.code}</h2>
      <div class="narrator-script"><i class="fas fa-microphone-alt"></i> <strong>${t("script")}</strong><br/>${script}</div>
      <div style="margin:1rem 0;"><strong>${t("rolesOverview")}</strong><br/>
        ${players.map(p => `<span class="player-tag ${p.isAlive ? '' : 'dead'}">${escapeHtml(p.name)}: ${roleName(p.role)}</span>`).join(' ')}
      </div>
      <div><strong>${t("aliveLabel")}</strong> ${players.filter(p=>p.isAlive && p.role !== "ERZÄHLER").map(p=>escapeHtml(p.name)).join(', ')}</div>
      ${liveVotesHtml}
      ${hunterHtml}
      <div style="margin-top:1.5rem; display:flex; gap:1rem; flex-wrap:wrap;">
        ${phase !== "HUNTER" ? `<button class="glass-button" id="narratorNext">${t("phaseNext")}</button>` : ""}
        <button class="glass-button" id="leaveLobbyBtn" style="background:rgba(255,255,255,0.1);">${t("leave")}</button>
        <button class="glass-button btn-danger" id="endGame">${t("endGame")}</button>
      </div>
    </div>
  `);

  document.getElementById("narratorNext")?.addEventListener("click", async () => {
    if (phase === "NIGHT") await runLocked(() => advanceNightPhase(lobby));
    else if (phase === "DAY") await runLocked(() => startVoting(lobby));
    else if (phase === "VOTING") await runLocked(() => resolveVoting(lobby));
  });
  if (phase === "HUNTER") {
    let hsel = null;
    document.querySelectorAll("#narratorHunterTargets .vote-card").forEach(c => c.addEventListener("click", function() {
      hsel = this.dataset.id;
      document.querySelectorAll("#narratorHunterTargets .vote-card").forEach(x => x.classList.remove("selected"));
      this.classList.add("selected");
      setTimeout(() => runLocked(() => resolveHunterShot(lobby, hsel)), 250);
    }));
    document.getElementById("narratorHunterSkip")?.addEventListener("click", () => runLocked(() => resolveHunterShot(lobby, null)));
  }
  document.getElementById("leaveLobbyBtn")?.addEventListener("click", () => leaveLobby(id, currentUser.id));
  document.getElementById("endGame")?.addEventListener("click", async () => { showConfirmModal(t("endGameConfirm"), async () => { await deleteDoc(doc(db,"lobbies",lobby.id)); hideChat(); showLobbyMenu(); }) });
}

// ========== NIGHT PHASE ADVANCE ==========
function nightActionResetFields() {
  return {
    "actionData.werewolfVotes": {}, "actionData.seerTarget": null,
    "actionData.smallGirlPeeked": false, "actionData.witchDone": false,
    "actionData.beschützerDone": false, "actionData.amorDone": false
  };
}

// Returns id of a freshly-dead Jäger who can still take a target with him, else null.
// All hunters that just died and still owe a shot (there can be several in one resolution,
// e.g. wolves kill one hunter while the witch poisons another).
function collectPendingHunters(players, deaths, hunterUsedIds) {
  const res = [];
  for (const id of deaths) {
    const d = players.find(p => p.id === id);
    if (d && d.role === "Jäger" && !hunterUsedIds.includes(id) && !res.includes(id)) {
      if (players.some(p => p.isAlive && p.role !== "ERZÄHLER" && p.id !== id)) res.push(id);
    }
  }
  return res;
}

async function advanceNightPhase(lobby) {
  const { id, nightActionsOrder, currentNightIndex } = lobby;
  const step = nightActionsOrder[currentNightIndex];

  if (step === "WEREWOLF") await resolveWerewolfKill(lobby);

  const nextIdx = currentNightIndex + 1;
  if (nextIdx >= nightActionsOrder.length) {
    // Re-read so we have the victim/witch/beschützer data written during the night.
    const snap = await getDoc(doc(db, "lobbies", id));
    if (snap.exists() && snap.data().phase === "NIGHT") await resolveNightDeath({ id, ...snap.data() });
  } else {
    // Transaction with an index guard: during a host handoff two clients can briefly both
    // believe they're the host — without the guard the step counter would jump twice.
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "lobbies", id);
        const fresh = await tx.get(ref);
        if (!fresh.exists()) return;
        const d = fresh.data();
        if (d.phase !== "NIGHT" || d.currentNightIndex !== currentNightIndex) return; // already advanced
        tx.update(ref, {
          currentNightIndex: nextIdx, narratorStep: nightActionsOrder[nextIdx],
          stepDeadline: deadlineIn(NIGHT_STEP_MS)
        });
      });
    } catch (e) { console.warn("advanceNightPhase tx failed", e); }
  }
}

async function resolveWerewolfKill(lobby) {
  const votes = lobby.actionData?.werewolfVotes || {};
  const aliveWolfIds = new Set(lobby.players.filter(p => p.isAlive && p.role === "Werwolf").map(p => p.id));
  const aliveIds = new Set(lobby.players.filter(p => p.isAlive).map(p => p.id));
  const counts = {};
  // Only count votes cast by living wolves and targeting a living player.
  Object.entries(votes).forEach(([voter, target]) => {
    if (aliveWolfIds.has(voter) && aliveIds.has(target)) counts[target] = (counts[target] || 0) + 1;
  });
  // Highest-voted target wins; ties are broken randomly so the first wolf to vote isn't favoured.
  let max = 0;
  for (const c of Object.values(counts)) if (c > max) max = c;
  const top = Object.keys(counts).filter(id => counts[id] === max);
  const maxId = top.length ? top[Math.floor(Math.random() * top.length)] : null;
  if (maxId) {
    await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.nightVictim": maxId });
  }
}

async function resolveNightDeath(lobby) {
  let victim = lobby.actionData?.nightVictim;
  const witch = lobby.actionData?.witch || {};
  const beschützerTarget = lobby.actionData?.beschützerTarget;
  const elderSurvivedIds = lobby.actionData?.elderSurvivedIds || [];

  // Witch heal
  if (witch.healTarget === victim) victim = null;
  // Witch poison (additional death)
  const poisonVictim = witch.poisonTarget || null;
  // Beschützer protection
  if (victim && beschützerTarget === victim) victim = null;
  // Älteste survival — recorded in the final write below so the resolution stays atomic.
  let elderSurvived = false;
  if (victim) {
    const victimPlayer = lobby.players.find(p => p.id === victim);
    if (victimPlayer?.role === "Älteste" && !elderSurvivedIds.includes(victim)) {
      elderSurvivedIds.push(victim);
      elderSurvived = true;
      showToast(t("elderSurvived"), "info");
      victim = null;
    }
  }

  let players = [...lobby.players];
  const deaths = [];

  if (victim) {
    players = players.map(p => p.id === victim ? { ...p, isAlive: false } : p);
    deaths.push(victim);
  }
  if (poisonVictim) {
    players = players.map(p => p.id === poisonVictim ? { ...p, isAlive: false } : p);
    deaths.push(poisonVictim);
  }

  // Lovers death
  const lovers = lobby.actionData?.lovers || [];
  for (const deadId of deaths) {
    if (lovers.includes(deadId)) {
      const otherId = lovers.find(l => l !== deadId);
      if (otherId) {
        const other = players.find(p => p.id === otherId);
        if (other?.isAlive) {
          players = players.map(p => p.id === otherId ? { ...p, isAlive: false } : p);
          deaths.push(otherId);
        }
      }
    }
  }

  const deathNames = deaths.map(id => players.find(p => p.id === id)?.name || "?");
  const witchUpdate = { usedHeal: witch.usedHeal || !!witch.healTarget, usedPoison: witch.usedPoison || !!witch.poisonTarget, healTarget: null, poisonTarget: null };
  const elderUpdate = elderSurvived ? { "actionData.elderSurvivedIds": elderSurvivedIds } : {};
  const hunterUsedIds = lobby.actionData?.hunterUsedIds || [];
  const pendingHunters = collectPendingHunters(players, deaths, hunterUsedIds);

  // Dead hunters still shoot: pause in the HUNTER phase until each picks (works for any player,
  // not just the host). Several hunters can be queued if they died the same night.
  if (pendingHunters.length) {
    const [head, ...rest] = pendingHunters;
    await updateDoc(doc(db, "lobbies", lobby.id), {
      players, phase: "HUNTER", narratorStep: "HUNTER", stepDeadline: deadlineIn(HUNTER_MS),
      "actionData.nightVictim": null,
      "actionData.lastNightDeaths": deathNames,
      "actionData.witch": witchUpdate,
      "actionData.lastBeschützerTarget": beschützerTarget,
      "actionData.beschützerTarget": null,
      "actionData.pendingHunterId": head,
      "actionData.pendingHunterQueue": rest,
      "actionData.hunterReturn": "DAY",
      ...elderUpdate
    });
    return;
  }

  const nightOrder = buildNightOrder(players, true);
  await updateDoc(doc(db, "lobbies", lobby.id), {
    players, phase: "DAY", narratorStep: "DAY", chatClearedAt: Date.now(),
    firstNightDone: true, nightActionsOrder: nightOrder, stepDeadline: deadlineIn(DAY_MS),
    "actionData.nightVictim": null,
    "actionData.lastNightDeaths": deathNames,
    "actionData.witch": witchUpdate,
    "actionData.lastBeschützerTarget": beschützerTarget,
    "actionData.beschützerTarget": null,
    ...elderUpdate,
    ...nightActionResetFields()
  });
}

// Start a fresh night after the day. extra = additional actionData fields to merge.
async function goToNightFromVote(lobby, players, extra = {}) {
  const nightOrder = buildNightOrder(players, true);
  await updateDoc(doc(db, "lobbies", lobby.id), {
    players, phase: "NIGHT", currentNightIndex: 0, narratorStep: nightOrder[0],
    nightActionsOrder: nightOrder, votes: {}, chatClearedAt: Date.now(),
    stepDeadline: deadlineIn(NIGHT_STEP_MS), "actionData.werewolfVotes": {},
    ...extra
  });
}

async function resolveVoting(lobby) {
  // Fresh read + phase guard: a second resolver (dual host during failover, or a late
  // timeout) must not execute the lynch twice on stale data.
  const freshSnap = await getDoc(doc(db, "lobbies", lobby.id));
  if (!freshSnap.exists() || freshSnap.data().phase !== "VOTING") return;
  lobby = { id: lobby.id, ...freshSnap.data() };

  const votes = lobby.votes || {};
  const aliveIds = new Set(lobby.players.filter(p => p.isAlive && p.role !== "ERZÄHLER").map(p => p.id));
  const counts = {};
  // Only count votes from living players targeting a living player (ignore leavers' stale votes).
  Object.entries(votes).forEach(([voter, target]) => {
    if (aliveIds.has(voter) && aliveIds.has(target)) counts[target] = (counts[target] || 0) + 1;
  });

  // Find the clear leader. A tie (or no votes) means nobody is executed.
  let maxId = null, max = 0, tie = false;
  for (const [id, c] of Object.entries(counts)) {
    if (c > max) { max = c; maxId = id; tie = false; }
    else if (c === max) tie = true;
  }

  if (!maxId || tie) {
    showToast(maxId ? t("tieNoExec") : t("noVotesNoExec"), "info");
    await goToNightFromVote(lobby, [...lobby.players]);
    return;
  }

  let players = [...lobby.players];
  const princeSurvivedIds = lobby.actionData?.princeSurvivedIds || [];
  const target = players.find(p => p.id === maxId);

  // Prince survives his first execution.
  if (target?.role === "Prinz" && !princeSurvivedIds.includes(maxId)) {
    princeSurvivedIds.push(maxId);
    showToast(t("princeSurvived", { name: target.name }), "info");
    await goToNightFromVote(lobby, players, { "actionData.princeSurvivedIds": princeSurvivedIds });
    return;
  }

  players = players.map(p => p.id === maxId ? { ...p, isAlive: false } : p);
  const deaths = [maxId];

  // Lovers die together.
  const lovers = lobby.actionData?.lovers || [];
  if (lovers.includes(maxId)) {
    const other = lovers.find(l => l !== maxId);
    const otherPlayer = other && players.find(p => p.id === other);
    if (otherPlayer?.isAlive) {
      players = players.map(p => p.id === other ? { ...p, isAlive: false } : p);
      deaths.push(other);
    }
  }

  const hunterUsedIds = lobby.actionData?.hunterUsedIds || [];
  const pendingHunters = collectPendingHunters(players, deaths, hunterUsedIds);
  if (pendingHunters.length) {
    const [head, ...rest] = pendingHunters;
    await updateDoc(doc(db, "lobbies", lobby.id), {
      players, phase: "HUNTER", narratorStep: "HUNTER", stepDeadline: deadlineIn(HUNTER_MS),
      "actionData.pendingHunterId": head, "actionData.pendingHunterQueue": rest, "actionData.hunterReturn": "NIGHT"
    });
    return;
  }

  await goToNightFromVote(lobby, players);
}

// Resolve the hunter's dying shot. targetId null = he shoots nobody (or timed out).
async function resolveHunterShot(lobby, targetId) {
  // Fresh read + guard so a timeout firing right after the hunter clicked (or a second
  // host) can't resolve the same shot twice.
  const freshSnap = await getDoc(doc(db, "lobbies", lobby.id));
  if (!freshSnap.exists() || freshSnap.data().phase !== "HUNTER") return;
  const freshData = { id: lobby.id, ...freshSnap.data() };
  if (freshData.actionData?.pendingHunterId !== lobby.actionData?.pendingHunterId) return;
  lobby = freshData;

  const pendingId = lobby.actionData?.pendingHunterId;
  if (!pendingId) return;
  const hunterReturn = lobby.actionData?.hunterReturn || "DAY";
  const hunterUsedIds = [...(lobby.actionData?.hunterUsedIds || []), pendingId];
  let players = [...lobby.players];
  const deaths = [];
  const extraDeathNames = [];

  const target = targetId && players.find(p => p.id === targetId);
  if (target?.isAlive && target.role !== "ERZÄHLER") {
    players = players.map(p => p.id === targetId ? { ...p, isAlive: false } : p);
    deaths.push(targetId);
    extraDeathNames.push(target.name);
    // Hunter's victim may be a lover -> chain death.
    const lovers = lobby.actionData?.lovers || [];
    if (lovers.includes(targetId)) {
      const other = lovers.find(l => l !== targetId);
      const otherPlayer = other && players.find(p => p.id === other);
      if (otherPlayer?.isAlive) {
        players = players.map(p => p.id === other ? { ...p, isAlive: false } : p);
        deaths.push(other);
        extraDeathNames.push(otherPlayer.name);
      }
    }
  }

  // More hunters may be waiting: those queued from the original resolution plus any new
  // hunter this shot just killed. Stay in HUNTER until everyone has fired.
  const queue = lobby.actionData?.pendingHunterQueue || [];
  const newlyDead = collectPendingHunters(players, deaths, hunterUsedIds);
  const combinedQueue = [...queue, ...newlyDead].filter((id, i, a) => a.indexOf(id) === i && !hunterUsedIds.includes(id));
  if (combinedQueue.length) {
    const [next, ...rest] = combinedQueue;
    const prevDeaths = lobby.actionData?.lastNightDeaths || [];
    await updateDoc(doc(db, "lobbies", lobby.id), {
      players, phase: "HUNTER", narratorStep: "HUNTER", stepDeadline: deadlineIn(HUNTER_MS),
      "actionData.pendingHunterId": next, "actionData.pendingHunterQueue": rest,
      "actionData.hunterUsedIds": hunterUsedIds,
      "actionData.lastNightDeaths": [...prevDeaths, ...extraDeathNames]
    });
    return;
  }

  if (hunterReturn === "NIGHT") {
    await goToNightFromVote(lobby, players, {
      "actionData.pendingHunterId": null, "actionData.pendingHunterQueue": [], "actionData.hunterReturn": null,
      "actionData.hunterUsedIds": hunterUsedIds
    });
    return;
  }

  // Return to DAY, adding the hunter's kills to the morning announcement.
  const nightOrder = buildNightOrder(players, true);
  const deathNames = [...(lobby.actionData?.lastNightDeaths || []), ...extraDeathNames];
  await updateDoc(doc(db, "lobbies", lobby.id), {
    players, phase: "DAY", narratorStep: "DAY", chatClearedAt: Date.now(),
    firstNightDone: true, nightActionsOrder: nightOrder, stepDeadline: deadlineIn(DAY_MS),
    "actionData.lastNightDeaths": deathNames,
    "actionData.pendingHunterId": null, "actionData.pendingHunterQueue": [], "actionData.hunterReturn": null,
    "actionData.hunterUsedIds": hunterUsedIds,
    ...nightActionResetFields()
  });
}

// ========== PLAYER GAME VIEW ==========
function renderPlayerGameView(lobby, player) {
  const isHost = (lobby.hostId === currentUser.id);
  const scriptContent = `<div class="narrator-script" style="margin-bottom:1rem;"><i class="fas fa-volume-up"></i> <strong>Status:</strong><br/>${getNarratorScript(lobby)}</div>`;

  const baseHeader = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; flex-wrap:wrap; gap:0.5rem;">
      <span class="player-tag" style="background:rgba(37,99,235,0.25); border:1px solid var(--purple); border-left:3px solid var(--purple);">
        ${getRoleIcon(player.role)} ${roleName(player.role)}
      </span>
      <div style="display:flex; gap:0.5rem;">
        <button class="glass-button glass-button-small" id="leaveLobbyBtn" style="background:rgba(255,255,255,0.1);">${t("leave")}</button>
        ${isHost ? `<button class="glass-button glass-button-small btn-danger" id="endGameHost">${t("endGame")}</button>` : ''}
      </div>
    </div>
    ${scriptContent}
  `;

  const attachBaseListeners = () => {
    document.getElementById("leaveLobbyBtn")?.addEventListener("click", () => leaveLobby(lobby.id, currentUser.id));
    document.getElementById("endGameHost")?.addEventListener("click", async () => { showConfirmModal(t("endGameConfirm"), async () => { await deleteDoc(doc(db,"lobbies",lobby.id)); hideChat(); showLobbyMenu(); }) });
  };

  // HUNTER phase – the dead hunter picks (handled before the generic "you are dead" view).
  if (lobby.phase === "HUNTER") {
    const pendingId = lobby.actionData?.pendingHunterId;
    if (pendingId === player.id) {
      const targets = lobby.players.filter(p => p.isAlive && p.role !== "ERZÄHLER" && p.id !== player.id);
      render(`
        <div class="glass-card">
          ${baseHeader}
          <h2>${t("hunterTitle")}</h2>
          <p style="opacity:0.8; margin-bottom:1rem;">${t("hunterHint")}</p>
          <div class="vote-grid" id="hunterTargets">${targets.map(tg => `<div class="vote-card" data-id="${tg.id}">${escapeHtml(tg.name)}</div>`).join('')}</div>
          <button class="glass-button" id="hunterSubmit" disabled style="margin-top:0.5rem;">${t("hunterTake")}</button>
          <button class="glass-button" id="hunterSkip" style="background:rgba(255,255,255,0.1); margin-top:0.5rem;">${t("hunterNone")}</button>
        </div>
      `);
      let sel = null;
      document.querySelectorAll("#hunterTargets .vote-card").forEach(c => c.addEventListener("click", function() {
        sel = this.dataset.id;
        document.querySelectorAll("#hunterTargets .vote-card").forEach(x => x.classList.remove("selected"));
        this.classList.add("selected");
        document.getElementById("hunterSubmit").disabled = false;
      }));
      document.getElementById("hunterSubmit")?.addEventListener("click", () => { if (sel) runLocked(() => resolveHunterShot(lobby, sel)); });
      document.getElementById("hunterSkip")?.addEventListener("click", () => runLocked(() => resolveHunterShot(lobby, null)));
      attachBaseListeners();
      return;
    }
    const hunterName = lobby.players.find(p => p.id === pendingId)?.name || roleName("Jäger");
    render(`<div class="glass-card">${baseHeader}<h2>${t("hunterKilled", { name: escapeHtml(hunterName) })}</h2><p style="text-align:center; padding:1.5rem 0;">${t("hunterShooting")}</p></div>`);
    attachBaseListeners();
    return;
  }

  if (!player.isAlive) {
    render(`
      <div class="glass-card">
        <h2>${t("youAreDead")}</h2>
        ${scriptContent}
        <p style="opacity:0.7;">${t("deadHint")}</p>
        <div style="margin-top:1.5rem; display:flex; gap:1rem; flex-wrap:wrap;">
          <button class="glass-button" id="leaveLobbyBtn" style="background:rgba(255,255,255,0.1);">${t("leave")}</button>
          ${isHost ? `<button class="glass-button btn-danger" id="endGameHost">${t("endGame")}</button>` : ''}
        </div>
      </div>
    `);
    attachBaseListeners();
    return;
  }

  const { phase, narratorStep, players } = lobby;

  if (phase === "NIGHT") {
    // AMOR first night
    if (narratorStep === "AMOR" && player.role === "Amor") {
      const others = players.filter(p => p.isAlive && p.id !== player.id && p.role !== "ERZÄHLER");
      render(`
        <div class="glass-card">
          ${baseHeader}
          <h2>${t("amorTitle")}</h2>
          <p style="opacity:0.7; margin-bottom:1rem;">${t("amorHint")}</p>
          <div class="vote-grid" id="amorTargets">${others.map(o=>`<div class="vote-card" data-id="${o.id}">${escapeHtml(o.name)}</div>`).join('')}</div>
          <button class="glass-button" id="amorSubmit" disabled>${t("amorConfirm")}</button>
        </div>
      `);
      const selected = new Set();
      document.querySelectorAll("#amorTargets .vote-card").forEach(c => c.addEventListener("click", function() {
        const id = this.dataset.id;
        if (selected.has(id)) { selected.delete(id); this.classList.remove("selected"); }
        else if (selected.size < 2) { selected.add(id); this.classList.add("selected"); }
        document.getElementById("amorSubmit").disabled = selected.size !== 2;
      }));
      document.getElementById("amorSubmit")?.addEventListener("click", async () => {
        const loversArr = [...selected];
        await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.lovers": loversArr, "actionData.amorDone": true });
        showToast(t("loversSet"), "success");
        render(`<div class="glass-card">${baseHeader}<p>${t("loversWait")}</p></div>`);
        attachBaseListeners();
      });
      attachBaseListeners();
      return;
    }

    // BESCHÜTZER
    if (narratorStep === "BESCHÜTZER" && player.role === "Beschützer") {
      const lastProtected = lobby.actionData?.lastBeschützerTarget;
      const targets = players.filter(p => p.isAlive && p.id !== player.id && p.id !== lastProtected);
      render(`
        <div class="glass-card">
          ${baseHeader}
          <h2>${t("guardTitle")}</h2>
          ${lastProtected ? `<p style="opacity:0.6; font-size:0.85rem;">${t("guardCantSame")}</p>` : ''}
          <div class="vote-grid" id="guardTargets">${targets.map(tg=>`<div class="vote-card" data-id="${tg.id}">${escapeHtml(tg.name)}</div>`).join('')}</div>
          <button class="glass-button" id="guardSubmit">${t("guardConfirm")}</button>
        </div>
      `);
      let sel = null;
      document.querySelectorAll("#guardTargets .vote-card").forEach(c => c.addEventListener("click", function() {
        sel = this.dataset.id;
        document.querySelectorAll("#guardTargets .vote-card").forEach(x => x.classList.remove("selected"));
        this.classList.add("selected");
      }));
      document.getElementById("guardSubmit")?.addEventListener("click", async () => {
        if (sel) {
          await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.beschützerTarget": sel, "actionData.beschützerDone": true });
          showToast(t("guardActive"), "success");
          render(`<div class="glass-card">${baseHeader}<p>${t("guardWait")}</p></div>`);
          attachBaseListeners();
        }
      });
      attachBaseListeners();
      return;
    }

    // WEREWOLF
    if (narratorStep === "WEREWOLF" && player.role === "Werwolf") {
      const wolfVotes = lobby.actionData?.werewolfVotes || {};
      const aliveWolves = players.filter(p => p.isAlive && p.role === "Werwolf");
      const votedWolves = aliveWolves.filter(w => wolfVotes[w.id]).length;
      const packStatus = `<div class="pack-status">${aliveWolves.map(w => `<span class="pack-dot ${wolfVotes[w.id] ? 'voted' : ''}" title="${escapeHtml(w.name)}">🐺</span>`).join('')} <span class="pack-count">${votedWolves}/${aliveWolves.length}</span></div>`;

      // Already voted → live waiting view; a snapshot re-render must not bounce
      // the wolf back to the picker (same pattern as the seer view).
      if (wolfVotes[player.id]) {
        const myTarget = players.find(p => p.id === wolfVotes[player.id]);
        render(`<div class="glass-card">${baseHeader}<h2>${t("wolfTitle")}</h2><p>${t("wolfWait")}</p>${myTarget ? `<p style="opacity:0.7;">🎯 ${escapeHtml(myTarget.name)}</p>` : ''}${packStatus}</div>`);
        attachBaseListeners();
        return;
      }

      const targets = players.filter(p => p.isAlive && p.id !== player.id);
      render(`
        <div class="glass-card">
          ${baseHeader}
          <h2>${t("wolfTitle")}</h2>
          ${packStatus}
          <div class="vote-grid" id="wolfTargets">${targets.map(tg => `<div class="vote-card" data-id="${tg.id}">${escapeHtml(tg.name)} ${tg.role==='Werwolf'?`<span style="font-size:0.7rem; opacity:0.5;">${t("pack")}</span>`:''}</div>`).join('')}</div>
          <button class="glass-button" id="submitWolfVote">${t("wolfConfirm")}</button>
        </div>
      `);
      let sel = null;
      document.querySelectorAll("#wolfTargets .vote-card").forEach(c => c.addEventListener("click", function() {
        sel = this.dataset.id;
        document.querySelectorAll("#wolfTargets .vote-card").forEach(x => x.classList.remove("selected"));
        this.classList.add("selected");
      }));
      document.getElementById("submitWolfVote")?.addEventListener("click", async () => {
        if (sel) {
          // Field-level write so simultaneous wolf votes don't overwrite each other.
          await updateDoc(doc(db, "lobbies", lobby.id), { [`actionData.werewolfVotes.${player.id}`]: sel });
          showToast(t("wolfVoted"), "success");
          render(`<div class="glass-card">${baseHeader}<p>${t("wolfWait")}</p></div>`);
          attachBaseListeners();
        }
      });
      attachBaseListeners();
      return;
    }

    // SMALL GIRL
    if (narratorStep === "SMALL_GIRL" && player.role === "Kleines Mädchen") {
      render(`
        <div class="glass-card">
          ${baseHeader}
          <h2>${t("girlTitle")}</h2>
          <p style="opacity:0.7; margin:1rem 0;">${t("girlHint")}</p>
          <div style="display:flex; gap:1rem; flex-wrap:wrap;">
            <button class="glass-button" id="peekYes" style="flex:1;">${t("girlYes")}</button>
            <button class="glass-button" id="peekNo" style="flex:1; background:rgba(255,255,255,0.1);">${t("girlNo")}</button>
          </div>
        </div>
      `);
      document.getElementById("peekYes")?.addEventListener("click", async () => {
        const risk = Math.random() < 0.5;
        if (risk) {
          showToast(t("girlCaught"), "error");
          const updated = players.map(p => p.id === player.id ? { ...p, isAlive: false } : p);
          await updateDoc(doc(db, "lobbies", lobby.id), { players: updated, "actionData.smallGirlPeeked": true });
        } else {
          const wolfNames = players.filter(p => p.role === "Werwolf" && p.isAlive).map(p => p.name).join(", ");
          showToast(t("girlFound", { names: wolfNames }), "success");
          await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.smallGirlPeeked": true });
          render(`<div class="glass-card">${baseHeader}<p>👧 ${escapeHtml(wolfNames || t("nobody"))}</p></div>`);
          attachBaseListeners();
        }
      });
      document.getElementById("peekNo")?.addEventListener("click", async () => {
        await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.smallGirlPeeked": true });
        showToast(t("girlSafe"), "info");
        render(`<div class="glass-card">${baseHeader}<p>${t("girlHidden")}</p></div>`);
        attachBaseListeners();
      });
      attachBaseListeners();
      return;
    }

    // SEER
    if (narratorStep === "SEER" && player.role === "Seherin") {
      // Already looked this night → keep showing the result instead of the picker
      // (a snapshot re-render used to wipe it away).
      const seenId = lobby.actionData?.seerTarget;
      if (seenId) {
        const seen = players.find(p => p.id === seenId);
        render(`<div class="glass-card">${baseHeader}<p>🔮 ${seen ? `${escapeHtml(seen.name)}: <strong>${roleName(seen.role)}</strong>` : t("playerLeft")}</p></div>`);
        attachBaseListeners();
        return;
      }
      const targets = players.filter(p => p.isAlive && p.id !== player.id);
      render(`
        <div class="glass-card">
          ${baseHeader}
          <h2>${t("seerTitle")}</h2>
          <div class="vote-grid" id="seerTargets">${targets.map(tg=>`<div class="vote-card" data-id="${tg.id}">${escapeHtml(tg.name)}</div>`).join('')}</div>
          <button class="glass-button" id="seerSubmit">${t("seerConfirm")}</button>
        </div>
      `);
      let sel = null;
      document.querySelectorAll("#seerTargets .vote-card").forEach(c => c.addEventListener("click", function() {
        sel = this.dataset.id;
        document.querySelectorAll("#seerTargets .vote-card").forEach(x => x.classList.remove("selected"));
        this.classList.add("selected");
      }));
      document.getElementById("seerSubmit")?.addEventListener("click", async () => {
        if (sel) {
          const target = players.find(p => p.id === sel);
          if (!target) { showToast(t("playerLeft"), "error"); return; }
          showToast(t("seerResult", { name: target.name, role: roleName(target.role) }), "info");
          await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.seerTarget": sel });
          render(`<div class="glass-card">${baseHeader}<p>🔮 ${escapeHtml(target.name)}: <strong>${roleName(target.role)}</strong></p></div>`);
          attachBaseListeners();
        }
      });
      attachBaseListeners();
      return;
    }

    // WITCH
    if (narratorStep === "WITCH" && player.role === "Hexe") {
      const victimId = lobby.actionData?.nightVictim;
      const victimName = players.find(p => p.id === victimId)?.name || t("nobody");
      const witch = lobby.actionData?.witch || {};
      render(`
        <div class="glass-card">
          ${baseHeader}
          <h2>${t("witchTitle")}</h2>
          <p style="margin:0.5rem 0;">${t("witchVictim")} <strong>${victimId ? escapeHtml(victimName) : t("nobody")}</strong></p>
          <div style="display:flex; flex-direction:column; gap:0.8rem; margin:1rem 0;">
            ${!witch.usedHeal && victimId ? `<button class="glass-button" id="healBtn">${t("witchHeal", { name: escapeHtml(victimName) })}</button>` : ''}
            ${!witch.usedPoison ? `<button class="glass-button" id="poisonBtn">${t("witchPoison")}</button>` : ''}
            <button class="glass-button" id="skipWitch" style="background:rgba(255,255,255,0.1);">${t("witchSkip")}</button>
          </div>
        </div>
      `);
      document.getElementById("healBtn")?.addEventListener("click", async () => {
        // If the poison is already spent there's nothing left to do — finish the step
        // in the same write so the night doesn't sit out the full timeout.
        const update = { "actionData.witch.healTarget": victimId, "actionData.witch.usedHeal": true };
        if (witch.usedPoison) update["actionData.witchDone"] = true;
        await updateDoc(doc(db, "lobbies", lobby.id), update);
        showToast(t("healed", { name: victimName }), "success");
        if (witch.usedPoison) { render(`<div class="glass-card">${baseHeader}<p>${t("witchDoneView")}</p></div>`); attachBaseListeners(); }
      });
      document.getElementById("poisonBtn")?.addEventListener("click", () => {
        const aliveOthers = players.filter(p => p.isAlive && p.id !== player.id);
        showChoiceModal(t("poisonWho"), aliveOthers.map(p => ({ id: p.id, name: p.name })), async (targetId) => {
          if (targetId) {
            const targetName = players.find(p => p.id === targetId)?.name;
            // Same idea: if healing is no longer possible, the witch is done.
            const healStillPossible = !witch.usedHeal && victimId;
            const update = { "actionData.witch.poisonTarget": targetId, "actionData.witch.usedPoison": true };
            if (!healStillPossible) update["actionData.witchDone"] = true;
            await updateDoc(doc(db, "lobbies", lobby.id), update);
            showToast(t("poisoned", { name: targetName }), "warning");
            if (!healStillPossible) { render(`<div class="glass-card">${baseHeader}<p>${t("witchDoneView")}</p></div>`); attachBaseListeners(); }
          }
        });
      });
      document.getElementById("skipWitch")?.addEventListener("click", async () => {
        await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.witchDone": true });
        showToast(t("nothingDone"), "info");
        render(`<div class="glass-card">${baseHeader}<p>${t("witchDoneView")}</p></div>`);
        attachBaseListeners();
      });
      attachBaseListeners();
      return;
    }

    // Night – no action for this player
    render(`<div class="glass-card">${baseHeader}<p style="text-align:center; padding:2rem 0;">${t("sleeping")}</p></div>`);
    attachBaseListeners();
    return;
  }

  // VOTING
  if (phase === "VOTING") {
    const aliveAll = players.filter(p => p.isAlive && p.role !== "ERZÄHLER");
    const aliveTargets = aliveAll.filter(p => p.id !== player.id);
    const currentVotes = lobby.votes || {};
    const voteCount = Object.keys(currentVotes).length;
    const totalVoters = aliveAll.length;
    const alreadyVoted = !!currentVotes[player.id];

    if (alreadyVoted) {
      // Show waiting view with live tally
      const counts = {};
      Object.values(currentVotes).forEach(v => counts[v] = (counts[v] || 0) + 1);
      const tallyHtml = Object.entries(counts)
        .sort(([,a],[,b]) => b - a)
        .map(([id, c]) => {
          const name = players.find(p => p.id === id)?.name || "?";
          const pct = Math.round((c / voteCount) * 100);
          return `<div style="margin:0.3rem 0;">
            <div style="display:flex; justify-content:space-between; font-size:0.85rem;"><span>${escapeHtml(name)}</span><span>${c} ${c>1?t("votesPlural"):t("voteSingular")}</span></div>
            <div style="background:rgba(255,255,255,0.1); border-radius:0.5rem; height:6px; margin-top:2px; overflow:hidden;">
              <div style="width:${pct}%; height:100%; background:var(--accent); border-radius:0.5rem; transition:width 0.3s;"></div>
            </div>
          </div>`;
        }).join("");

      render(`
        <div class="glass-card">
          ${baseHeader}
          <h2>${t("voteRunning")}</h2>
          <p style="opacity:0.7;">${t("votedWait")}</p>
          <div style="margin:1rem 0; font-size:0.85rem; opacity:0.8;">${t("voteCount", { n: voteCount, t: totalVoters })}${lobby.mode === "online" ? ` · ⏱️ <strong id="phaseCountdown">–</strong>` : ""}</div>
          ${tallyHtml ? `<div style="margin:1rem 0; padding:0.8rem; background:rgba(0,0,0,0.2); border-radius:0.8rem;">${tallyHtml}</div>` : ''}
        </div>
      `);
      if (lobby.mode === "online") startCountdown(lobby.stepDeadline);
      attachBaseListeners();
      return;
    }

    render(`
      <div class="glass-card">
        ${baseHeader}
        <h2>${t("voteTitle")}</h2>
        <p style="opacity:0.7; margin-bottom:0.5rem;">${t("voteCount", { n: voteCount, t: totalVoters })}${lobby.mode === "online" ? ` · ⏱️ <strong id="phaseCountdown">–</strong>` : ""}</p>
        <div class="vote-grid" id="voteGrid">${aliveTargets.map(tg=>`<div class="vote-card" data-id="${tg.id}">${escapeHtml(tg.name)}</div>`).join('')}</div>
        <button class="glass-button" id="castVote">${t("voteBtn")}</button>
      </div>
    `);
    if (lobby.mode === "online") startCountdown(lobby.stepDeadline);
    let sel = null;
    document.querySelectorAll("#voteGrid .vote-card").forEach(c => c.addEventListener("click", function() {
      sel = this.dataset.id;
      document.querySelectorAll("#voteGrid .vote-card").forEach(x => x.classList.remove("selected"));
      this.classList.add("selected");
    }));
    document.getElementById("castVote")?.addEventListener("click", async () => {
      if (sel) {
        // Field-level write so simultaneous votes don't overwrite each other.
        await updateDoc(doc(db, "lobbies", lobby.id), { [`votes.${player.id}`]: sel });
        showToast(t("voteCast"), "success");
      }
    });
    attachBaseListeners();
    return;
  }

  // DAY
  const lastDeaths = lobby.actionData?.lastNightDeaths || [];
  const alivePlayers = players.filter(p => p.isAlive && p.role !== "ERZÄHLER");
  const deadPlayers = players.filter(p => !p.isAlive && p.role !== "ERZÄHLER");
  const deathAnnouncement = lastDeaths.length > 0
    ? `<div class="death-banner" style="background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.3); border-radius:1rem; padding:1rem; margin:1rem 0;">
        <strong>${t("diedLastNight")}</strong> ${lastDeaths.map(n => `<span style="color:var(--danger); font-weight:600;">${escapeHtml(n)}</span>`).join(", ")}
      </div>`
    : `<div style="background:rgba(34,197,94,0.15); border:1px solid rgba(34,197,94,0.3); border-radius:1rem; padding:1rem; margin:1rem 0;">
        <strong>${t("nobodyDied")}</strong>
      </div>`;

  render(`
    <div class="glass-card">
      ${baseHeader}
      <h2>${t("dayTitle")}</h2>
      ${deathAnnouncement}
      <div style="margin:1rem 0;">
        <strong>${t("aliveCount", { n: alivePlayers.length })}</strong>
        <div style="display:flex; flex-wrap:wrap; gap:0.4rem; margin-top:0.4rem;">
          ${alivePlayers.map(p => `<span class="player-tag">${escapeHtml(p.name)}</span>`).join("")}
        </div>
      </div>
      ${deadPlayers.length > 0 ? `<div style="margin:0.5rem 0; opacity:0.5;">
        <strong>${t("deadCount", { n: deadPlayers.length })}</strong> ${deadPlayers.map(p => `<s>${escapeHtml(p.name)}</s>`).join(", ")}
      </div>` : ''}
      <p style="margin-top:1rem; padding:0.8rem; background:rgba(59,130,246,0.1); border-radius:0.8rem; border:1px solid rgba(59,130,246,0.2);">
        ${t("discuss")}${lobby.mode === "online" ? ` ${t("voteAutoIn")} <strong id="phaseCountdown">–</strong>.` : " " + t("narratorWillVote")}
      </p>
      ${(lobby.mode === "online" && isHost) ? `<button class="glass-button" id="startVoteNow" style="margin-top:1rem; width:100%;">${t("startVoteNow")}</button>` : ""}
    </div>
  `);
  document.getElementById("startVoteNow")?.addEventListener("click", () => runLocked(() => startVoting(lobby)));
  if (lobby.mode === "online") startCountdown(lobby.stepDeadline);
  attachBaseListeners();
}

function getRoleIcon(role) {
  const map = { "Werwolf": "🐺", "Dorfbewohner": "🏘️", "Seherin": "🔮", "Hexe": "🧪", "Amor": "💘", "Jäger": "🎯", "Kleines Mädchen": "👧", "Beschützer": "🛡️", "Prinz": "👑", "Älteste": "👴", "ERZÄHLER": "🎙️" };
  return map[role] || "🎭";
}

// ========== MAIN MENU ==========
function flashNameInput() {
  const input = document.getElementById("playerName");
  if (input) {
    input.classList.add("error-flash");
    input.placeholder = t("nameRequired");
    setTimeout(() => input.classList.remove("error-flash"), 800);
  }
}

function renderMainMenu() {
  currentRender = renderMainMenu;
  lastRevealId = null;
  document.body.dataset.phase = "";
  render(`
    <div class="menu-shell">
      <div class="glass-card menu-card">
        <div class="hero">
          <div class="hero-logo"><span class="hero-logo-emoji">🐺</span></div>
          <h1 class="hero-title">WERWOLF<span class="hero-title-mobile">MOBILE</span></h1>
          <p class="hero-tagline">${t("heroTagline")}</p>
          <div class="hero-pills">
            <span class="hero-pill"><i class="fas fa-masks-theater"></i> ${t("featRoles")}</span>
            <span class="hero-pill"><i class="fas fa-bolt"></i> ${t("featRealtime")}</span>
            <span class="hero-pill"><i class="fas fa-comments"></i> ${t("featChat")}</span>
          </div>
        </div>

        <div class="name-field">
          <i class="fas fa-user name-field-icon"></i>
          <input type="text" id="playerName" placeholder="${t("namePlaceholder")}" value="${escapeHtml(currentUser.name || "")}" autocomplete="off">
        </div>

        <button class="glass-button btn-hero" id="quickGameBtn"><i class="fas fa-bolt"></i> ${t("quickStart")}</button>
        <p class="quick-hint">${t("quickHint")}</p>

        <div class="menu-divider"><span>${t("orDivider")}</span></div>

        <div class="icon-grid">
          <div class="icon-button" id="createPublicLobby">
            <i class="fas fa-globe"></i>
            <span>${t("publicLobby")}</span>
          </div>
          <div class="icon-button" id="createPrivateLobby">
            <i class="fas fa-lock"></i>
            <span>${t("privateLobby")}</span>
          </div>
          <div class="icon-button" id="joinLobbyIcon">
            <i class="fas fa-right-to-bracket"></i>
            <span>${t("join")}</span>
          </div>
        </div>

        <div class="menu-footer">
          <a href="https://paypal.me/Emre100120" target="_blank" rel="noopener" class="donate-link">
            <i class="fab fa-paypal"></i> ${t("donate")}
          </a>
        </div>
      </div>
    </div>
  `);
  const nameInput = document.getElementById("playerName");
  nameInput?.addEventListener("input", (e) => { currentUser.name = e.target.value; });
  document.getElementById("quickGameBtn")?.addEventListener("click", startQuickGame);
  document.getElementById("createPublicLobby")?.addEventListener("click", () => showCreateLobbyModal("public"));
  document.getElementById("createPrivateLobby")?.addEventListener("click", () => showCreateLobbyModal("private"));
  document.getElementById("joinLobbyIcon")?.addEventListener("click", () => showJoinLobbyModal());
}

// Quick game: one tap -> private online lobby with a simple, fast role set (short night).
const QUICK_PRESET = { Dorfbewohner: true, Werwolf: true, Seherin: true, Hexe: true, Jäger: true, Amor: false, "Kleines Mädchen": false, Beschützer: false, Prinz: false, "Älteste": false };
async function startQuickGame() {
  const name = document.getElementById("playerName")?.value.trim();
  if (!name) { flashNameInput(); return; }
  currentUser.name = name;
  try {
    await createLobby(name, false, "online", { ...QUICK_PRESET });
    showToast(t("quickCreated"), "success");
  } catch (e) { showToast(e.message, "error"); }
}

function showCreateLobbyModal(type) {
  const name = document.getElementById("playerName")?.value.trim();
  if (!name) { flashNameInput(); return; }
  currentUser.name = name;
  const isPublic = (type === "public");
  let localOnlineMode = "online";
  const settings = { Dorfbewohner: true, Werwolf: true, Seherin: true, Hexe: true, Amor: true, Jäger: true, "Kleines Mädchen": true, Beschützer: true, Prinz: true, "Älteste": true };

  let extraHtml = type === "private"
    ? `<div class="switch-container"><span class="switch-label"><i class="fas fa-cog"></i> <span id="localOnlineText">${t("onlineModeAuto")}</span></span><label class="switch"><input type="checkbox" id="localOnlineSwitch" checked><span class="slider"></span></label></div>`
    : `<p style="margin:1rem 0; opacity:0.7;">${t("publicHint")}</p>`;

  const modalContent = `
    <h3>${isPublic ? t("createPublicTitle") : t("createPrivateTitle")}</h3>
    ${extraHtml}
    <div style="margin-top:0.8rem;"><strong>${t("selectRoles")}</strong></div>
    <div class="roles-grid" id="roleSettingsModal">${renderRoleToggles(settings)}</div>
    <button class="glass-button" id="confirmCreate" style="margin-top:1rem; width:100%;">${t("create")}</button>
  `;
  const modalDiv = showModal(modalContent);
  bindRoleToggleClicks(modalDiv);

  if (type === "private") {
    const sw = modalDiv.querySelector("#localOnlineSwitch");
    const txt = modalDiv.querySelector("#localOnlineText");
    sw?.addEventListener("change", (e) => {
      localOnlineMode = e.target.checked ? "online" : "lokal";
      txt.innerHTML = localOnlineMode === "online" ? t("onlineModeAuto") : t("localModeNarrator");
    });
  }

  modalDiv.querySelector("#confirmCreate")?.addEventListener("click", async () => {
    const newSettings = {};
    modalDiv.querySelectorAll(".role-card").forEach(card => { newSettings[card.dataset.role] = card.classList.contains("selected"); });
    LOCKED_ROLES.forEach(r => newSettings[r] = true);
    try {
      await createLobby(currentUser.name, isPublic, type === "public" ? "online" : localOnlineMode, newSettings);
      modalDiv.remove();
    } catch(e) { showToast(e.message, "error"); }
  });
}

function getRoleFaIcon(role) {
  const map = { "Dorfbewohner": "fa-user", "Werwolf": "fa-paw", "Seherin": "fa-eye", "Hexe": "fa-flask", "Amor": "fa-heart", "Jäger": "fa-crosshairs", "Kleines Mädchen": "fa-child", "Beschützer": "fa-shield-alt", "Prinz": "fa-crown", "Älteste": "fa-hat-wizard" };
  return map[role] || "fa-user";
}

async function showJoinLobbyModal() {
  const name = document.getElementById("playerName")?.value.trim();
  if (!name) { flashNameInput(); return; }
  currentUser.name = name;
  const modalContent = `
    <div class="join-split">
      <div class="join-split-left">
        <h3 style="font-size:1.2rem;"><i class="fas fa-globe"></i> ${t("joinPublicTitle")}</h3>
        <div id="joinModalLobbyList" style="margin-top:1rem; max-height:250px; overflow-y:auto;"><div class="loader"></div></div>
      </div>
      <div class="join-split-right">
        <h3 style="font-size:1.2rem;"><i class="fas fa-key"></i> ${t("enterCode")}</h3>
        <div class="code-input-container" id="codeInputContainer">
          <input type="text" maxlength="1" class="code-box">
          <input type="text" maxlength="1" class="code-box">
          <input type="text" maxlength="1" class="code-box">
          <input type="text" maxlength="1" class="code-box">
          <input type="text" maxlength="1" class="code-box">
          <input type="text" maxlength="1" class="code-box">
        </div>
        <button class="glass-button" id="confirmJoin" style="margin-top:1rem; width:100%; max-width:200px;">${t("join")}</button>
      </div>
    </div>
  `;
  const modalDiv = showModal(modalContent);
  modalDiv.querySelector(".modal-content").classList.add("large");

  const boxes = modalDiv.querySelectorAll(".code-box");
  boxes.forEach((box, index) => {
    box.addEventListener("input", () => {
      box.value = box.value.toUpperCase();
      if (box.value && index < boxes.length - 1) boxes[index + 1].focus();
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !box.value && index > 0) boxes[index - 1].focus();
      else if (e.key === "Enter") modalDiv.querySelector("#confirmJoin").click();
    });
  });
  setTimeout(() => boxes[0]?.focus(), 100);

  modalDiv.querySelector("#confirmJoin")?.addEventListener("click", async () => {
    const code = Array.from(boxes).map(b => b.value).join("").toUpperCase();
    if (code && code.length === 6) {
      try { await joinLobby(code, currentUser.name); modalDiv.remove(); }
      catch(e) { showToast(e.message, "error"); }
    } else {
      boxes.forEach(b => { if (!b.value) { b.classList.add("error-flash"); setTimeout(() => b.classList.remove("error-flash"), 800); } });
    }
  });

  if (!firebaseReady) {
    modalDiv.querySelector("#joinModalLobbyList").innerHTML = `<p style="opacity:0.6;">${t("loadError")}</p>`;
    return;
  }
  const q2 = query(collection(db, "lobbies"), where("gameStarted", "==", false), where("isPublic", "==", true));
  try {
    const snap = await getDocs(q2);
    const lobbies = snap.docs.map(d => ({ code: d.id, ...d.data() }));
    await cleanupStaleLobbies(lobbies);
    const activeLobbies = lobbies.filter(l => (Date.now() - (l.lastUpdate || 0)) < 5 * 60 * 1000);
    const listDiv = modalDiv.querySelector("#joinModalLobbyList");
    if (activeLobbies.length === 0) {
      listDiv.innerHTML = `<p style="opacity:0.5; margin-top:1rem;">${t("noLobbies")}</p>`;
    } else {
      listDiv.innerHTML = activeLobbies.map(l => `
        <div class="public-lobby-item">
          <div class="public-lobby-info">
            <span class="public-lobby-code">${l.code}</span>
            <span class="public-lobby-players"><i class="fas fa-users"></i> ${l.players.length} ${t("players")}</span>
          </div>
          <button class="glass-button glass-button-small" data-join-code="${l.code}">${t("join")}</button>
        </div>
      `).join("");
      listDiv.querySelectorAll("[data-join-code]").forEach(btn => {
        btn.addEventListener("click", async () => {
          try { await joinLobby(btn.dataset.joinCode, currentUser.name); modalDiv.remove(); }
          catch(e) { showToast(e.message, "error"); }
        });
      });
    }
  } catch(e) {
    modalDiv.querySelector("#joinModalLobbyList").innerHTML = `<p style="opacity:0.6;">${t("loadError")}</p>`;
  }
}

function showLobbyMenu() { hideChat(); renderMainMenu(); }

// ========== INIT ==========
document.addEventListener("DOMContentLoaded", () => {
  initLang();
  applyStaticI18n();
  buildLangPicker();
  onLangChange(() => {
    applyStaticI18n();
    const sel = document.getElementById("lang-select");
    if (sel) sel.value = getLang();
    if (currentRender) currentRender();
  });
  initTheme();
  initParticles();

  document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);
  document.getElementById("accept-consent")?.addEventListener("click", acceptConsent);
  document.getElementById("reject-consent")?.addEventListener("click", rejectConsent);
  document.getElementById("show-impressum")?.addEventListener("click", (e) => { e.preventDefault(); showImpressum(); });
  document.getElementById("show-datenschutz")?.addEventListener("click", (e) => { e.preventDefault(); showDatenschutz(); });
  document.getElementById("close-legal-modal")?.addEventListener("click", closeLegalModal);
  document.getElementById("offline-retry")?.addEventListener("click", () => { if(navigator.onLine){ hideOfflineModal(); initApp(); } else showToast(t("stillOffline"), "error"); });
  document.getElementById("guide-btn")?.addEventListener("click", showGuide);

  // Chat
  document.getElementById("chat-send")?.addEventListener("click", () => {
    const input = document.getElementById("chat-input");
    if (input?.value.trim()) { sendChatMessage(input.value); input.value = ""; }
  });
  document.getElementById("chat-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); const input = e.target; if (input.value.trim()) { sendChatMessage(input.value); input.value = ""; } }
  });
  const toggleChat = () => {
    const container = document.getElementById("chat-container");
    const btn = document.getElementById("chat-toggle-btn");
    container.classList.toggle("collapsed");
    btn.textContent = container.classList.contains("collapsed") ? "+" : "−";
  };
  document.getElementById("chat-header")?.addEventListener("click", toggleChat);
  document.getElementById("chat-toggle-btn")?.addEventListener("click", (e) => { e.stopPropagation(); toggleChat(); });

  if (!consentGiven) showConsentModal();
  else { initApp(); setupInstallBanner(); }
});

window.addEventListener("beforeunload", () => {
  if (currentLobbyId && currentUser.id) {
    leaveLobby(currentLobbyId, currentUser.id);
  }
});

function initApp() {
  if (!firebaseReady) { showToast(t("firebaseError"), "error"); return; }
  if (!navigator.onLine) { showOfflineModal(); return; }
  deviceId = storageGet("ww_device_id");
  if (!deviceId) { deviceId = uuid(); storageSet("ww_device_id", deviceId); }
  currentUser.id = storageGet("ww_player_id") || uuid();
  storageSet("ww_player_id", currentUser.id);
  currentUser.deviceId = deviceId;
  renderMainMenu();
}

// ========== INSTALL BANNER (top bar, iOS + Android) ==========
const INSTALL_DISMISS_KEY = "ww_install_dismissed";
const INSTALL_DISMISS_MS = 7 * 24 * 60 * 60 * 1000; // re-ask after a week

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS 13+ reports as Mac but has touch.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function installRecentlyDismissed() {
  try {
    const v = localStorage.getItem(INSTALL_DISMISS_KEY);
    return !!v && (Date.now() - parseInt(v, 10)) < INSTALL_DISMISS_MS;
  } catch { return false; }
}
function showInstallBar() {
  const bar = document.getElementById("install-bar");
  if (!bar) return;
  bar.classList.add("show");
  document.documentElement.classList.add("install-bar-open");
}
function hideInstallBar() {
  const bar = document.getElementById("install-bar");
  if (bar) bar.classList.remove("show");
  document.documentElement.classList.remove("install-bar-open");
}
function dismissInstallBar() {
  try { localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now())); } catch {}
  hideInstallBar();
}
let installBarReady = false;
function setupInstallBanner() {
  if (isStandalone() || installRecentlyDismissed()) return;
  const bar = document.getElementById("install-bar");
  const btn = document.getElementById("install-bar-btn");
  const closeBtn = document.getElementById("install-bar-close");
  if (!bar || !btn || !closeBtn) return;

  // Wire listeners only once, even if beforeinstallprompt fires repeatedly.
  if (!installBarReady) {
    installBarReady = true;
    closeBtn.addEventListener("click", dismissInstallBar);
    btn.addEventListener("click", async () => {
      if (isIos() && !deferredPrompt) {
        const m = document.getElementById("ios-install-modal");
        if (m) m.style.display = "flex";
        return;
      }
      if (deferredPrompt) {
        deferredPrompt.prompt();
        try { await deferredPrompt.userChoice; } catch {}
        deferredPrompt = null;
        hideInstallBar();
      }
    });
    document.getElementById("ios-install-close")?.addEventListener("click", () => {
      const m = document.getElementById("ios-install-modal");
      if (m) m.style.display = "none";
    });
  }

  // iOS Safari never fires beforeinstallprompt → show the bar with manual instructions.
  // Android/Chromium → only show once we actually have a deferred prompt to fire.
  if (isIos() || deferredPrompt) showInstallBar();
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (consentGiven) setupInstallBanner();
});
window.addEventListener("appinstalled", () => { deferredPrompt = null; dismissInstallBar(); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js");
