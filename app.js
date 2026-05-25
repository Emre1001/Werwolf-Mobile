// app.js – Werwolf Mobile v2.0 | Komplettes Rewrite mit Bugfixes & neuen Features
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, onSnapshot, updateDoc, collection, query, where, getDocs, setDoc, deleteDoc, arrayUnion, getDoc, addDoc, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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
const CONSENT_KEY = "werwolf_consent_given";
let consentGiven = localStorage.getItem(CONSENT_KEY) === "true";

function showConsentModal() { document.getElementById("consent-modal").style.display = "flex"; }
function acceptConsent() { localStorage.setItem(CONSENT_KEY, "true"); consentGiven = true; document.getElementById("consent-modal").style.display = "none"; initApp(); }
function rejectConsent() { showToast("Ohne Zustimmung kann die App nicht genutzt werden.", "warning"); }

// ========== OFFLINE ==========
let isOnline = navigator.onLine;
function showOfflineModal() { document.getElementById("offline-modal").style.display = "flex"; }
function hideOfflineModal() { document.getElementById("offline-modal").style.display = "none"; }
window.addEventListener("online", () => { isOnline = true; hideOfflineModal(); if(consentGiven && firebaseReady) initApp(); });
window.addEventListener("offline", () => { isOnline = false; showOfflineModal(); });

// ========== LEGAL ==========
function showImpressum() { const modal = document.getElementById("legal-modal"); document.getElementById("legal-modal-title").innerText = "Impressum"; document.getElementById("legal-modal-body").innerHTML = `<p><strong>Angaben gemäß § 5 TMG:</strong></p><p>Emre Asik<br>E-Mail: emre.asik201060@gmail.com</p><p>Die Anschrift wird aus Datenschutzgründen nicht öffentlich angezeigt. Sie erhalten diese auf Anfrage.</p><p><strong>Verantwortlich für den Inhalt:</strong> Emre Asik</p>`; modal.style.display = "flex"; }
function showDatenschutz() { const modal = document.getElementById("legal-modal"); document.getElementById("legal-modal-title").innerText = "Datenschutzerklärung"; document.getElementById("legal-modal-body").innerHTML = `<p><strong>1. Verantwortlicher</strong><br>Emre Asik, emre.asik201060@gmail.com</p><p><strong>2. Erhobene Daten</strong><br>Spieler-ID, Geräte-ID (LocalStorage). Technisch notwendig.</p><p><strong>3. Rechtsgrundlage</strong><br>Art. 6 Abs. 1 lit. a, b DSGVO. Einwilligung jederzeit widerrufbar.</p><p><strong>4. Weitergabe</strong><br>Keine Weitergabe an Dritte.</p>`; modal.style.display = "flex"; }
function closeLegalModal() { document.getElementById("legal-modal").style.display = "none"; }

// ========== GLOBAL STATE ==========
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36); }

let deviceId = localStorage.getItem("ww_device_id");
if (!deviceId && consentGiven) { deviceId = uuid(); localStorage.setItem("ww_device_id", deviceId); }
let currentUser = { id: localStorage.getItem("ww_player_id") || uuid(), name: "", deviceId };
if (consentGiven) localStorage.setItem("ww_player_id", currentUser.id);

let currentLobbyId = null;
let unsubscribeLobby = null;
let heartbeatInterval = null;
let deferredPrompt = null;
let roleDisplayTimeout = null;
let lastStateFingerprint = null;
let unsubscribeChat = null;
let chatMessages = [];
let currentChatChannel = null;
let chatClearedAt = 0;
let inactiveCheckInterval = null;
let lastPhase = null;

const ui = document.getElementById("ui-container");

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
      ctx.fillStyle = "rgba(168, 133, 247, 0.45)";
      ctx.fill();
      for (let j = i + 1; j < particles.length; j++) {
        const q = particles[j];
        const dx = p.x - q.x, dy = p.y - q.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < maxDist) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.strokeStyle = `rgba(139, 92, 246, ${0.12 * (1 - d / maxDist)})`;
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
    text.textContent = "Die Nacht bricht an...";
    overlay.classList.add("phase-night");
  } else if (phase === "DAY") {
    icon.textContent = "☀️";
    text.textContent = "Der Tag erwacht!";
    overlay.classList.add("phase-day");
  } else if (phase === "VOTING") {
    icon.textContent = "🗳️";
    text.textContent = "Abstimmung!";
    overlay.classList.add("phase-vote");
  } else return;

  overlay.classList.add("active");
  setTimeout(() => { overlay.classList.remove("active"); }, 2200);
}

// ========== GUIDE SYSTEM ==========
function showGuide() {
  const existing = document.querySelector(".guide-overlay");
  if (existing) { existing.remove(); return; }

  const roles = [
    { icon: "🐺", name: "Werwolf", desc: "Erwacht nachts und stimmt mit anderen Wölfen über ein Opfer ab. Versuche, tagsüber unentdeckt zu bleiben!", team: "Werwölfe" },
    { icon: "🏘️", name: "Dorfbewohner", desc: "Keine Spezialfähigkeit, aber deine Stimme bei der Abstimmung ist entscheidend!", team: "Dorf" },
    { icon: "🔮", name: "Seherin", desc: "Kann jede Nacht die wahre Rolle eines Spielers aufdecken.", team: "Dorf" },
    { icon: "🧪", name: "Hexe", desc: "Besitzt einen Heiltrank (rettet das Wolfsopfer) und einen Gifttrank (tötet einen Spieler).", team: "Dorf" },
    { icon: "💘", name: "Amor", desc: "Bestimmt in der ersten Nacht zwei Liebende. Stirbt einer, stirbt auch der andere.", team: "Dorf" },
    { icon: "🎯", name: "Jäger", desc: "Wenn der Jäger stirbt, darf er sofort einen anderen Spieler mit in den Tod reißen.", team: "Dorf" },
    { icon: "👧", name: "Kleines Mädchen", desc: "Kann die Werwölfe ausspionieren – aber mit 50% Risiko, dabei entdeckt und getötet zu werden!", team: "Dorf" },
    { icon: "🛡️", name: "Beschützer", desc: "Schützt jede Nacht einen Spieler vor dem Werwolf-Angriff. Kann nicht zweimal denselben schützen.", team: "Dorf" },
    { icon: "👑", name: "Prinz", desc: "Überlebt die erste Hinrichtung durch das Dorf. Seine Identität wird dabei enthüllt.", team: "Dorf" },
    { icon: "👴", name: "Älteste", desc: "Überlebt den ersten Werwolf-Angriff dank seiner Widerstandskraft.", team: "Dorf" },
  ];

  const overlay = document.createElement("div");
  overlay.className = "guide-overlay";
  overlay.innerHTML = `
    <div class="guide-container glass-card" style="padding:2rem;">
      <div class="guide-header">
        <h2>📖 Spielanleitung</h2>
        <p style="opacity:0.7;">Alles, was du über Werwolf wissen musst</p>
      </div>

      <div class="guide-section">
        <h3>🎯 Ziel des Spiels</h3>
        <p>Das <strong>Dorf</strong> versucht, alle Werwölfe zu entlarven und hinzurichten. Die <strong>Werwölfe</strong> versuchen, nachts alle Dorfbewohner zu eliminieren. Wer zuerst sein Ziel erreicht, gewinnt!</p>
      </div>

      <div class="guide-section">
        <h3>🔄 Spielphasen</h3>
        <div class="guide-phase-flow">
          <div class="guide-phase-step"><span>🌙</span>Nacht</div>
          <span class="guide-phase-arrow">→</span>
          <div class="guide-phase-step"><span>☀️</span>Tag</div>
          <span class="guide-phase-arrow">→</span>
          <div class="guide-phase-step"><span>🗳️</span>Abstimmung</div>
          <span class="guide-phase-arrow">→</span>
          <div class="guide-phase-step"><span>🔁</span>Wiederholen</div>
        </div>
        <p style="font-size:0.85rem; opacity:0.8; margin-top:0.5rem;"><strong>Nacht:</strong> Werwölfe wählen ein Opfer. Spezialrollen agieren.<br><strong>Tag:</strong> Diskussion – wer ist verdächtig?<br><strong>Abstimmung:</strong> Das Dorf wählt, wer hingerichtet wird.</p>
      </div>

      <div class="guide-section">
        <h3>🎭 Alle Rollen</h3>
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
        <h3>💡 Tipps für Anfänger</h3>
        <ul style="padding-left:1.2rem; font-size:0.85rem; line-height:1.8; opacity:0.85;">
          <li>Beobachte das Verhalten der anderen Spieler genau</li>
          <li>Als Werwolf: Versuche, Verdacht auf andere zu lenken</li>
          <li>Als Seherin: Teile dein Wissen klug – aber vorsichtig!</li>
          <li>Nutze den Chat strategisch – auch Schweigen kann verdächtig sein</li>
          <li>Mindestens 4 Spieler werden benötigt</li>
        </ul>
      </div>

      <div style="text-align:center; margin-top:1.5rem;">
        <button class="glass-button" id="closeGuide">Verstanden!</button>
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
        ${options.map(o => `<div class="vote-card choice-opt" data-value="${o.id}">${o.name}</div>`).join("")}
      </div>
      <div style="text-align:center;">
        <button class="glass-button" id="choiceConfirm" disabled>Bestätigen</button>
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
      <h3 style="margin-bottom:1rem;">⚠️ Bestätigung</h3>
      <p style="opacity:0.85; margin-bottom:1.5rem;">${message}</p>
      <div style="display:flex; gap:1rem; justify-content:center;">
        <button class="glass-button" id="confirmYes" style="background:rgba(239,68,68,0.6);">Ja, beenden</button>
        <button class="glass-button" id="confirmNo" style="background:rgba(255,255,255,0.1);">Abbrechen</button>
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
  const colors = ["#7c3aed", "#a855f7", "#c084fc", "#22c55e", "#f59e0b", "#ef4444", "#3b82f6", "#ec4899"];
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
  ui.innerHTML = html;
  ui.classList.add("fade-transition");
  setTimeout(() => ui.classList.remove("fade-transition"), 500);
}

function showModal(contentHtml, onClose) {
  const modalDiv = document.createElement("div");
  modalDiv.className = "modal";
  modalDiv.innerHTML = `<div class="modal-content glass-card">${contentHtml}<div style="text-align:center; margin-top:1.5rem;"><button class="glass-button" id="modalClose">Schließen</button></div></div>`;
  document.body.appendChild(modalDiv);
  modalDiv.querySelector("#modalClose")?.addEventListener("click", () => { modalDiv.remove(); if(onClose) onClose(); });
  modalDiv.addEventListener("click", (e) => { if (e.target === modalDiv) { modalDiv.remove(); if(onClose) onClose(); } });
  return modalDiv;
}

function escapeHtml(t) { const d = document.createElement("div"); d.textContent = t; return d.innerHTML; }

// ========== ROLE DISPLAY ==========
function showRoleFor10Seconds(role, description) {
  const roleDisplay = document.getElementById("role-display");
  const roleIcon = document.getElementById("role-reveal-icon");
  document.getElementById("role-name").innerText = role;
  document.getElementById("role-description").innerHTML = description;
  const timerSpan = document.getElementById("role-timer");
  const timerFill = document.getElementById("role-timer-fill");
  roleDisplay.style.display = "flex";

  const iconMap = { "Werwolf": "🐺", "Dorfbewohner": "🏘️", "Seherin": "🔮", "Hexe": "🧪", "Amor": "💘", "Jäger": "🎯", "Kleines Mädchen": "👧", "Beschützer": "🛡️", "Prinz": "👑", "Älteste": "👴", "Erzähler": "🎙️" };
  roleIcon.innerHTML = `<span style="font-size:3.5rem;">${iconMap[role] || "🎭"}</span>`;

  let seconds = 10;
  timerSpan.innerText = seconds;
  timerFill.style.transition = "none";
  timerFill.style.width = "100%";
  requestAnimationFrame(() => {
    timerFill.style.transition = "width 10s linear";
    timerFill.style.width = "0%";
  });

  if (roleDisplayTimeout) clearInterval(roleDisplayTimeout);
  const interval = setInterval(() => {
    seconds--;
    timerSpan.innerText = seconds;
    if (seconds <= 0) { clearInterval(interval); roleDisplay.style.display = "none"; }
  }, 1000);
  roleDisplayTimeout = setTimeout(() => { clearInterval(interval); roleDisplay.style.display = "none"; }, 10000);
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
async function checkInactivePlayers(lobbyId) {
  if (!currentLobbyId || !firebaseReady) return;
  try {
    const lobbyRef = doc(db, "lobbies", lobbyId);
    const lobbySnap = await getDoc(lobbyRef);
    if (!lobbySnap.exists()) return;
    const lobby = lobbySnap.data();
    if (lobby.hostId !== currentUser.id) return;
    const now = Date.now();
    const hb = lobby.heartbeats || {};
    const inactive = lobby.players.filter(p => p.id !== currentUser.id && (!hb[p.id] || now - hb[p.id] > 120000));
    if (inactive.length === 0) return;
    const newPlayers = lobby.players.filter(p => !inactive.some(i => i.id === p.id));
    if (newPlayers.length === 0) await deleteDoc(lobbyRef);
    else await updateDoc(lobbyRef, { players: newPlayers });
  } catch(e) { console.warn("Inactive check error", e); }
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
  inactiveCheckInterval = setInterval(() => checkInactivePlayers(lobbyId), 60000);
}

// ========== LOBBY MANAGEMENT ==========
async function createLobby(playerName, isPublic, mode, settings) {
  if (!consentGiven || !firebaseReady || !isOnline) throw new Error("Keine Verbindung");
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
    firstNightDone: false
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
    nightVictim: null, hunterRevenge: null, publicVotes: {},
    beschützerTarget: null, lastBeschützerTarget: null,
    elderSurvivedIds: [], princeSurvivedIds: [],
    witchDone: false, amorDone: false, beschützerDone: false
  };
}

async function joinLobby(code, playerName) {
  if (!consentGiven || !firebaseReady || !isOnline) throw new Error("Keine Verbindung");
  const q2 = query(collection(db, "lobbies"), where("code", "==", code));
  const snap = await getDocs(q2);
  if (snap.empty) throw new Error("Lobby nicht gefunden");
  const lobbyDoc = snap.docs[0];
  const data = lobbyDoc.data();

  if (data.lastUpdate && (Date.now() - data.lastUpdate > 5 * 60 * 1000)) {
    await deleteDoc(lobbyDoc.ref);
    throw new Error("Lobby abgelaufen.");
  }

  if (data.gameStarted) throw new Error("Spiel läuft bereits");
  const existing = data.players.find(p => p.deviceId === deviceId);
  if (existing) {
    const updatedPlayers = data.players.map(p => p.deviceId === deviceId ? { ...p, name: playerName, lastSeen: Date.now(), isAlive: true } : p);
    await updateDoc(lobbyDoc.ref, { players: updatedPlayers });
    currentUser.id = existing.id;
    localStorage.setItem("ww_player_id", currentUser.id);
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

async function leaveLobby(lobbyId, playerId, hostId) {
  const lobbyRef = doc(db, "lobbies", lobbyId);
  const lobbySnap = await getDoc(lobbyRef);
  if (!lobbySnap.exists()) return;
  const lobby = lobbySnap.data();
  let newPlayers = lobby.players.filter(p => p.id !== playerId);
  let newHostId = hostId;
  if (hostId === playerId && newPlayers.length > 0) newHostId = newPlayers[0].id;
  if (newPlayers.length === 0) await deleteDoc(lobbyRef);
  else await updateDoc(lobbyRef, { players: newPlayers, hostId: newHostId });
  if (playerId === currentUser.id) {
    currentLobbyId = null;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (inactiveCheckInterval) clearInterval(inactiveCheckInterval);
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
      render(`<div class="glass-card" style="text-align:center;"><h2>Lobby aufgelöst</h2><p style="margin:1rem 0;">Die Lobby wurde geschlossen.</p><button class="glass-button" id="backHome">Zurück zum Menü</button></div>`);
      document.getElementById("backHome")?.addEventListener("click", () => { currentLobbyId = null; hideChat(); showLobbyMenu(); });
      hideChat();
      return;
    }
    const data = { id: snap.id, ...snap.data() };
    if (!data.players.find(p => p.id === currentUser.id)) {
      currentLobbyId = null;
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (inactiveCheckInterval) clearInterval(inactiveCheckInterval);
      hideChat();
      showLobbyMenu();
      showToast("Du wurdest aus der Lobby entfernt.", "warning");
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

    if (data.gameStarted) {
      const win = checkWinCondition(data.players);
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
      bd: lobby.actionData?.beschützerDone
    }
  });
}

// ========== WIN CONDITION ==========
function checkWinCondition(players) {
  const alive = players.filter(p => p.isAlive && p.role !== "ERZÄHLER");
  if (alive.length === 0) return null;
  const wolves = alive.filter(p => p.role === "Werwolf");
  const villagers = alive.filter(p => p.role !== "Werwolf");
  if (wolves.length === 0) return "VILLAGE";
  if (wolves.length >= villagers.length) return "WEREWOLF";
  return null;
}

function showWinScreen(winner, lobby) {
  hideChat();
  spawnConfetti();
  const emoji = winner === "VILLAGE" ? "🏘️" : "🐺";
  const title = winner === "VILLAGE" ? "Das Dorf gewinnt!" : "Die Werwölfe gewinnen!";
  const desc = winner === "VILLAGE" ? "Alle Werwölfe wurden eliminiert!" : "Die Werwölfe haben das Dorf übernommen!";
  render(`<div class="glass-card" style="text-align:center; padding:2.5rem;">
    <div style="font-size:5rem; margin-bottom:1rem; animation: roleIconPulse 2s infinite;">${emoji}</div>
    <h1>${title}</h1><p style="margin:1rem 0; opacity:0.8; font-size:1.1rem;">${desc}</p>
    <div style="margin:1.5rem 0;"><strong>Endstand:</strong><br>${lobby.players.map(p => `<span class="player-tag ${p.isAlive ? '' : 'dead'}" style="margin:0.2rem;">${p.name}: ${p.role} ${p.isAlive ? '✅' : '💀'}</span>`).join(' ')}</div>
    <button class="glass-button" id="backToMenu" style="margin-top:1rem;">Zurück zum Menü</button>
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
    container.innerHTML = '<div class="chat-empty">Keine Nachrichten</div>';
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
    if (channel === "wolf") title.textContent = "🐺 Werwolf-Chat";
    else if (channel === "dead") title.textContent = "⚰️ Geister-Chat";
    else title.textContent = "💬 Chat";
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
  const { phase, narratorStep, players, actionData, votes } = lobby;

  if (phase === "NIGHT") {
    if (narratorStep === "AMOR") {
      if (!hasAliveRole(players, "Amor") || actionData.amorDone) await advanceNightPhase(lobby);
    } else if (narratorStep === "BESCHÜTZER") {
      if (!hasAliveRole(players, "Beschützer") || actionData.beschützerDone) await advanceNightPhase(lobby);
    } else if (narratorStep === "WEREWOLF") {
      const aliveWolves = players.filter(p => p.isAlive && p.role === "Werwolf");
      const voteCount = Object.keys(actionData.werewolfVotes || {}).length;
      if (aliveWolves.length === 0 || voteCount >= aliveWolves.length) await advanceNightPhase(lobby);
    } else if (narratorStep === "SMALL_GIRL") {
      if (!hasAliveRole(players, "Kleines Mädchen") || actionData.smallGirlPeeked) await advanceNightPhase(lobby);
    } else if (narratorStep === "SEER") {
      if (!hasAliveRole(players, "Seherin") || actionData.seerTarget) await advanceNightPhase(lobby);
    } else if (narratorStep === "WITCH") {
      if (!hasAliveRole(players, "Hexe") || actionData.witchDone) await advanceNightPhase(lobby);
    }
  } else if (phase === "VOTING") {
    const alivePlayers = players.filter(p => p.isAlive && p.role !== "ERZÄHLER");
    const voteCount = Object.keys(votes || {}).length;
    if (voteCount >= alivePlayers.length) await resolveVoting(lobby);
  }
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
  const players = lobby.players || [];
  const currentPlayer = players.find(p => p.id === currentUser.id);
  const isHost = (lobby.hostId === currentUser.id);
  const isHumanNarrator = (lobby.confirmedNarratorId === currentUser.id);

  if (!lobby.gameStarted) { renderLobbyView(lobby, isHost, currentPlayer); return; }

  if (isHumanNarrator) renderNarratorDashboard(lobby);
  else if (currentPlayer) renderPlayerGameView(lobby, currentPlayer);
  else if (isHost) renderHostOnlyGameView(lobby);
  else render(`<div class="glass-card"><p>Beobachter-Modus.</p><button class="glass-button" onclick="location.reload()">Neu laden</button></div>`);
}

function getNarratorScript(lobby) {
  const { phase, nightActionsOrder, currentNightIndex } = lobby;
  if (phase === "NIGHT") {
    const step = nightActionsOrder?.[currentNightIndex];
    if (step === "AMOR") return "💘 Amor, öffne die Augen und wähle zwei Liebende.";
    if (step === "BESCHÜTZER") return "🛡️ Beschützer, erwache und wähle jemanden zum Beschützen.";
    if (step === "WEREWOLF") return "🌕 Werwölfe, erwacht! Wählt euer Opfer.";
    if (step === "SMALL_GIRL") return "👧 Kleines Mädchen – willst du spionieren?";
    if (step === "SEER") return "🔮 Seherin, öffne die Augen und wähle einen Spieler.";
    if (step === "WITCH") return "🧪 Hexe, öffne die Augen...";
    return "🌙 Die Nacht beginnt – das Dorf schläft.";
  } else if (phase === "DAY") return "☀️ Tag – Diskutiert! Wer könnte ein Werwolf sein?";
  else if (phase === "VOTING") return "🗳️ Abstimmung! Wählt, wer hingerichtet werden soll.";
  return "";
}

// ========== HOST-ONLY GAME VIEW (fixed missing div) ==========
function renderHostOnlyGameView(lobby) {
  render(`
    <div class="glass-card">
      <h2>🔭 Beobachter</h2>
      <p style="margin:1rem 0; opacity:0.8;">Du beobachtest das Spiel als Host.</p>
      <div style="margin-top:1.5rem; display:flex; gap:1rem; flex-wrap:wrap;">
        <button class="glass-button" id="leaveLobbyBtn">Verlassen</button>
        <button class="glass-button btn-danger" id="endGame">Spiel beenden</button>
      </div>
    </div>
  `);
  document.getElementById("leaveLobbyBtn")?.addEventListener("click", () => leaveLobby(lobby.id, currentUser.id, lobby.hostId));
  document.getElementById("endGame")?.addEventListener("click", async () => { showConfirmModal("Spiel wirklich beenden? Alle Spieler werden entfernt.", async () => { await deleteDoc(doc(db,"lobbies",lobby.id)); hideChat(); showLobbyMenu(); }) });
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
        ? `<p style="color:var(--success);">✅ Du hast dich gemeldet. Warte auf Bestätigung.</p>`
        : `<button class="glass-button glass-button-small" id="volunteerBtn">🎙️ Als Erzähler melden</button>`;
    } else {
      volunteerSection = `<p>📢 Erzähler: <strong>${players.find(p => p.id === confirmedId)?.name || 'unbekannt'}</strong></p>`;
    }
  } else {
    volunteerSection = `<p>🤖 Online-Modus: Automatischer Erzähler aktiv</p>`;
  }

  let hostControls = "";
  if (isHost) {
    const volunteerPlayer = players.find(p => p.id === volunteerId);
    const narratorConfirmHtml = lobby.mode !== "online" && volunteerId
      ? `<p>Freiwilliger: <strong>${volunteerPlayer?.name}</strong> <button class="glass-button glass-button-small" id="confirmNarratorBtn">Bestätigen</button></p>`
      : lobby.mode !== "online" ? "<p style='opacity:0.6;'>Kein Freiwilliger gemeldet.</p>" : "";

    const sett = lobby.settings || {};
    const enabledCount = Object.entries(sett).filter(([k,v]) => v !== false && k !== "Dorfbewohner").length + 2; // +2 for 2 wolves
    const activeCount = players.length - (confirmedId && lobby.mode !== "online" ? 1 : 0);
    const roleBalanceClass = enabledCount > activeCount ? 'color:var(--warning)' : 'color:var(--success)';
    const roleBalanceMsg = enabledCount > activeCount
      ? `⚠️ Mehr Spezialrollen (${enabledCount}) als Spieler (${activeCount})! Überschüssige werden zufällig entfernt.`
      : `✅ ${enabledCount} Spezialrollen für ${activeCount} Spieler — Rest wird Dorfbewohner.`;

    hostControls = `
      <div style="margin:1.2rem 0; padding:1.2rem; background:rgba(0,0,0,0.25); border-radius:1.2rem;">
        <h3 style="margin-bottom:0.8rem;">⚙️ ${lobby.mode === 'online' ? 'Einstellungen' : 'Host-Einstellungen'}</h3>
        ${narratorConfirmHtml}
        <div style="margin-top:0.8rem;"><strong>Rollen:</strong></div>
        <div class="roles-grid" id="roleToggles">${renderRoleToggles(lobby.settings || {})}</div>
        <p id="roleBalanceInfo" style="margin-top:0.5rem; font-size:0.8rem; ${roleBalanceClass}">${roleBalanceMsg}</p>
        <button class="glass-button glass-button-small" id="saveSettingsBtn" style="margin-top:0.8rem;">💾 Speichern</button>
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
    if (activePlayerCount < MIN_PLAYERS) startHint = `Noch ${MIN_PLAYERS - activePlayerCount} Spieler benötigt`;
    else if (lobby.mode !== "online" && confirmedId === null) startHint = "Erzähler muss bestätigt werden";
  }

  render(`
    <div class="glass-card">
      <h2><i class="fas fa-door-open"></i> Lobby: ${lobby.code}
        <span class="public-badge ${lobby.isPublic ? 'public' : 'private'}">${lobby.isPublic ? 'ÖFFENTLICH' : 'PRIVAT'}</span>
        <span style="margin-left:0.5rem; font-size:0.85rem;">${lobby.mode === 'online' ? '🌐 Online' : '🏠 Lokal'}</span>
      </h2>
      <div class="player-list">${playersHtml}</div>
      <div style="display:flex; align-items:center; gap:0.5rem;">👥 <strong>${playerCount}</strong> / ${MIN_PLAYERS}+ Spieler</div>
      <div style="margin:0.8rem 0;">${volunteerSection}</div>
      ${hostControls}
      <div style="margin-top:1.5rem; display:flex; gap:1rem; flex-wrap:wrap; align-items:center;">
        ${isHost ? `<button class="glass-button" id="startGameBtn" ${!canStart ? 'disabled' : ''}>🎮 Spiel starten</button>${startHint ? `<span style="font-size:0.8rem; opacity:0.6;">${startHint}</span>` : ''}` : ''}
        <button class="glass-button" id="leaveLobbyBtn" style="background:rgba(255,255,255,0.1);">Verlassen</button>
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
      showToast("Einstellungen gespeichert!", "success");
    });
    bindRoleToggleClicks(document);
  }
  document.getElementById("startGameBtn")?.addEventListener("click", () => startGame(lobby));
  document.getElementById("leaveLobbyBtn")?.addEventListener("click", () => leaveLobby(lobby.id, currentUser.id, lobby.hostId));
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
    return `<div class="role-card ${selected ? 'selected' : ''} ${locked ? 'locked' : ''}" data-role="${r.name}" ${locked ? 'title="Pflichtrolle – immer aktiv"' : ''}><i class="fas ${r.icon}"></i> ${r.name}${locked ? ' <i class="fas fa-lock" style="font-size:0.65rem; opacity:0.6;"></i>' : ''}</div>`;
  }).join("");
}

function bindRoleToggleClicks(container) {
  container.querySelectorAll(".role-card").forEach(card => {
    card.addEventListener("click", () => {
      if (LOCKED_ROLES.includes(card.dataset.role)) {
        showToast(`${card.dataset.role} ist eine Pflichtrolle!`, "warning");
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
    showToast("Mindestens 4 Spieler (ohne Erzähler) benötigt!", "error");
    return;
  }

  const enabledRoles = [];
  // Werwolf + Dorfbewohner always forced
  enabledRoles.push("Werwolf", "Werwolf");
  if (settings.Seherin !== false) enabledRoles.push("Seherin");
  if (settings.Hexe !== false) enabledRoles.push("Hexe");
  if (settings.Amor !== false) enabledRoles.push("Amor");
  if (settings.Jäger !== false) enabledRoles.push("Jäger");
  if (settings["Kleines Mädchen"] !== false) enabledRoles.push("Kleines Mädchen");
  if (settings.Beschützer !== false) enabledRoles.push("Beschützer");
  if (settings.Prinz !== false) enabledRoles.push("Prinz");
  if (settings["Älteste"] !== false) enabledRoles.push("Älteste");

  let rolePool = [...enabledRoles];
  // Fill remaining slots with Dorfbewohner (always-on role)
  while (rolePool.length < playersToAssign.length) rolePool.push("Dorfbewohner");

  const shuffledRoles = shuffle(rolePool);

  const assigned = playersArr.map(p => {
    const assignIdx = playersToAssign.findIndex(pa => pa.id === p.id);
    if (assignIdx !== -1) {
      return { ...p, role: shuffledRoles[assignIdx % shuffledRoles.length], isAlive: true };
    }
    return { ...p, role: "ERZÄHLER", isAlive: true };
  });

  const roleDesc = {
    "Dorfbewohner": "Keine Fähigkeit, aber deine Stimme zählt!",
    "Werwolf": "Du erwachst in der Nacht und wählst ein Opfer.",
    "Seherin": "Erkenne die wahre Rolle eines Spielers pro Nacht.",
    "Hexe": "Heiltrank rettet, Gifttrank tötet. Nutze sie weise!",
    "Amor": "Bestimme zwei Liebende in der ersten Nacht.",
    "Jäger": "Wenn du stirbst, nimmst du jemanden mit!",
    "Kleines Mädchen": "Spioniere die Werwölfe aus – mit 50% Risiko!",
    "Beschützer": "Schütze jede Nacht einen Spieler vor dem Tod.",
    "Prinz": "Du überlebst die erste Hinrichtung.",
    "Älteste": "Du überlebst den ersten Werwolf-Angriff.",
    "Erzähler": "Du leitest das Spiel. Sorge für Spannung!"
  };
  const myData = assigned.find(p => p.id === currentUser.id);
  if (myData) showRoleFor10Seconds(myData.role, roleDesc[myData.role] || "Spiele deine Rolle klug.");

  const nightOrder = buildNightOrder(assigned, false);

  await updateDoc(doc(db, "lobbies", lobbyCode), {
    gameStarted: true, phase: "NIGHT", players: assigned,
    actionData: defaultActionData(),
    nightActionsOrder: nightOrder, currentNightIndex: 0,
    narratorStep: nightOrder[0], votes: {},
    chatClearedAt: Date.now(), firstNightDone: false
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
    liveVotesHtml = `<div class="vote-detail-list"><strong>🐺 Werwolf-Votes:</strong>${entries.length ? entries.map(([pid, tid]) => `<div class="vote-detail-item"><span>${players.find(p=>p.id===pid)?.name||"?"}</span><span>→ ${players.find(p=>p.id===tid)?.name||"?"}</span></div>`).join("") : '<div style="opacity:0.5;">Warten auf Stimmen...</div>'}</div>`;
  } else if (phase === "VOTING") {
    const v = votes || {};
    const entries = Object.entries(v);
    liveVotesHtml = `<div class="vote-detail-list"><strong>🗳️ Abstimmung:</strong>${entries.length ? entries.map(([pid, tid]) => `<div class="vote-detail-item"><span>${players.find(p=>p.id===pid)?.name||"?"}</span><span>→ ${players.find(p=>p.id===tid)?.name||"?"}</span></div>`).join("") : '<div style="opacity:0.5;">Warten auf Stimmen...</div>'}</div>`;
  }

  render(`
    <div class="glass-card">
      <h2><i class="fas fa-torah"></i> Erzähler-Konsole — ${lobby.code}</h2>
      <div class="narrator-script"><i class="fas fa-microphone-alt"></i> <strong>Skript:</strong><br/>${script}</div>
      <div style="margin:1rem 0;"><strong>🔒 Rollenübersicht:</strong><br/>
        ${players.map(p => `<span class="player-tag ${p.isAlive ? '' : 'dead'}">${escapeHtml(p.name)}: ${p.role}</span>`).join(' ')}
      </div>
      <div><strong>Lebende:</strong> ${players.filter(p=>p.isAlive && p.role !== "ERZÄHLER").map(p=>escapeHtml(p.name)).join(', ')}</div>
      ${liveVotesHtml}
      <div style="margin-top:1.5rem; display:flex; gap:1rem; flex-wrap:wrap;">
        <button class="glass-button" id="narratorNext">⏭️ Phase weiter</button>
        <button class="glass-button" id="leaveLobbyBtn" style="background:rgba(255,255,255,0.1);">Verlassen</button>
        <button class="glass-button btn-danger" id="endGame">Spiel beenden</button>
      </div>
    </div>
  `);

  document.getElementById("narratorNext")?.addEventListener("click", async () => {
    if (phase === "NIGHT") await advanceNightPhase(lobby);
    else if (phase === "DAY") await updateDoc(doc(db, "lobbies", id), { phase: "VOTING", narratorStep: "VOTING", votes: {}, chatClearedAt: Date.now() });
    else if (phase === "VOTING") await resolveVoting(lobby);
  });
  document.getElementById("leaveLobbyBtn")?.addEventListener("click", () => leaveLobby(id, currentUser.id, lobby.hostId));
  document.getElementById("endGame")?.addEventListener("click", async () => { showConfirmModal("Spiel wirklich beenden? Alle Spieler werden entfernt.", async () => { await deleteDoc(doc(db,"lobbies",lobby.id)); hideChat(); showLobbyMenu(); }) });
}

// ========== NIGHT PHASE ADVANCE ==========
async function advanceNightPhase(lobby) {
  const { id, nightActionsOrder, currentNightIndex } = lobby;
  const step = nightActionsOrder[currentNightIndex];

  if (step === "WEREWOLF") await resolveWerewolfKill(lobby);

  const nextIdx = currentNightIndex + 1;
  if (nextIdx >= nightActionsOrder.length) {
    await resolveNightDeath(lobby);
    const nightOrder = buildNightOrder(lobby.players, true);
    await updateDoc(doc(db, "lobbies", id), {
      phase: "DAY", narratorStep: "DAY", chatClearedAt: Date.now(),
      firstNightDone: true, nightActionsOrder: nightOrder,
      "actionData.werewolfVotes": {}, "actionData.seerTarget": null,
      "actionData.smallGirlPeeked": false, "actionData.witchDone": false,
      "actionData.beschützerDone": false, "actionData.amorDone": false,
      "actionData.beschützerTarget": lobby.actionData?.beschützerTarget || null
    });
  } else {
    await updateDoc(doc(db, "lobbies", id), { currentNightIndex: nextIdx, narratorStep: nightActionsOrder[nextIdx] });
  }
}

async function resolveWerewolfKill(lobby) {
  const votes = lobby.actionData?.werewolfVotes || {};
  const counts = {};
  Object.values(votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
  let maxId = null, max = 0;
  for (const [id, c] of Object.entries(counts)) if (c > max) { max = c; maxId = id; }
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
  // Älteste survival
  if (victim) {
    const victimPlayer = lobby.players.find(p => p.id === victim);
    if (victimPlayer?.role === "Älteste" && !elderSurvivedIds.includes(victim)) {
      elderSurvivedIds.push(victim);
      await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.elderSurvivedIds": elderSurvivedIds });
      showToast("Der Älteste hat den Angriff überlebt!", "info");
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

  // Hunter revenge for any dead hunters
  for (const deadId of deaths) {
    const dead = players.find(p => p.id === deadId);
    if (dead?.role === "Jäger") {
      const aliveTargets = players.filter(p => p.isAlive && p.id !== deadId);
      if (aliveTargets.length > 0 && dead.id === currentUser.id) {
        await new Promise(resolve => {
          showChoiceModal(
            "🎯 Jäger-Rache! Wen nimmst du mit?",
            aliveTargets.map(p => ({ id: p.id, name: p.name })),
            (targetId) => {
              if (targetId) players = players.map(p => p.id === targetId ? { ...p, isAlive: false } : p);
              resolve();
            }
          );
        });
      }
    }
  }

  // Store death names for DAY phase display
  const deathNames = deaths.map(id => players.find(p => p.id === id)?.name || "?");

  await updateDoc(doc(db, "lobbies", lobby.id), {
    players,
    "actionData.nightVictim": null,
    "actionData.lastNightDeaths": deathNames,
    "actionData.witch": { usedHeal: witch.usedHeal || !!witch.healTarget, usedPoison: witch.usedPoison || !!witch.poisonTarget, healTarget: null, poisonTarget: null },
    "actionData.lastBeschützerTarget": beschützerTarget,
    "actionData.beschützerTarget": null
  });
}

async function resolveVoting(lobby) {
  const votes = lobby.votes || {};
  const counts = {};
  Object.values(votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
  let maxId = null, max = 0;
  for (const [id, c] of Object.entries(counts)) if (c > max) { max = c; maxId = id; }
  if (!maxId) return;

  let players = [...lobby.players];
  const princeSurvivedIds = lobby.actionData?.princeSurvivedIds || [];
  const target = players.find(p => p.id === maxId);

  // Prince survival
  if (target?.role === "Prinz" && !princeSurvivedIds.includes(maxId)) {
    princeSurvivedIds.push(maxId);
    showToast(`${target.name} ist der Prinz und überlebt die Hinrichtung!`, "info");
    const nightOrder = buildNightOrder(players, true);
    await updateDoc(doc(db, "lobbies", lobby.id), {
      phase: "NIGHT", currentNightIndex: 0, narratorStep: nightOrder[0],
      nightActionsOrder: nightOrder, votes: {},
      "actionData.werewolfVotes": {}, "actionData.princeSurvivedIds": princeSurvivedIds,
      chatClearedAt: Date.now()
    });
    return;
  }

  players = players.map(p => p.id === maxId ? { ...p, isAlive: false } : p);
  const deaths = [maxId];

  // Lovers
  const lovers = lobby.actionData?.lovers || [];
  if (lovers.includes(maxId)) {
    const other = lovers.find(l => l !== maxId);
    if (other) {
      const otherPlayer = players.find(p => p.id === other);
      if (otherPlayer?.isAlive) {
        players = players.map(p => p.id === other ? { ...p, isAlive: false } : p);
        deaths.push(other);
      }
    }
  }

  // Hunter revenge
  for (const deadId of deaths) {
    const dead = players.find(p => p.id === deadId);
    if (dead?.role === "Jäger" && deadId === currentUser.id) {
      const aliveTargets = players.filter(p => p.isAlive);
      if (aliveTargets.length > 0) {
        await new Promise(resolve => {
          showChoiceModal(
            "🎯 Jäger-Rache! Wen nimmst du mit?",
            aliveTargets.map(p => ({ id: p.id, name: p.name })),
            (targetId) => {
              if (targetId) players = players.map(p => p.id === targetId ? { ...p, isAlive: false } : p);
              resolve();
            }
          );
        });
      }
    }
  }

  const nightOrder = buildNightOrder(players, true);
  await updateDoc(doc(db, "lobbies", lobby.id), {
    players, phase: "NIGHT", currentNightIndex: 0, narratorStep: nightOrder[0],
    nightActionsOrder: nightOrder, votes: {},
    "actionData.werewolfVotes": {}, chatClearedAt: Date.now()
  });
}

// ========== PLAYER GAME VIEW ==========
function renderPlayerGameView(lobby, player) {
  const isHost = (lobby.hostId === currentUser.id);
  const scriptContent = `<div class="narrator-script" style="margin-bottom:1rem;"><i class="fas fa-volume-up"></i> <strong>Status:</strong><br/>${getNarratorScript(lobby)}</div>`;

  const baseHeader = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; flex-wrap:wrap; gap:0.5rem;">
      <span class="player-tag" style="background:rgba(124,58,237,0.25); border:1px solid var(--purple); border-left:3px solid var(--purple);">
        ${getRoleIcon(player.role)} ${player.role}
      </span>
      <div style="display:flex; gap:0.5rem;">
        <button class="glass-button glass-button-small" id="leaveLobbyBtn" style="background:rgba(255,255,255,0.1);">Verlassen</button>
        ${isHost ? `<button class="glass-button glass-button-small btn-danger" id="endGameHost">Beenden</button>` : ''}
      </div>
    </div>
    ${scriptContent}
  `;

  const attachBaseListeners = () => {
    document.getElementById("leaveLobbyBtn")?.addEventListener("click", () => leaveLobby(lobby.id, currentUser.id, lobby.hostId));
    document.getElementById("endGameHost")?.addEventListener("click", async () => { showConfirmModal("Spiel wirklich beenden? Alle Spieler werden entfernt.", async () => { await deleteDoc(doc(db,"lobbies",lobby.id)); hideChat(); showLobbyMenu(); }) });
  };

  if (!player.isAlive) {
    render(`
      <div class="glass-card">
        <h2>⚰️ Du bist tot</h2>
        ${scriptContent}
        <p style="opacity:0.7;">Du bist im Jenseits. Beobachte das Spiel und chatte mit anderen Geistern.</p>
        <div style="margin-top:1.5rem; display:flex; gap:1rem; flex-wrap:wrap;">
          <button class="glass-button" id="leaveLobbyBtn" style="background:rgba(255,255,255,0.1);">Verlassen</button>
          ${isHost ? `<button class="glass-button btn-danger" id="endGameHost">Spiel beenden</button>` : ''}
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
          <h2>💘 Wähle zwei Liebende</h2>
          <p style="opacity:0.7; margin-bottom:1rem;">Wähle genau zwei Spieler. Stirbt einer, stirbt auch der andere.</p>
          <div class="vote-grid" id="amorTargets">${others.map(t=>`<div class="vote-card" data-id="${t.id}">${escapeHtml(t.name)}</div>`).join('')}</div>
          <button class="glass-button" id="amorSubmit" disabled>💘 Bestätigen</button>
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
        showToast("Liebende bestimmt!", "success");
        render(`<div class="glass-card">${baseHeader}<p>💘 Liebende bestimmt. Warte auf die anderen...</p></div>`);
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
          <h2>🛡️ Wen beschützen?</h2>
          ${lastProtected ? `<p style="opacity:0.6; font-size:0.85rem;">Du kannst nicht denselben Spieler wie letzte Nacht wählen.</p>` : ''}
          <div class="vote-grid" id="guardTargets">${targets.map(t=>`<div class="vote-card" data-id="${t.id}">${escapeHtml(t.name)}</div>`).join('')}</div>
          <button class="glass-button" id="guardSubmit">🛡️ Beschützen</button>
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
          showToast("Spieler wird beschützt!", "success");
          render(`<div class="glass-card">${baseHeader}<p>🛡️ Schutz aktiv. Warte auf die anderen...</p></div>`);
          attachBaseListeners();
        }
      });
      attachBaseListeners();
      return;
    }

    // WEREWOLF
    if (narratorStep === "WEREWOLF" && player.role === "Werwolf") {
      const targets = players.filter(p => p.isAlive && p.id !== player.id);
      render(`
        <div class="glass-card">
          ${baseHeader}
          <h2>🐺 Opfer wählen</h2>
          <div class="vote-grid" id="wolfTargets">${targets.map(t => `<div class="vote-card" data-id="${t.id}">${escapeHtml(t.name)} ${t.role==='Werwolf'?'<span style="font-size:0.7rem; opacity:0.5;">(🐺 Rudel)</span>':''}</div>`).join('')}</div>
          <button class="glass-button" id="submitWolfVote">🐺 Bestätigen</button>
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
          const cur = { ...(lobby.actionData?.werewolfVotes || {}), [player.id]: sel };
          await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.werewolfVotes": cur });
          showToast("Stimme abgegeben!", "success");
          render(`<div class="glass-card">${baseHeader}<p>✅ Abgestimmt. Warte auf das Rudel...</p></div>`);
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
          <h2>👧 Spionieren?</h2>
          <p style="opacity:0.7; margin:1rem 0;">Du kannst die Werwölfe beobachten, aber mit 50% Risiko entdeckt zu werden!</p>
          <div style="display:flex; gap:1rem; flex-wrap:wrap;">
            <button class="glass-button" id="peekYes" style="flex:1;">👁️ Ja, spionieren!</button>
            <button class="glass-button" id="peekNo" style="flex:1; background:rgba(255,255,255,0.1);">🙈 Nein, verstecken</button>
          </div>
        </div>
      `);
      document.getElementById("peekYes")?.addEventListener("click", async () => {
        const risk = Math.random() < 0.5;
        if (risk) {
          showToast("Entdeckt! Die Werwölfe haben dich gefunden!", "error");
          const updated = players.map(p => p.id === player.id ? { ...p, isAlive: false } : p);
          await updateDoc(doc(db, "lobbies", lobby.id), { players: updated, "actionData.smallGirlPeeked": true });
        } else {
          const wolfNames = players.filter(p => p.role === "Werwolf" && p.isAlive).map(p => p.name).join(", ");
          showToast(`Werwölfe entdeckt: ${wolfNames}`, "success");
          await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.smallGirlPeeked": true });
        }
      });
      document.getElementById("peekNo")?.addEventListener("click", async () => {
        await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.smallGirlPeeked": true });
        showToast("Sicher versteckt.", "info");
        render(`<div class="glass-card">${baseHeader}<p>🙈 Du bleibst sicher versteckt.</p></div>`);
        attachBaseListeners();
      });
      attachBaseListeners();
      return;
    }

    // SEER
    if (narratorStep === "SEER" && player.role === "Seherin") {
      const targets = players.filter(p => p.isAlive && p.id !== player.id);
      render(`
        <div class="glass-card">
          ${baseHeader}
          <h2>🔮 Wähle einen Spieler</h2>
          <div class="vote-grid" id="seerTargets">${targets.map(t=>`<div class="vote-card" data-id="${t.id}">${escapeHtml(t.name)}</div>`).join('')}</div>
          <button class="glass-button" id="seerSubmit">🔮 Erkennen</button>
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
          showToast(`${target.name} ist: ${target.role}`, "info");
          await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.seerTarget": sel });
          render(`<div class="glass-card">${baseHeader}<p>🔮 ${escapeHtml(target.name)} ist <strong>${target.role}</strong></p></div>`);
          attachBaseListeners();
        }
      });
      attachBaseListeners();
      return;
    }

    // WITCH
    if (narratorStep === "WITCH" && player.role === "Hexe") {
      const victimId = lobby.actionData?.nightVictim;
      const victimName = players.find(p => p.id === victimId)?.name || "niemand";
      const witch = lobby.actionData?.witch || {};
      render(`
        <div class="glass-card">
          ${baseHeader}
          <h2>🧪 Hexe</h2>
          <p style="margin:0.5rem 0;">Werwolf-Opfer: <strong>${victimId ? escapeHtml(victimName) : 'Niemand'}</strong></p>
          <div style="display:flex; flex-direction:column; gap:0.8rem; margin:1rem 0;">
            ${!witch.usedHeal && victimId ? `<button class="glass-button" id="healBtn">💚 Heilen (${escapeHtml(victimName)} retten)</button>` : ''}
            ${!witch.usedPoison ? `<button class="glass-button" id="poisonBtn">☠️ Gifttrank einsetzen</button>` : ''}
            <button class="glass-button" id="skipWitch" style="background:rgba(255,255,255,0.1);">⏭️ Nichts tun / Fertig</button>
          </div>
        </div>
      `);
      document.getElementById("healBtn")?.addEventListener("click", async () => {
        await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.witch.healTarget": victimId, "actionData.witch.usedHeal": true });
        showToast(`${victimName} geheilt!`, "success");
      });
      document.getElementById("poisonBtn")?.addEventListener("click", () => {
        const aliveOthers = players.filter(p => p.isAlive && p.id !== player.id);
        showChoiceModal("☠️ Wen vergiften?", aliveOthers.map(p => ({ id: p.id, name: p.name })), async (targetId) => {
          if (targetId) {
            const targetName = players.find(p => p.id === targetId)?.name;
            await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.witch.poisonTarget": targetId, "actionData.witch.usedPoison": true });
            showToast(`${targetName} vergiftet!`, "warning");
          }
        });
      });
      document.getElementById("skipWitch")?.addEventListener("click", async () => {
        await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.witchDone": true });
        showToast("Nichts getan.", "info");
        render(`<div class="glass-card">${baseHeader}<p>🧪 Fertig. Warte auf den Morgen...</p></div>`);
        attachBaseListeners();
      });
      attachBaseListeners();
      return;
    }

    // Night – no action for this player
    render(`<div class="glass-card">${baseHeader}<p style="text-align:center; padding:2rem 0;">🌙 Du schläfst. Warte auf den Morgen...</p></div>`);
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
            <div style="display:flex; justify-content:space-between; font-size:0.85rem;"><span>${escapeHtml(name)}</span><span>${c} Stimme${c>1?'n':''}</span></div>
            <div style="background:rgba(255,255,255,0.1); border-radius:0.5rem; height:6px; margin-top:2px; overflow:hidden;">
              <div style="width:${pct}%; height:100%; background:var(--purple); border-radius:0.5rem; transition:width 0.3s;"></div>
            </div>
          </div>`;
        }).join("");

      render(`
        <div class="glass-card">
          ${baseHeader}
          <h2>🗳️ Abstimmung läuft</h2>
          <p style="opacity:0.7;">✅ Du hast abgestimmt. Warte auf die anderen...</p>
          <div style="margin:1rem 0; font-size:0.85rem; opacity:0.8;">📊 ${voteCount} / ${totalVoters} haben gewählt</div>
          ${tallyHtml ? `<div style="margin:1rem 0; padding:0.8rem; background:rgba(0,0,0,0.2); border-radius:0.8rem;">${tallyHtml}</div>` : ''}
        </div>
      `);
      attachBaseListeners();
      return;
    }

    render(`
      <div class="glass-card">
        ${baseHeader}
        <h2>🗳️ Wen hinrichten?</h2>
        <p style="opacity:0.7; margin-bottom:0.5rem;">📊 ${voteCount} / ${totalVoters} haben bereits gewählt</p>
        <div class="vote-grid" id="voteGrid">${aliveTargets.map(t=>`<div class="vote-card" data-id="${t.id}">${escapeHtml(t.name)}</div>`).join('')}</div>
        <button class="glass-button" id="castVote">🗳️ Abstimmen</button>
      </div>
    `);
    let sel = null;
    document.querySelectorAll("#voteGrid .vote-card").forEach(c => c.addEventListener("click", function() {
      sel = this.dataset.id;
      document.querySelectorAll("#voteGrid .vote-card").forEach(x => x.classList.remove("selected"));
      this.classList.add("selected");
    }));
    document.getElementById("castVote")?.addEventListener("click", async () => {
      if (sel) {
        const newVotes = { ...(lobby.votes || {}), [player.id]: sel };
        await updateDoc(doc(db, "lobbies", lobby.id), { votes: newVotes });
        showToast("Stimme abgegeben!", "success");
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
    ? `<div style="background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.3); border-radius:1rem; padding:1rem; margin:1rem 0;">
        <strong>☠️ Letzte Nacht starben:</strong> ${lastDeaths.map(n => `<span style="color:var(--danger); font-weight:600;">${escapeHtml(n)}</span>`).join(", ")}
      </div>`
    : `<div style="background:rgba(34,197,94,0.15); border:1px solid rgba(34,197,94,0.3); border-radius:1rem; padding:1rem; margin:1rem 0;">
        <strong>🎉 Niemand ist in der Nacht gestorben!</strong>
      </div>`;

  render(`
    <div class="glass-card">
      ${baseHeader}
      <h2>☀️ Tagphase</h2>
      ${deathAnnouncement}
      <div style="margin:1rem 0;">
        <strong>👥 Lebende (${alivePlayers.length}):</strong>
        <div style="display:flex; flex-wrap:wrap; gap:0.4rem; margin-top:0.4rem;">
          ${alivePlayers.map(p => `<span class="player-tag">${escapeHtml(p.name)}</span>`).join("")}
        </div>
      </div>
      ${deadPlayers.length > 0 ? `<div style="margin:0.5rem 0; opacity:0.5;">
        <strong>⚰️ Tote (${deadPlayers.length}):</strong> ${deadPlayers.map(p => `<s>${escapeHtml(p.name)}</s>`).join(", ")}
      </div>` : ''}
      <p style="margin-top:1rem; padding:0.8rem; background:rgba(59,130,246,0.1); border-radius:0.8rem; border:1px solid rgba(59,130,246,0.2);">
        💬 Diskutiert im Chat! Wer könnte ein Werwolf sein? Der Erzähler wird bald die Abstimmung starten.
      </p>
    </div>
  `);
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
    input.placeholder = "⚠️ Name eingeben!";
    setTimeout(() => input.classList.remove("error-flash"), 800);
  }
}

function renderMainMenu() {
  render(`
    <div class="glass-card" style="max-width: 600px; margin:0 auto;">
      <h1 style="text-align:center;"><span style="font-size:2.2rem;">🐺</span> WERWOLF MOBILE</h1>
      <input type="text" id="playerName" placeholder="Dein Spielername" value="" style="margin-bottom:0.5rem;">
      <div class="icon-grid">
        <div class="icon-button" id="createPublicLobby">
          <i class="fas fa-globe"></i>
          <span>Öffentliche Lobby</span>
        </div>
        <div class="icon-button" id="createPrivateLobby">
          <i class="fas fa-lock"></i>
          <span>Private Lobby</span>
        </div>
        <div class="icon-button" id="joinLobbyIcon">
          <i class="fas fa-sign-in-alt"></i>
          <span>Beitreten</span>
        </div>
      </div>
      <div style="text-align: center; margin-top: 1.5rem;">
        <a href="https://paypal.me/Emre100120" target="_blank" class="glass-button" style="display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; text-decoration: none; font-size:0.9rem;">
          <i class="fab fa-paypal"></i> Spenden
        </a>
      </div>
    </div>
  `);
  const nameInput = document.getElementById("playerName");
  nameInput?.addEventListener("input", (e) => { currentUser.name = e.target.value; });
  document.getElementById("createPublicLobby")?.addEventListener("click", () => showCreateLobbyModal("public"));
  document.getElementById("createPrivateLobby")?.addEventListener("click", () => showCreateLobbyModal("private"));
  document.getElementById("joinLobbyIcon")?.addEventListener("click", () => showJoinLobbyModal());
}

function showCreateLobbyModal(type) {
  const name = document.getElementById("playerName")?.value.trim();
  if (!name) { flashNameInput(); return; }
  currentUser.name = name;
  const isPublic = (type === "public");
  let localOnlineMode = "online";
  const settings = { Dorfbewohner: true, Werwolf: true, Seherin: true, Hexe: true, Amor: true, Jäger: true, "Kleines Mädchen": true, Beschützer: true, Prinz: true, "Älteste": true };

  let extraHtml = type === "private"
    ? `<div class="switch-container"><span class="switch-label"><i class="fas fa-cog"></i> <span id="localOnlineText">Online-Modus (automatisch)</span></span><label class="switch"><input type="checkbox" id="localOnlineSwitch" checked><span class="slider"></span></label></div>`
    : `<p style="margin:1rem 0; opacity:0.7;">Öffentliche Lobby – jeder kann beitreten.</p>`;

  const modalContent = `
    <h3>${isPublic ? '🌍 Öffentliche' : '🔒 Private'} Lobby erstellen</h3>
    ${extraHtml}
    <div style="margin-top:0.8rem;"><strong>Rollen auswählen:</strong></div>
    <div class="roles-grid" id="roleSettingsModal">${renderRoleToggles(settings)}</div>
    <button class="glass-button" id="confirmCreate" style="margin-top:1rem; width:100%;">🎮 Erstellen</button>
  `;
  const modalDiv = showModal(modalContent);
  bindRoleToggleClicks(modalDiv);

  if (type === "private") {
    const sw = modalDiv.querySelector("#localOnlineSwitch");
    const txt = modalDiv.querySelector("#localOnlineText");
    sw?.addEventListener("change", (e) => {
      localOnlineMode = e.target.checked ? "online" : "lokal";
      txt.innerHTML = localOnlineMode === "online" ? "Online-Modus (automatisch)" : "Lokal-Modus (mit Erzähler)";
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
        <h3 style="font-size:1.2rem;"><i class="fas fa-globe"></i> Öffentliche Lobbys</h3>
        <div id="joinModalLobbyList" style="margin-top:1rem; max-height:250px; overflow-y:auto;"><div class="loader"></div></div>
      </div>
      <div class="join-split-right">
        <h3 style="font-size:1.2rem;"><i class="fas fa-key"></i> Code eingeben</h3>
        <div class="code-input-container" id="codeInputContainer">
          <input type="text" maxlength="1" class="code-box">
          <input type="text" maxlength="1" class="code-box">
          <input type="text" maxlength="1" class="code-box">
          <input type="text" maxlength="1" class="code-box">
          <input type="text" maxlength="1" class="code-box">
          <input type="text" maxlength="1" class="code-box">
        </div>
        <button class="glass-button" id="confirmJoin" style="margin-top:1rem; width:100%; max-width:200px;">Beitreten</button>
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
    modalDiv.querySelector("#joinModalLobbyList").innerHTML = '<p style="opacity:0.6;">Keine Verbindung.</p>';
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
      listDiv.innerHTML = '<p style="opacity:0.5; margin-top:1rem;">Keine Lobbys verfügbar.</p>';
    } else {
      listDiv.innerHTML = activeLobbies.map(l => `
        <div class="public-lobby-item">
          <div class="public-lobby-info">
            <span class="public-lobby-code">${l.code}</span>
            <span class="public-lobby-players"><i class="fas fa-users"></i> ${l.players.length} Spieler</span>
          </div>
          <button class="glass-button glass-button-small" data-join-code="${l.code}">Beitreten</button>
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
    modalDiv.querySelector("#joinModalLobbyList").innerHTML = '<p style="opacity:0.6;">Fehler beim Laden.</p>';
  }
}

function showLobbyMenu() { hideChat(); renderMainMenu(); }

// ========== INIT ==========
document.addEventListener("DOMContentLoaded", () => {
  initParticles();

  document.getElementById("accept-consent")?.addEventListener("click", acceptConsent);
  document.getElementById("reject-consent")?.addEventListener("click", rejectConsent);
  document.getElementById("show-impressum")?.addEventListener("click", (e) => { e.preventDefault(); showImpressum(); });
  document.getElementById("show-datenschutz")?.addEventListener("click", (e) => { e.preventDefault(); showDatenschutz(); });
  document.getElementById("close-legal-modal")?.addEventListener("click", closeLegalModal);
  document.getElementById("offline-retry")?.addEventListener("click", () => { if(navigator.onLine){ hideOfflineModal(); initApp(); } else showToast("Immer noch offline.", "error"); });
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
  else initApp();
});

window.addEventListener("beforeunload", () => {
  if (currentLobbyId && currentUser.id) {
    leaveLobby(currentLobbyId, currentUser.id, null);
  }
});

function initApp() {
  if (!firebaseReady) { showToast("Firebase nicht erreichbar", "error"); return; }
  if (!navigator.onLine) { showOfflineModal(); return; }
  deviceId = localStorage.getItem("ww_device_id");
  if (!deviceId) { deviceId = uuid(); localStorage.setItem("ww_device_id", deviceId); }
  currentUser.id = localStorage.getItem("ww_player_id") || uuid();
  localStorage.setItem("ww_player_id", currentUser.id);
  currentUser.deviceId = deviceId;
  renderMainMenu();
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const installDiv = document.getElementById("installPrompt");
  if (installDiv) installDiv.style.display = "flex";
  document.getElementById("installBtn")?.addEventListener("click", async () => {
    if (deferredPrompt) { deferredPrompt.prompt(); const { outcome } = await deferredPrompt.userChoice; if (outcome === "accepted") deferredPrompt = null; installDiv.style.display = "none"; }
  });
  document.getElementById("closeInstallBtn")?.addEventListener("click", () => { installDiv.style.display = "none"; });
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js");
