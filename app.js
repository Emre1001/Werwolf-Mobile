// app.js – Werwolf Mobile | Kein automatischer Start, min. 4 Spieler
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, onSnapshot, updateDoc, collection, query, where, getDocs, setDoc, deleteDoc, arrayUnion, getDoc, addDoc, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ========== FIREBASE KONFIGURATION ==========
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
  console.log("✅ Firebase verbunden");
} catch(e) { console.error("Firebase init error", e); }

// ========== CONSENT MANAGEMENT ==========
const CONSENT_KEY = "werwolf_consent_given";
let consentGiven = localStorage.getItem(CONSENT_KEY) === "true";

function showConsentModal() { document.getElementById("consent-modal").style.display = "flex"; }
function acceptConsent() { localStorage.setItem(CONSENT_KEY, "true"); consentGiven = true; document.getElementById("consent-modal").style.display = "none"; initApp(); }
function rejectConsent() { alert("Ohne Zustimmung kann die App nicht genutzt werden."); }

// ========== OFFLINE-ERKENNUNG ==========
let isOnline = navigator.onLine;
function showOfflineModal() { document.getElementById("offline-modal").style.display = "flex"; }
function hideOfflineModal() { document.getElementById("offline-modal").style.display = "none"; }
window.addEventListener("online", () => { isOnline = true; hideOfflineModal(); if(consentGiven && firebaseReady) initApp(); });
window.addEventListener("offline", () => { isOnline = false; showOfflineModal(); });

// ========== RECHTSTEXTE ==========
function showImpressum() { const modal = document.getElementById("legal-modal"); document.getElementById("legal-modal-title").innerText = "Impressum"; document.getElementById("legal-modal-body").innerHTML = `<p><strong>Angaben gemäß § 5 TMG:</strong></p><p>Emre Asik<br>E-Mail: emre.asik201060@gmail.com</p><p>Die Anschrift wird aus Datenschutzgründen nicht öffentlich angezeigt. Sie erhalten diese auf Anfrage.</p><p><strong>Verantwortlich für den Inhalt:</strong> Emre Asik</p>`; modal.style.display = "flex"; }
function showDatenschutz() { const modal = document.getElementById("legal-modal"); document.getElementById("legal-modal-title").innerText = "Datenschutzerklärung"; document.getElementById("legal-modal-body").innerHTML = `<p><strong>1. Verantwortlicher</strong><br>Emre Asik, emre.asik201060@gmail.com</p><p><strong>2. Erhobene Daten</strong><br>Spieler-ID, Geräte-ID (LocalStorage). Technisch notwendig.</p><p><strong>3. Rechtsgrundlage</strong><br>Art. 6 Abs. 1 lit. a, b DSGVO. Einwilligung jederzeit widerrufbar.</p><p><strong>4. Weitergabe</strong><br>Keine Weitergabe an Dritte.</p>`; modal.style.display = "flex"; }
function closeLegalModal() { document.getElementById("legal-modal").style.display = "none"; }

// ========== GLOBALE ZUSTÄNDE ==========
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2); }
let deviceId = localStorage.getItem("ww_device_id");
if (!deviceId && consentGiven) { deviceId = uuid(); localStorage.setItem("ww_device_id", deviceId); }
let currentUser = { id: localStorage.getItem("ww_player_id") || uuid(), name: "", deviceId: deviceId };
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

const ui = document.getElementById("ui-container");
function render(html) { ui.innerHTML = html; ui.classList.add("fade-transition"); setTimeout(() => ui.classList.remove("fade-transition"), 500); }

function showModal(contentHtml, onClose) {
  const modalDiv = document.createElement("div");
  modalDiv.className = "modal";
  modalDiv.innerHTML = `<div class="modal-content glass-card">${contentHtml}<div style="text-align:center; margin-top:1.5rem;"><button class="glass-button" id="modalClose">Schließen</button></div></div>`;
  document.body.appendChild(modalDiv);
  modalDiv.querySelector("#modalClose")?.addEventListener("click", () => { modalDiv.remove(); if(onClose) onClose(); });
  return modalDiv;
}

function showRoleFor10Seconds(role, description) {
  const roleDisplay = document.getElementById("role-display");
  document.getElementById("role-name").innerText = role;
  document.getElementById("role-description").innerHTML = description;
  const timerSpan = document.getElementById("role-timer");
  roleDisplay.style.display = "flex";
  let seconds = 10;
  timerSpan.innerText = seconds;
  if (roleDisplayTimeout) clearInterval(roleDisplayTimeout);
  const interval = setInterval(() => { seconds--; timerSpan.innerText = seconds; if (seconds <= 0) { clearInterval(interval); roleDisplay.style.display = "none"; } }, 1000);
  roleDisplayTimeout = setTimeout(() => { clearInterval(interval); roleDisplay.style.display = "none"; }, 10000);
}

// Inaktive Spieler prüfen – nur vom Host aufgerufen, separates Intervall
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
  // Sofort heartbeat senden
  const sendHB = async () => {
    if (!currentLobbyId || !firebaseReady) return;
    try {
      await updateDoc(doc(db, "lobbies", currentLobbyId), {
        [`heartbeats.${currentUser.id}`]: Date.now()
      });
    } catch(e) { console.warn("HB error", e); }
  };
  sendHB();
  heartbeatInterval = setInterval(sendHB, 30000);
}
function startInactiveCheck(lobbyId) {
  if (inactiveCheckInterval) clearInterval(inactiveCheckInterval);
  inactiveCheckInterval = setInterval(() => checkInactivePlayers(lobbyId), 60000);
}

async function createLobby(playerName, isPublic, mode, settings) {
  if (!consentGiven || !firebaseReady || !isOnline) throw new Error("Keine Verbindung");
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const lobbyRef = doc(db, "lobbies", code);
  const player = { id: currentUser.id, name: playerName, deviceId: deviceId, isAlive: true, role: null, hasUsedAction: false, lastSeen: Date.now() };
  const isAutoNarrator = (mode === "online");
  await setDoc(lobbyRef, {
    code, hostId: currentUser.id, gameStarted: false, phase: "LOBBY", narratorStep: null,
    players: [player], isPublic: isPublic, mode: mode, settings: settings,
    volunteerNarratorId: null, confirmedNarratorId: isAutoNarrator ? "AUTOMATIC" : null,
    actionData: { werewolfVotes: {}, seerTarget: null, witch: { usedHeal: false, usedPoison: false, healTarget: null, poisonTarget: null }, smallGirlPeeked: false, peekResult: null, lovers: [], nightVictim: null, hunterRevenge: null, publicVotes: {} },
    votes: {}, nightActionsOrder: [], currentNightIndex: 0, lastUpdate: Date.now(),
    heartbeats: { [currentUser.id]: Date.now() }, chatClearedAt: Date.now()
  });
  currentLobbyId = code;
  startHeartbeat(code);
  startInactiveCheck(code);
  attachListener(code);
  // KEIN AUTOMATISCHER START MEHR
}

async function joinLobby(code, playerName) {
  if (!consentGiven || !firebaseReady || !isOnline) throw new Error("Keine Verbindung");
  const q = query(collection(db, "lobbies"), where("code", "==", code));
  const snap = await getDocs(q);
  if (snap.empty) throw new Error("Lobby nicht gefunden");
  const lobbyDoc = snap.docs[0];
  const data = lobbyDoc.data();
  
  // Stale-Check: Wenn die Lobby seit 5 Min nicht aktualisiert wurde, löschen wir sie
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
    const newPlayer = { id: currentUser.id, name: playerName, deviceId: deviceId, isAlive: true, role: null, hasUsedAction: false, lastSeen: Date.now() };
    await updateDoc(lobbyDoc.ref, { players: arrayUnion(newPlayer) });
  }
  currentLobbyId = code;
  startHeartbeat(code);
  startInactiveCheck(code);
  attachListener(code);
}

// Hilfsfunktion zum Aufräumen veralteter Lobbys
async function cleanupStaleLobbies(lobbies) {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 Minuten Inaktivität
  for (const lobby of lobbies) {
    if (lobby.lastUpdate && (now - lobby.lastUpdate > timeout)) {
      console.log(`Lobby ${lobby.code} ist veraltet und wird gelöscht.`);
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
  if (playerIdToKick === currentUser.id) {
    currentLobbyId = null;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    showLobbyMenu();
    alert("Du wurdest gekickt.");
  }
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

function attachListener(lobbyId) {
  if (unsubscribeLobby) unsubscribeLobby();
  lastStateFingerprint = null;
  const lobbyRef = doc(db, "lobbies", lobbyId);
  unsubscribeLobby = onSnapshot(lobbyRef, async (snap) => {
    if (!snap.exists()) {
      render(`<div class="glass-card"><h2>Lobby aufgelöst</h2><button class="glass-button" id="backHome">Startseite</button></div>`);
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
      return;
    }
    // Chat-Cleared-Timestamp aktualisieren
    chatClearedAt = data.chatClearedAt || 0;
    // Chat-Kanal bestimmen (nur Online-Modus)
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
    // State-Deduplizierung: Nur rendern wenn sich etwas Relevantes geändert hat
    const fp = stateFingerprint(data);
    if (fp === lastStateFingerprint) return;
    lastStateFingerprint = fp;
    // Gewinnbedingung prüfen
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
    actionData: { wv: lobby.actionData?.werewolfVotes, st: lobby.actionData?.seerTarget,
      sgp: lobby.actionData?.smallGirlPeeked, w: lobby.actionData?.witch, nv: lobby.actionData?.nightVictim }
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
  const emoji = winner === "VILLAGE" ? "🏘️" : "🐺";
  const title = winner === "VILLAGE" ? "Dorf gewinnt!" : "Werwölfe gewinnen!";
  const desc = winner === "VILLAGE" ? "Alle Werwölfe wurden eliminiert!" : "Die Werwölfe haben das Dorf übernommen!";
  render(`<div class="glass-card" style="text-align:center; padding:2.5rem;">
    <div style="font-size:4rem; margin-bottom:1rem;">${emoji}</div>
    <h1>${title}</h1><p style="margin:1rem 0; opacity:0.8;">${desc}</p>
    <div style="margin:1.5rem 0;"><strong>Rollen:</strong><br>${lobby.players.map(p => `<span class="player-tag">${p.name}: ${p.role} ${p.isAlive ? '✅' : '💀'}</span>`).join(' ')}</div>
    <button class="glass-button" id="backToMenu">Zurück zum Menü</button>
  </div>`);
  document.getElementById("backToMenu")?.addEventListener("click", async () => {
    try { await deleteDoc(doc(db, "lobbies", lobby.id)); } catch(e) {}
    currentLobbyId = null; showLobbyMenu();
  });
}

// ========== CHAT SYSTEM ==========
function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

function determineChatChannel(lobby, player) {
  if (!lobby || !player || lobby.mode === "lokal") return null;
  if (!lobby.gameStarted) return "public";
  if (!player.isAlive) return "dead";
  if (lobby.phase === "NIGHT") return player.role === "Werwolf" ? "wolf" : null;
  return "public"; // DAY + VOTING
}

function attachChatListener(lobbyId) {
  if (unsubscribeChat) unsubscribeChat();
  const messagesRef = collection(db, "lobbies", lobbyId, "messages");
  const q = query(messagesRef, orderBy("timestamp", "asc"));
  unsubscribeChat = onSnapshot(q, (snap) => {
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
  }).join('');
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
  if (container) container.style.display = "none";
  if (unsubscribeChat) { unsubscribeChat(); unsubscribeChat = null; }
}


/**
 * Automatische Phasensteuerung im Online-Modus.
 * Wird nur vom Host ausgeführt, um Race-Conditions zu vermeiden.
 */
async function checkAutomaticAdvance(lobby) {
  const { phase, narratorStep, players, actionData, votes, settings } = lobby;
  
  if (phase === "NIGHT") {
    if (narratorStep === "WEREWOLF") {
      const aliveWolves = players.filter(p => p.isAlive && p.role === "Werwolf");
      const voteCount = Object.keys(actionData.werewolfVotes || {}).length;
      if (aliveWolves.length > 0 && voteCount >= aliveWolves.length) {
        await advanceNightPhase(lobby);
      } else if (aliveWolves.length === 0) {
        await advanceNightPhase(lobby);
      }
    } else if (narratorStep === "SMALL_GIRL") {
      const girl = players.find(p => p.role === "Kleines Mädchen");
      if (!girl || !girl.isAlive || actionData.smallGirlPeeked) {
        await advanceNightPhase(lobby);
      }
    } else if (narratorStep === "SEER") {
      const seer = players.find(p => p.role === "Seherin");
      if (!seer || !seer.isAlive || actionData.seerTarget) {
        await advanceNightPhase(lobby);
      }
    } else if (narratorStep === "WITCH") {
      const witch = players.find(p => p.role === "Hexe");
      // Die Hexe ist etwas komplexer, da sie 2 Tränke hat. 
      // Wir warten hier vielleicht auf eine Bestätigung oder überspringen, wenn tot.
      if (!witch || !witch.isAlive) {
        await advanceNightPhase(lobby);
      }
      // HINWEIS: Manuelle Steuerung für Hexe im Online-Modus empfohlen, 
      // oder wir fügen einen "Fertig"-Button für sie ein.
    }
  } else if (phase === "VOTING") {
    const alivePlayers = players.filter(p => p.isAlive && p.role !== "ERZÄHLER");
    const voteCount = Object.keys(votes || {}).length;
    if (voteCount >= alivePlayers.length) {
      await resolveVoting(lobby);
    }
  }
}

function renderByState(lobby) {
  const players = lobby.players || [];
  const currentPlayer = players.find(p => p.id === currentUser.id);
  const isHost = (lobby.hostId === currentUser.id);
  // Nur der tatsächlich ausgewählte Mensch ist der "Erzähler". 
  // "AUTOMATIC" (Online-Modus) bedeutet, es gibt keinen privilegierten menschlichen Erzähler.
  const isHumanNarrator = (lobby.confirmedNarratorId === currentUser.id);

  if (!lobby.gameStarted) {
    renderLobbyView(lobby, isHost, currentPlayer);
    return;
  }

  // Fallunterscheidung nach Spielstart:
  if (isHumanNarrator) {
    // Der Erzähler sieht alles (Dashboard mit Rollen/Votes)
    renderNarratorDashboard(lobby);
  } else if (currentPlayer) {
    // Spieler sehen ihre eigene Rolle und den aktuellen Spielstatus (Script)
    renderPlayerGameView(lobby, currentPlayer);
  } else if (isHost) {
    // Sonderfall: Host ist nicht Spieler und nicht Erzähler (Beobachter-Host)
    renderHostOnlyGameView(lobby);
  } else {
    render(`<div class="glass-card"><p>Beobachter-Modus.</p><button class="glass-button" onclick="location.reload()">Neu laden</button></div>`);
  }
}

function getNarratorScript(lobby) {
  const { phase, narratorStep, nightActionsOrder, currentNightIndex } = lobby;
  if (phase === "NIGHT") {
    const step = nightActionsOrder[currentNightIndex];
    if (step === "WEREWOLF") return "🌕 Werwölfe, erwacht! Wählt ein Opfer.";
    if (step === "SMALL_GIRL") return "👧 Kleines Mädchen – willst du spionieren?";
    if (step === "SEER") return "🔮 Seherin, öffne die Augen.";
    if (step === "WITCH") return "🧪 Hexe, der Angriff fiel auf...";
    return "🌙 Nacht – Die Stadt schläft.";
  } else if (phase === "DAY") {
    return "🌞 Tag – Diskutiert! Wer ist ein Werwolf?";
  } else if (phase === "VOTING") {
    return "🗳️ Abstimmung! Wer soll erhängt werden?";
  }
  return "";
}

function renderHostOnlyGameView(lobby) {
  render(`
      <div style="margin-top:1.5rem; display:flex; gap:1rem; flex-wrap:wrap;">
        <button class="glass-button" id="leaveLobbyBtn">Verlassen</button>
        <button class="glass-button" id="endGame" style="background:#ef4444;">Spiel beenden</button>
      </div>
    </div>
  `);
  document.getElementById("leaveLobbyBtn")?.addEventListener("click", () => leaveLobby(lobby.id, currentUser.id, lobby.hostId));
  document.getElementById("endGame")?.addEventListener("click", async () => { if(confirm("Spiel beenden?")){ await deleteDoc(doc(db,"lobbies",lobby.id)); hideChat(); showLobbyMenu(); } });
}

function renderLobbyView(lobby, isHost, currentPlayer) {
  const players = lobby.players;
  const playerCount = players.length;
  const MIN_PLAYERS = 4;
  const confirmedId = lobby.confirmedNarratorId;
  const activePlayerCount = players.length - (confirmedId && lobby.mode === "lokal" ? 1 : 0);
  
  let canStart = false;
  if (lobby.mode === "online") {
    canStart = (activePlayerCount >= MIN_PLAYERS);
  } else {
    canStart = (activePlayerCount >= MIN_PLAYERS && confirmedId !== null);
  }
  const volunteerId = lobby.volunteerNarratorId;
  const alreadyVolunteered = (volunteerId === currentUser.id);
  let volunteerSection = '';
  if (lobby.mode !== "online") {
    if (!confirmedId) {
      if (!alreadyVolunteered) volunteerSection = `<button class="glass-button glass-button-small" id="volunteerBtn">🐺 Als Erzähler melden</button>`;
      else volunteerSection = `<p>✅ Du hast dich gemeldet. Warte auf Bestätigung.</p>`;
    } else {
      volunteerSection = `<p>📢 Erzähler: ${players.find(p => p.id === confirmedId)?.name || 'unbekannt'}</p>`;
    }
  } else {
    volunteerSection = `<p>🤖 Online-Modus: Automatischer Erzähler aktiv.</p>`;
  }
  let hostControls = '';
  if (isHost && lobby.mode !== "online") {
    const volunteerPlayer = players.find(p => p.id === volunteerId);
    hostControls = `
      <div style="margin: 1.2rem 0; padding: 1rem; background: rgba(0,0,0,0.3); border-radius: 1.2rem;">
        <h3 style="margin-bottom:0.8rem;">Host-Einstellungen</h3>
        ${volunteerId ? `<p>Freiwilliger Erzähler: ${volunteerPlayer?.name} <button class="glass-button glass-button-small" id="confirmNarratorBtn">Bestätigen</button></p>` : '<p>Kein Freiwilliger.</p>'}
        <div><strong>Rollen aktivieren:</strong></div>
        <div class="roles-grid" id="roleToggles">${renderRoleToggles(lobby.settings || {})}</div>
        <button class="glass-button" id="saveSettingsBtn" style="margin-top:0.8rem;">Speichern</button>
      </div>
    `;
  } else if (isHost && lobby.mode === "online") {
    hostControls = `
      <div style="margin: 1.2rem 0; padding: 1rem; background: rgba(0,0,0,0.3); border-radius: 1.2rem;">
        <h3>Online-Modus Einstellungen</h3>
        <div class="roles-grid" id="roleToggles">${renderRoleToggles(lobby.settings || {})}</div>
        <button class="glass-button" id="saveSettingsBtn">Speichern</button>
      </div>
    `;
  }
  const playersHtml = players.map(p => `
    <div class="player-tag">
      ${p.name} ${p.id === lobby.hostId ? '👑 Host' : ''} ${p.id === confirmedId ? '🎙️ Erzähler' : ''}
      ${isHost && p.id !== currentUser.id ? `<button class="glass-button glass-button-small kick-btn" data-player-id="${p.id}" style="margin-left:0.5rem; background:#ef4444; padding:0.2rem 0.6rem;">Kicken</button>` : ''}
    </div>
  `).join('');
  const startDisabled = !canStart;
  let startHint = "";
  if (!canStart) {
    if (activePlayerCount < MIN_PLAYERS) startHint = `${MIN_PLAYERS} Spieler benötigt (aktuell ${activePlayerCount})`;
    else if (lobby.mode !== "online" && confirmedId === null) startHint = "Erzähler muss bestätigt werden";
  }
  render(`
    <div class="glass-card">
      <h2><i class="fas fa-door-open"></i> Lobby: ${lobby.code} <span class="public-badge ${lobby.isPublic ? 'public' : 'private'}">${lobby.isPublic ? 'ÖFFENTLICH' : 'PRIVAT'}</span> <span style="margin-left:0.5rem;">${lobby.mode === 'online' ? '🌐 Online-Modus' : '🏠 Lokal-Modus'}</span></h2>
      <div class="player-list">${playersHtml}</div>
      <div>👥 ${playerCount} / ${MIN_PLAYERS}+ Spieler</div>
      <div>${volunteerSection}</div>
      ${hostControls}
      <div style="margin-top:1.5rem; display:flex; gap:1rem; flex-wrap:wrap; align-items:center;">
        ${isHost ? `<button class="glass-button" id="startGameBtn" ${startDisabled ? 'disabled style="opacity:0.5;"' : ''}>Spiel starten</button>${startHint ? `<span style="font-size:0.8rem;">${startHint}</span>` : ''}` : ''}
        <button class="glass-button" id="leaveLobbyBtn">Verlassen</button>
      </div>
    </div>
  `);
  document.querySelectorAll(".kick-btn").forEach(btn => btn.addEventListener("click", (e) => { e.stopPropagation(); kickPlayer(lobby.id, btn.dataset.playerId); }));
  if (lobby.mode !== "online" && !confirmedId && !alreadyVolunteered) document.getElementById("volunteerBtn")?.addEventListener("click", async () => { await updateDoc(doc(db, "lobbies", lobby.id), { volunteerNarratorId: currentUser.id }); });
  if (isHost && lobby.mode !== "online" && volunteerId) document.getElementById("confirmNarratorBtn")?.addEventListener("click", async () => { await updateDoc(doc(db, "lobbies", lobby.id), { confirmedNarratorId: volunteerId }); });
  if (isHost) {
    const saveBtn = document.getElementById("saveSettingsBtn");
    if (saveBtn) saveBtn.addEventListener("click", async () => { const newSettings = {}; document.querySelectorAll(".role-card").forEach(card => { newSettings[card.dataset.role] = card.classList.contains("selected"); }); await updateDoc(doc(db, "lobbies", lobby.id), { settings: newSettings }); });
    document.querySelectorAll(".role-card").forEach(card => card.addEventListener("click", () => card.classList.toggle("selected")));
  }
  document.getElementById("startGameBtn")?.addEventListener("click", () => startGame(lobby));
  document.getElementById("leaveLobbyBtn")?.addEventListener("click", () => leaveLobby(lobby.id, currentUser.id, lobby.hostId));
}

function renderRoleToggles(settings) {
  const allRoles = ["Dorfbewohner","Werwolf","Seherin","Hexe","Amor","Jäger","Kleines Mädchen"];
  return allRoles.map(role => `<div class="role-card ${settings[role] !== false ? 'selected' : ''}" data-role="${role}"><i class="fas ${role === 'Werwolf' ? 'fa-paw' : role === 'Seherin' ? 'fa-eye' : role === 'Hexe' ? 'fa-flask' : role === 'Amor' ? 'fa-heart' : role === 'Jäger' ? 'fa-crosshairs' : role === 'Kleines Mädchen' ? 'fa-child' : 'fa-user'}"></i> ${role}</div>`).join('');
}

async function startGame(lobby) {
  const { id: lobbyCode, players: playersArr, settings, confirmedNarratorId, mode } = lobby;
  
  // Bestimme Spieler, die eine Rolle erhalten (Erzähler spielt im Lokal-Modus nicht mit)
  let playersToAssign = [...playersArr];
  if (mode === "lokal" && confirmedNarratorId && confirmedNarratorId !== "AUTOMATIC") {
    playersToAssign = playersToAssign.filter(p => p.id !== confirmedNarratorId);
  }

  // Prüfe nochmal Mindestanzahl (Spieler die Rollen bekommen)
  if (playersToAssign.length < 4) {
    alert("Es werden mindestens 4 Spieler (ohne Erzähler) benötigt!");
    return;
  }

  const enabledRoles = [];
  if (settings.Dorfbewohner !== false) enabledRoles.push("Dorfbewohner");
  if (settings.Werwolf !== false) enabledRoles.push("Werwolf", "Werwolf");
  if (settings.Seherin !== false) enabledRoles.push("Seherin");
  if (settings.Hexe !== false) enabledRoles.push("Hexe");
  if (settings.Amor !== false) enabledRoles.push("Amor");
  if (settings.Jäger !== false) enabledRoles.push("Jäger");
  if (settings["Kleines Mädchen"] !== false) enabledRoles.push("Kleines Mädchen");
  
  let rolePool = [...enabledRoles];
  if (rolePool.filter(r => r === "Werwolf").length < 2 && rolePool.includes("Werwolf")) rolePool.push("Werwolf");
  while (rolePool.length < playersToAssign.length) rolePool.push("Dorfbewohner");
  
  const shuffledRoles = [...rolePool].sort(() => Math.random() - 0.5);
  
  // Weise Rollen zu und setze den Erzähler auf "Beobachter" (keine Rolle)
  const assigned = playersArr.map(p => {
    const assignIdx = playersToAssign.findIndex(pa => pa.id === p.id);
    if (assignIdx !== -1) {
      // Spieler bekommt eine Rolle
      return { ...p, role: shuffledRoles[assignIdx % shuffledRoles.length], isAlive: true };
    } else {
      // Erzähler bekommt keine Rolle
      return { ...p, role: "ERZÄHLER", isAlive: true };
    }
  });

  const roleDesc = { "Dorfbewohner": "Keine Fähigkeit, aber deine Stimme zählt.", "Werwolf": "Du erwächst in der Nacht und wählst ein Opfer.", "Seherin": "Erkenne die Rolle eines Spielers.", "Hexe": "Heil- und Giftrank – rette oder töte.", "Amor": "Bestimme zwei Liebende in der ersten Nacht.", "Jäger": "Wenn du stirbst, nimm einen anderen mit.", "Kleines Mädchen": "Spioniere mit 50% Risiko." };
  const myData = assigned.find(p => p.id === currentUser.id);
  if (myData && myData.role !== "ERZÄHLER") {
    showRoleFor10Seconds(myData.role, roleDesc[myData.role] || "Spiele deine Rolle klug.");
  } else if (myData && myData.role === "ERZÄHLER") {
    showRoleFor10Seconds("Erzähler", "Du leitest das Spiel. Sorge für eine spannende Atmosphäre!");
  }

  let lovers = [];
  const amor = assigned.find(p => p.role === "Amor");
  if (amor) { const alive = assigned.filter(p => p.id !== amor.id && p.role !== "ERZÄHLER"); if (alive.length >= 2) lovers = [alive[0].id, alive[1].id]; }
  
  const nightOrder = ["WEREWOLF", "SMALL_GIRL", "SEER", "WITCH"];
  
  await updateDoc(doc(db, "lobbies", lobbyCode), {
    gameStarted: true, phase: "NIGHT", players: assigned,
    actionData: { werewolfVotes: {}, seerTarget: null, witch: { usedHeal: false, usedPoison: false, healTarget: null, poisonTarget: null }, smallGirlPeeked: false, peekResult: null, lovers, nightVictim: null, hunterRevenge: null, publicVotes: {} },
    nightActionsOrder: nightOrder, currentNightIndex: 0, narratorStep: "WEREWOLF", votes: {},
    chatClearedAt: Date.now()
  });
}

function renderNarratorDashboard(lobby) {
  const { phase, narratorStep, players, actionData, votes, id } = lobby;
  const script = getNarratorScript(lobby);
  let canNext = true; // In der Erzähler-Konsole kann man immer weiter klicken, wenn man menschlich ist.
  
  let liveVotesHtml = '';
  if (phase === "NIGHT" && narratorStep === "WEREWOLF") {
    const wv = actionData.werewolfVotes || {};
    const entries = Object.entries(wv);
    liveVotesHtml = `<div class="vote-detail-list"><strong>🐺 Werwolf-Votes:</strong>${entries.length ? entries.map(([pid, tid]) => `<div class="vote-detail-item"><span>${players.find(p=>p.id===pid)?.name||"?"}</span><span>→ ${players.find(p=>p.id===tid)?.name||"?"}</span></div>`).join('') : '<div>Keine Stimmen</div>'}</div>`;
  } else if (phase === "VOTING") {
    const v = votes || {};
    const entries = Object.entries(v);
    liveVotesHtml = `<div class="vote-detail-list"><strong>🗳️ Abstimmungsdetails:</strong>${entries.length ? entries.map(([pid, tid]) => `<div class="vote-detail-item"><span>${players.find(p=>p.id===pid)?.name||"?"}</span><span>→ ${players.find(p=>p.id===tid)?.name||"?"}</span></div>`).join('') : '<div>Keine Stimmen</div>'}</div>`;
  }

  const nextHandler = async () => {
    if (phase === "NIGHT") await advanceNightPhase(lobby);
    else if (phase === "DAY") await updateDoc(doc(db, "lobbies", id), { phase: "VOTING", narratorStep: "VOTING", votes: {}, chatClearedAt: Date.now() });
    else if (phase === "VOTING") await resolveVoting(lobby);
  };

  render(`
    <div class="glass-card">
      <h2><i class="fas fa-torah"></i> Erzähler-Konsole — ${lobby.code}</h2>
      <div class="narrator-script"><i class="fas fa-microphone-alt"></i> <strong>Skript:</strong><br/>${script}</div>
      <div style="margin: 1rem 0;"><strong>Rollen-Info (Geheim!):</strong><br/>
        ${players.map(p => `<span class="player-tag ${p.isAlive ? '' : 'dead'}">${p.name}: ${p.role}</span>`).join(' ')}
      </div>
      <div><strong>Lebende:</strong> ${players.filter(p=>p.isAlive).map(p=>p.name).join(', ')}</div>
      ${liveVotesHtml}
      <div style="margin-top:1.5rem; display:flex; gap:1rem; flex-wrap:wrap;">
        <button class="glass-button" id="narratorNext">Phase weiter</button>
        <button class="glass-button" id="leaveLobbyBtn">Verlassen</button>
        <button class="glass-button" id="endGame" style="background:#ef4444;">Spiel beenden</button>
      </div>
    </div>
  `);
  document.getElementById("narratorNext")?.addEventListener("click", nextHandler);
  document.getElementById("leaveLobbyBtn")?.addEventListener("click", () => leaveLobby(id, currentUser.id, lobby.hostId));
  document.getElementById("endGame")?.addEventListener("click", async () => { if(confirm("Spiel beenden?")){ await deleteDoc(doc(db,"lobbies",lobby.id)); hideChat(); showLobbyMenu(); } });
}

async function advanceNightPhase(lobby) {
  const { id, nightActionsOrder, currentNightIndex } = lobby;
  const step = nightActionsOrder[currentNightIndex];
  if (step === "WEREWOLF") await resolveWerewolfKill(lobby);
  else if (step === "WITCH") await resolveWitch(lobby);
  const nextIdx = currentNightIndex + 1;
  if (nextIdx >= nightActionsOrder.length) {
    await resolveNightDeath(lobby);
    await updateDoc(doc(db, "lobbies", id), { phase: "DAY", narratorStep: "DAY", chatClearedAt: Date.now() });
  } else {
    await updateDoc(doc(db, "lobbies", id), { currentNightIndex: nextIdx, narratorStep: nightActionsOrder[nextIdx] });
  }
}
async function resolveWerewolfKill(lobby) {
  const votes = lobby.actionData?.werewolfVotes || {};
  const counts = {};
  Object.values(votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
  let maxId = null, max = 0;
  for (let [id, c] of Object.entries(counts)) if (c > max) { max = c; maxId = id; }
  await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.nightVictim": maxId });
}
async function resolveWitch(lobby) {
  const witch = lobby.actionData.witch;
  let victim = lobby.actionData.nightVictim;
  if (witch.healTarget === victim) victim = null;
  if (witch.poisonTarget) victim = witch.poisonTarget;
  if (victim) {
    const updated = lobby.players.map(p => p.id === victim ? { ...p, isAlive: false } : p);
    await updateDoc(doc(db, "lobbies", lobby.id), { players: updated, "actionData.nightVictim": null });
  }
}
async function resolveNightDeath(lobby) {
  let victim = lobby.actionData.nightVictim;
  if (!victim) return;
  let players = lobby.players.map(p => p.id === victim ? { ...p, isAlive: false } : p);
  const dead = lobby.players.find(p => p.id === victim);
  if (dead?.role === "Jäger") {
    const alive = players.filter(p => p.isAlive);
    const name = prompt(`Jäger stirbt! Rache: ${alive.map(p=>p.name).join(", ")}`);
    const target = players.find(p => p.name === name);
    if (target) players = players.map(p => p.id === target.id ? { ...p, isAlive: false } : p);
  }
  await updateDoc(doc(db, "lobbies", lobby.id), { players });
}
async function resolveVoting(lobby) {
  const votes = lobby.votes || {};
  const counts = {};
  Object.values(votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
  let maxId = null, max = 0;
  for (let [id, c] of Object.entries(counts)) if (c > max) { max = c; maxId = id; }
  if (!maxId) return;
  let players = lobby.players.map(p => p.id === maxId ? { ...p, isAlive: false } : p);
  const lynched = lobby.players.find(p => p.id === maxId);
  if (lynched?.role === "Jäger") {
    const alive = players.filter(p => p.isAlive);
    const revenge = prompt(`Jäger lyncht! Töte: ${alive.map(p=>p.name).join(", ")}`);
    const target = players.find(p => p.name === revenge);
    if (target) players = players.map(p => p.id === target.id ? { ...p, isAlive: false } : p);
  }
  const lovers = lobby.actionData?.lovers || [];
  if (lovers.includes(maxId)) {
    const other = lovers.find(l => l !== maxId);
    players = players.map(p => p.id === other ? { ...p, isAlive: false } : p);
  }
  await updateDoc(doc(db, "lobbies", lobby.id), { players, phase: "NIGHT", currentNightIndex: 0, narratorStep: "WEREWOLF", votes: {}, "actionData.werewolfVotes": {}, chatClearedAt: Date.now() });
}

function renderPlayerGameView(lobby, player) {
  const isHost = (lobby.hostId === currentUser.id);
  const scriptContent = `<div class="narrator-script" style="margin-bottom:1rem;"><i class="fas fa-volume-up"></i> <strong>Status:</strong><br/>${getNarratorScript(lobby)}</div>`;
  
  if (!player.isAlive) {
    render(`
      <div class="glass-card">
        <h2>⚰️ Tot</h2>
        ${scriptContent}
        <p>Du bist im Jenseits. Beobachte das Spiel.</p>
        <div style="margin-top:1.5rem; display:flex; gap:1rem; flex-wrap:wrap;">
          <button class="glass-button" id="leaveLobbyBtn">Verlassen</button>
          ${isHost ? `<button class="glass-button" id="endGameHost" style="background:#ef4444;">Spiel beenden</button>` : ''}
        </div>
      </div>
    `);
    document.getElementById("leaveLobbyBtn")?.addEventListener("click", () => leaveLobby(lobby.id, currentUser.id, lobby.hostId));
    document.getElementById("endGameHost")?.addEventListener("click", async () => { if(confirm("Spiel beenden?")){ await deleteDoc(doc(db,"lobbies",lobby.id)); hideChat(); showLobbyMenu(); } });
    return;
  }

  const { phase, narratorStep, players } = lobby;
  
  // Gemeinsame UI für alle Phasen (Script + eigene Rolle)
  const baseHeader = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
      <span class="player-tag" style="background:rgba(124,58,237,0.3); border:1px solid #7c3aed;">Rolle: ${player.role}</span>
      <div style="display:flex; gap:0.5rem;">
        <button class="glass-button-small" id="leaveLobbyBtn">Verlassen</button>
        ${isHost ? `<button class="glass-button-small" id="endGameHost" style="background:#ef4444;">Beenden</button>` : ''}
      </div>
    </div>
    ${scriptContent}
  `;

  const attachBaseListeners = () => {
    document.getElementById("leaveLobbyBtn")?.addEventListener("click", () => leaveLobby(lobby.id, currentUser.id, lobby.hostId));
    document.getElementById("endGameHost")?.addEventListener("click", async () => { if(confirm("Spiel beenden?")){ await deleteDoc(doc(db,"lobbies",lobby.id)); hideChat(); showLobbyMenu(); } });
  };

  if (phase === "NIGHT") {
    const role = player.role;
    if (narratorStep === "WEREWOLF" && role === "Werwolf") {
      const targets = players.filter(p => p.isAlive && p.id !== player.id);
      render(`
        <div class="glass-card">
          ${baseHeader}
          <h2>🐺 Opfer wählen</h2>
          <div class="vote-grid" id="wolfTargets">${targets.map(t => `<div class="vote-card" data-id="${t.id}">${t.name} ${t.role==='Werwolf'?'(Kollege)':''}</div>`).join('')}</div>
          <button class="glass-button" id="submitWolfVote">Bestätigen</button>
        </div>
      `);
      let selected = null;
      document.querySelectorAll("#wolfTargets .vote-card").forEach(c => c.addEventListener("click", function(){ selected=this.dataset.id; document.querySelectorAll("#wolfTargets .vote-card").forEach(c=>c.classList.remove("selected")); this.classList.add("selected"); }));
      document.getElementById("submitWolfVote")?.addEventListener("click", async () => {
        if(selected){ const cur = lobby.actionData?.werewolfVotes || {}; cur[player.id]=selected; await updateDoc(doc(db,"lobbies",lobby.id),{"actionData.werewolfVotes":cur}); render(`<div class="glass-card">${baseHeader}<p>✅ Abgestimmt.</p></div>`); attachBaseListeners(); }
      });
      attachBaseListeners();
      return;
    }
    if (narratorStep === "SMALL_GIRL" && role === "Kleines Mädchen") {
      render(`
        <div class="glass-card">
          ${baseHeader}
          <h2>👧 Spionieren?</h2>
          <button class="glass-button" id="peekYes">Ja (50% Risiko)</button>
          <button class="glass-button" id="peekNo">Nein</button>
        </div>
      `);
      document.getElementById("peekYes")?.addEventListener("click", async () => {
        const risk = Math.random()<0.5;
        alert(risk?"Entdeckt und stirbst!":"Werwölfe: "+players.filter(p=>p.role==="Werwolf"&&p.isAlive).map(p=>p.name).join(", "));
        if(risk){ const updated = players.map(p=>p.id===player.id?{...p,isAlive:false}:p); await updateDoc(doc(db,"lobbies",lobby.id),{players:updated,"actionData.smallGirlPeeked":true}); }
        else await updateDoc(doc(db,"lobbies",lobby.id),{"actionData.smallGirlPeeked":true});
      });
      document.getElementById("peekNo")?.addEventListener("click", async () => { await updateDoc(doc(db,"lobbies",lobby.id),{"actionData.smallGirlPeeked":true}); render(`<div class="glass-card">${baseHeader}<p>Sicher versteckt.</p></div>`); attachBaseListeners(); });
      attachBaseListeners();
      return;
    }
    if (narratorStep === "SEER" && role === "Seherin") {
      const targets = players.filter(p => p.isAlive && p.id !== player.id);
      render(`
        <div class="glass-card">
          ${baseHeader}
          <h2>🔮 Wähle Spieler</h2>
          <div class="vote-grid" id="seerTargets">${targets.map(t=>`<div class="vote-card" data-id="${t.id}">${t.name}</div>`).join('')}</div>
          <button class="glass-button" id="seerSubmit">Erkennen</button>
        </div>
      `);
      let selected = null;
      document.querySelectorAll("#seerTargets .vote-card").forEach(c=>c.addEventListener("click",function(){selected=this.dataset.id; document.querySelectorAll("#seerTargets .vote-card").forEach(c=>c.classList.remove("selected")); this.classList.add("selected");}));
      document.getElementById("seerSubmit")?.addEventListener("click", async () => { const target=players.find(p=>p.id===selected); alert(`Rolle von ${target.name}: ${target.role}`); await updateDoc(doc(db,"lobbies",lobby.id),{"actionData.seerTarget":selected}); });
      attachBaseListeners();
      return;
    }
    if (narratorStep === "WITCH" && role === "Hexe") {
      const victimId = lobby.actionData?.nightVictim;
      const victimName = players.find(p=>p.id===victimId)?.name||"niemand";
      render(`
        <div class="glass-card">
          ${baseHeader}
          <h2>🧪 Hexe – ${victimName} angegriffen</h2>
          <button class="glass-button" id="healBtn">💚 Heilen</button>
          <button class="glass-button" id="poisonBtn">☠️ Vergiften</button>
          <button class="glass-button" id="skipWitch">Nichts</button>
        </div>
      `);
      document.getElementById("healBtn")?.addEventListener("click", async () => { await updateDoc(doc(db,"lobbies",lobby.id),{"actionData.witch.healTarget":victimId,"actionData.witch.usedHeal":true}); alert("Geheilt!"); });
      document.getElementById("poisonBtn")?.addEventListener("click", async () => { const aliveOthers=players.filter(p=>p.isAlive&&p.id !== player.id); const name=prompt(`Vergiften: ${aliveOthers.map(p=>p.name).join(", ")}`); const target=aliveOthers.find(p=>p.name===name); if(target){ await updateDoc(doc(db,"lobbies",lobby.id),{"actionData.witch.poisonTarget":target.id,"actionData.witch.usedPoison":true}); alert(`Vergiftet: ${target.name}`); } });
      document.getElementById("skipWitch")?.addEventListener("click", () => alert("Nichts getan."));
      attachBaseListeners();
      return;
    }
    render(`<div class="glass-card">${baseHeader}<p>🌙 Nacht – warte.</p></div>`);
    attachBaseListeners();
    return;
  }
  if (phase === "VOTING") {
    const aliveTargets = players.filter(p => p.isAlive && p.id !== player.id);
    render(`
      <div class="glass-card">
        ${baseHeader}
        <h2>🗳️ Wen hinrichten?</h2>
        <div class="vote-grid" id="voteGrid">${aliveTargets.map(t=>`<div class="vote-card" data-id="${t.id}">${t.name}</div>`).join('')}</div>
        <button class="glass-button" id="castVote">Abstimmen</button>
      </div>
    `);
    let selected = null;
    document.querySelectorAll("#voteGrid .vote-card").forEach(c=>c.addEventListener("click",function(){selected=this.dataset.id; document.querySelectorAll("#voteGrid .vote-card").forEach(c=>c.classList.remove("selected")); this.classList.add("selected");}));
    document.getElementById("castVote")?.addEventListener("click", async () => { if(selected){ const newVotes={...(lobby.votes||{}),[player.id]:selected}; await updateDoc(doc(db,"lobbies",lobby.id),{votes:newVotes}); render(`<div class="glass-card">${baseHeader}<p>✅ Abgestimmt.</p></div>`); attachBaseListeners(); } });
    attachBaseListeners();
    return;
  }
  render(`<div class="glass-card">${baseHeader}<h2>🌞 Tagphase</h2><p>Diskutiert! Nutzt den Chat unten rechts.</p></div>`);
  attachBaseListeners();
}

function flashNameInput() {
  const input = document.getElementById("playerName");
  if (input) {
    input.classList.add("error-flash");
    input.placeholder = "Name eingeben";
    setTimeout(() => input.classList.remove("error-flash"), 800);
  }
}

function renderMainMenu() {
  render(`
    <div class="glass-card" style="max-width: 600px; margin:0 auto;">
      <h1><i class="fas fa-moon"></i> WERWOLF MOBILE</h1>
      <input type="text" id="playerName" placeholder="Dein Name" value="">
      <div class="icon-grid">
        <div class="icon-button" id="createPublicLobby">
          <i class="fas fa-globe"></i>
          <span>🌍 Öffentliche Lobby</span>
        </div>
        <div class="icon-button" id="createPrivateLobby">
          <i class="fas fa-users"></i>
          <span>🏠 Private Lobby</span>
        </div>
        <div class="icon-button" id="joinLobbyIcon">
          <i class="fas fa-sign-in-alt"></i>
          <span>Beitreten</span>
        </div>
      </div>
      <div id="lobbyList"></div>
      <div style="text-align: center; margin-top: 1.5rem;">
        <a href="https://paypal.me/Emre100120" target="_blank" class="glass-button" style="display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; text-decoration: none;">
          <i class="fab fa-paypal"></i> Spenden (PayPal)
        </a>
      </div>
    </div>
  `);
  const nameInput = document.getElementById("playerName");
  nameInput?.addEventListener("input", (e) => { currentUser.name = e.target.value; });
  document.getElementById("createPublicLobby")?.addEventListener("click", () => showCreateLobbyModal("public"));
  document.getElementById("createPrivateLobby")?.addEventListener("click", () => showCreateLobbyModal("private"));
  document.getElementById("joinLobbyIcon")?.addEventListener("click", () => showJoinLobbyModal());
  refreshLobbyList();
}
async function refreshLobbyList() {
  if(!firebaseReady) return;
  const q = query(collection(db, "lobbies"), where("gameStarted", "==", false), where("isPublic", "==", true));
  const snap = await getDocs(q);
  const lobbies = snap.docs.map(d => ({ code: d.id, ...d.data() }));
  
  // Automatisches Aufräumen beim Laden der Liste
  await cleanupStaleLobbies(lobbies);
  
  const listDiv = document.getElementById("lobbyList");
  if(listDiv){
    // Erneutes Abfragen nach dem Aufräumen für die Anzeige
    const activeLobbies = lobbies.filter(l => (Date.now() - (l.lastUpdate || 0)) < 5 * 60 * 1000);
    if(activeLobbies.length===0) listDiv.innerHTML='<p>Keine öffentlichen Lobbys.</p>';
    else listDiv.innerHTML=`<h3>Öffentliche Lobbys</h3><div class="player-list">${activeLobbies.map(l=>`<div class="player-tag">${l.code} (${l.players.length}) <button class="glass-button-small" data-code="${l.code}">Beitreten</button></div>`).join('')}</div>`;
    document.querySelectorAll("[data-code]").forEach(btn=>btn.addEventListener("click",async()=>{ const name=document.getElementById("playerName")?.value.trim(); if(!name) flashNameInput(); else { currentUser.name=name; await joinLobby(btn.dataset.code,name); } }));
  }
}
function showCreateLobbyModal(type) {
  const name = document.getElementById("playerName")?.value.trim();
  if(!name){ flashNameInput(); return; }
  currentUser.name = name;
  let isPublic = (type === "public");
  let localOnlineMode = "online";
  let settings = { Dorfbewohner:true, Werwolf:true, Seherin:true, Hexe:true, Amor:true, Jäger:true, "Kleines Mädchen":true };
  let extraHtml = '';
  if (type === "private") {
    extraHtml = `
      <div class="switch-container" style="margin: 1rem 0;">
        <span class="switch-label"><i class="fas fa-users"></i> <span id="localOnlineText">Online-Modus (automatisch)</span></span>
        <label class="switch"><input type="checkbox" id="localOnlineSwitch" checked><span class="slider"></span></label>
      </div>
    `;
  } else {
    extraHtml = `<p style="margin: 1rem 0;">Öffentliche Lobby – jeder kann beitreten, automatischer Erzähler.</p>`;
  }
  const modalContent = `
    <h3>${type === 'public' ? 'Öffentliche Lobby erstellen' : 'Private Lobby erstellen'}</h3>
    ${extraHtml}
    <div><strong>Rollen auswählen:</strong></div>
    <div class="roles-grid" id="roleSettingsModal">
      ${Object.keys(settings).map(role=>`<div class="role-card selected" data-role="${role}"><i class="fas ${role==='Werwolf'?'fa-paw':role==='Seherin'?'fa-eye':role==='Hexe'?'fa-flask':role==='Amor'?'fa-heart':role==='Jäger'?'fa-crosshairs':role==='Kleines Mädchen'?'fa-child':'fa-user'}"></i> ${role}</div>`).join('')}
    </div>
    <button class="glass-button" id="confirmCreate" style="margin-top:1rem;">Erstellen</button>
  `;
  const modalDiv = showModal(modalContent, null);
  modalDiv.querySelectorAll(".role-card").forEach(card => { card.addEventListener("click", () => card.classList.toggle("selected")); });
  if (type === "private") {
    const localOnlineSwitch = modalDiv.querySelector("#localOnlineSwitch");
    const localOnlineText = modalDiv.querySelector("#localOnlineText");
    localOnlineSwitch.addEventListener("change", (e) => {
      localOnlineMode = e.target.checked ? "online" : "lokal";
      localOnlineText.innerHTML = localOnlineMode === "online" ? "Online-Modus (automatisch)" : "Lokal-Modus (mit Erzähler)";
    });
    modalDiv.querySelector("#confirmCreate")?.addEventListener("click", async () => {
      const newSettings = {};
      modalDiv.querySelectorAll(".role-card").forEach(card => { newSettings[card.dataset.role] = card.classList.contains("selected"); });
      await createLobby(currentUser.name, false, localOnlineMode, newSettings);
      modalDiv.remove();
    });
  } else {
    modalDiv.querySelector("#confirmCreate")?.addEventListener("click", async () => {
      const newSettings = {};
      modalDiv.querySelectorAll(".role-card").forEach(card => { newSettings[card.dataset.role] = card.classList.contains("selected"); });
      await createLobby(currentUser.name, true, "online", newSettings);
      modalDiv.remove();
    });
  }
}
async function showJoinLobbyModal() {
  const name = document.getElementById("playerName")?.value.trim();
  if(!name){ flashNameInput(); return; }
  currentUser.name = name;
  const modalContent = `
    <div class="join-split">
      <div class="join-split-left">
        <h3 style="font-size: 1.3rem;"><i class="fas fa-globe"></i> Öffentliche Lobbys</h3>
        <div id="joinModalLobbyList" style="margin-top: 1rem; max-height: 250px; overflow-y: auto;">
          <div class="loader"></div>
        </div>
      </div>
      <div class="join-split-right">
        <h3 style="font-size: 1.3rem;"><i class="fas fa-key"></i> Code eingeben</h3>
        <div class="code-input-container" id="codeInputContainer">
          <input type="text" maxlength="1" class="code-box">
          <input type="text" maxlength="1" class="code-box">
          <input type="text" maxlength="1" class="code-box">
          <input type="text" maxlength="1" class="code-box">
          <input type="text" maxlength="1" class="code-box">
          <input type="text" maxlength="1" class="code-box">
        </div>
        <button class="glass-button" id="confirmJoin" style="margin-top:1rem; width: 100%; max-width: 200px;">Beitreten</button>
      </div>
    </div>
  `;
  const modalDiv = showModal(modalContent, null);
  modalDiv.querySelector(".modal-content").classList.add("large");

  // 6-stellige Code-Boxen Logik
  const boxes = modalDiv.querySelectorAll(".code-box");
  boxes.forEach((box, index) => {
    box.addEventListener("input", (e) => {
      box.value = box.value.toUpperCase();
      if (box.value && index < boxes.length - 1) boxes[index + 1].focus();
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !box.value && index > 0) boxes[index - 1].focus();
      else if (e.key === "Enter") modalDiv.querySelector("#confirmJoin").click();
    });
  });
  setTimeout(() => boxes[0]?.focus(), 100);

  // Beitreten per Code Bestätigen
  modalDiv.querySelector("#confirmJoin")?.addEventListener("click", async () => {
    const code = Array.from(boxes).map(b => b.value).join("").toUpperCase();
    if(code && code.length === 6) {
      try { await joinLobby(code, currentUser.name); modalDiv.remove(); } catch(e){ alert(e.message); }
    } else {
      boxes.forEach(b => { if(!b.value) { b.classList.add("error-flash"); setTimeout(() => b.classList.remove("error-flash"), 800); }});
    }
  });

  // Öffentliche Lobbys abrufen
  if(!firebaseReady) {
    modalDiv.querySelector("#joinModalLobbyList").innerHTML = '<p>Keine Internetverbindung.</p>';
    return;
  }
  const q = query(collection(db, "lobbies"), where("gameStarted", "==", false), where("isPublic", "==", true));
  try {
    const snap = await getDocs(q);
    const lobbies = snap.docs.map(d => ({ code: d.id, ...d.data() }));
    await cleanupStaleLobbies(lobbies);
    const activeLobbies = lobbies.filter(l => (Date.now() - (l.lastUpdate || 0)) < 5 * 60 * 1000);
    const listDiv = modalDiv.querySelector("#joinModalLobbyList");
    if(activeLobbies.length === 0) {
      listDiv.innerHTML = '<p style="margin-top:1rem; opacity:0.7;">Keine öffentlichen Lobbys verfügbar.</p>';
    } else {
      listDiv.innerHTML = activeLobbies.map(l => `
        <div class="public-lobby-item">
          <div class="public-lobby-info">
            <span class="public-lobby-code">${l.code}</span>
            <span class="public-lobby-players"><i class="fas fa-users"></i> ${l.players.length} Spieler</span>
          </div>
          <button class="glass-button glass-button-small" data-join-code="${l.code}">Beitreten</button>
        </div>
      `).join('');
      listDiv.querySelectorAll("[data-join-code]").forEach(btn => {
        btn.addEventListener("click", async () => {
          try { await joinLobby(btn.dataset.joinCode, currentUser.name); modalDiv.remove(); } catch(e){ alert(e.message); }
        });
      });
    }
  } catch (e) {
    console.error(e);
    modalDiv.querySelector("#joinModalLobbyList").innerHTML = '<p>Fehler beim Laden.</p>';
  }
}
function showLobbyMenu() { hideChat(); renderMainMenu(); }

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("accept-consent")?.addEventListener("click", acceptConsent);
  document.getElementById("reject-consent")?.addEventListener("click", rejectConsent);
  document.getElementById("show-impressum")?.addEventListener("click", (e) => { e.preventDefault(); showImpressum(); });
  document.getElementById("show-datenschutz")?.addEventListener("click", (e) => { e.preventDefault(); showDatenschutz(); });
  document.getElementById("close-legal-modal")?.addEventListener("click", closeLegalModal);
  document.getElementById("offline-retry")?.addEventListener("click", () => { if(navigator.onLine){ hideOfflineModal(); initApp(); } else alert("Immer noch offline."); });
  // Chat Event Listeners
  document.getElementById("chat-send")?.addEventListener("click", () => {
    const input = document.getElementById("chat-input");
    if (input && input.value.trim()) { sendChatMessage(input.value); input.value = ""; }
  });
  document.getElementById("chat-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); const input = e.target; if (input.value.trim()) { sendChatMessage(input.value); input.value = ""; } }
  });
  document.getElementById("chat-toggle-btn")?.addEventListener("click", () => {
    const body = document.getElementById("chat-body");
    const btn = document.getElementById("chat-toggle-btn");
    if (body.style.display === "none") { body.style.display = "flex"; btn.textContent = "−"; }
    else { body.style.display = "none"; btn.textContent = "+"; }
  });
  if(!consentGiven) showConsentModal();
  else initApp();
});

// Automatischer "Leave", wenn der Tab geschlossen wird
window.addEventListener("beforeunload", () => {
  if (currentLobbyId && currentUser.id) {
    // Da asynchrones Löschen beim Beenden unzuverlässig ist, versuchen wir es zumindest.
    const lobbyRef = doc(db, "lobbies", currentLobbyId);
    // Hier nutzen wir kein await, da der Tab sofort schließt.
    // In einer idealen Welt würde man hier navigator.sendBeacon oder eine Cloud Function nutzen.
    leaveLobby(currentLobbyId, currentUser.id, null);
  }
});

function initApp() {
  if(!firebaseReady){ alert("Firebase nicht erreichbar"); return; }
  if(!navigator.onLine){ showOfflineModal(); return; }
  deviceId = localStorage.getItem("ww_device_id");
  if(!deviceId){ deviceId=uuid(); localStorage.setItem("ww_device_id",deviceId); }
  currentUser.id = localStorage.getItem("ww_player_id") || uuid();
  localStorage.setItem("ww_player_id", currentUser.id);
  currentUser.deviceId = deviceId;
  renderMainMenu();
}
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const installDiv = document.getElementById("installPrompt");
  if(installDiv) installDiv.style.display = "block";
  document.getElementById("installBtn")?.addEventListener("click", async () => { if(deferredPrompt){ deferredPrompt.prompt(); const {outcome}=await deferredPrompt.userChoice; if(outcome==="accepted") deferredPrompt=null; installDiv.style.display="none"; } });
  document.getElementById("closeInstallBtn")?.addEventListener("click", () => { installDiv.style.display="none"; });
});
if("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js");