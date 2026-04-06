// app.js – Werwolf Mobile | Inaktivitäts-Kick, verbesserte UI, Erzähler-Votes, Wiedereintritt
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, onSnapshot, updateDoc, collection, query, where, getDocs, setDoc, deleteDoc, arrayUnion, arrayRemove, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
console.log("✅ Firebase verbunden");

// ========== GLOBALE ZUSTÄNDE ==========
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2); }
// Geräte-ID für Wiedereintritt (localStorage)
let deviceId = localStorage.getItem("ww_device_id");
if (!deviceId) { deviceId = uuid(); localStorage.setItem("ww_device_id", deviceId); }
let currentUser = { id: localStorage.getItem("ww_player_id") || uuid(), name: "", deviceId: deviceId };
localStorage.setItem("ww_player_id", currentUser.id);
let currentLobbyId = null;
let unsubscribeLobby = null;
let heartbeatInterval = null;
let deferredPrompt = null;

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

// Heartbeat (alle 10 Sekunden) – nur wenn in Lobby
function startHeartbeat(lobbyId) {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(async () => {
    if (!currentLobbyId) return;
    const lobbyRef = doc(db, "lobbies", currentLobbyId);
    const lobbySnap = await getDoc(lobbyRef);
    if (!lobbySnap.exists()) return;
    const lobby = lobbySnap.data();
    const playerIndex = lobby.players.findIndex(p => p.id === currentUser.id);
    if (playerIndex !== -1) {
      const updatedPlayers = [...lobby.players];
      updatedPlayers[playerIndex] = { ...updatedPlayers[playerIndex], lastSeen: Date.now() };
      await updateDoc(lobbyRef, { players: updatedPlayers });
    }
  }, 10000);
}

// Inaktivitäts-Check (alle 15 Sekunden) – läuft im Listener
async function checkInactivePlayers(lobbyId, players) {
  const now = Date.now();
  const inactive = players.filter(p => p.id !== currentUser.id && (!p.lastSeen || now - p.lastSeen > 15000));
  if (inactive.length === 0) return;
  const newPlayers = players.filter(p => !inactive.some(i => i.id === p.id));
  const lobbyRef = doc(db, "lobbies", lobbyId);
  await updateDoc(lobbyRef, { players: newPlayers });
  // Wenn keine Spieler mehr, Lobby löschen
  if (newPlayers.length === 0) await deleteDoc(lobbyRef);
}

// ========== LOBBY ERSTELLEN ==========
async function createLobby(playerName, isPublic, settings) {
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const lobbyRef = doc(db, "lobbies", code);
  const player = { id: currentUser.id, name: playerName, deviceId: deviceId, isAlive: true, role: null, hasUsedAction: false, lastSeen: Date.now() };
  await setDoc(lobbyRef, {
    code, hostId: currentUser.id, gameStarted: false, phase: "LOBBY", narratorStep: null,
    players: [player], isPublic: isPublic, settings: settings,
    volunteerNarratorId: null, confirmedNarratorId: null,
    actionData: { werewolfVotes: {}, seerTarget: null, witch: { usedHeal: false, usedPoison: false, healTarget: null, poisonTarget: null }, smallGirlPeeked: false, peekResult: null, lovers: [], nightVictim: null, hunterRevenge: null, publicVotes: {} },
    votes: {}, nightActionsOrder: [], currentNightIndex: 0, lastUpdate: Date.now()
  });
  currentLobbyId = code;
  startHeartbeat(code);
  attachListener(code);
}

// ========== LOBBY BEITRETEN (mit Wiedereintritt) ==========
async function joinLobby(code, playerName) {
  const q = query(collection(db, "lobbies"), where("code", "==", code));
  const snap = await getDocs(q);
  if (snap.empty) throw new Error("Lobby nicht gefunden");
  const lobbyDoc = snap.docs[0];
  const data = lobbyDoc.data();
  if (data.gameStarted) throw new Error("Spiel läuft bereits");
  // Prüfen, ob Spieler mit dieser deviceId bereits existiert (Wiedereintritt)
  const existingPlayer = data.players.find(p => p.deviceId === deviceId);
  let newPlayers;
  if (existingPlayer) {
    // Spieler kehrt zurück – aktualisiere Namen und lastSeen
    newPlayers = data.players.map(p => p.deviceId === deviceId ? { ...p, name: playerName, lastSeen: Date.now(), isAlive: true } : p);
    await updateDoc(lobbyDoc.ref, { players: newPlayers });
    currentUser.id = existingPlayer.id;
    localStorage.setItem("ww_player_id", currentUser.id);
  } else {
    const newPlayer = { id: currentUser.id, name: playerName, deviceId: deviceId, isAlive: true, role: null, hasUsedAction: false, lastSeen: Date.now() };
    await updateDoc(lobbyDoc.ref, { players: arrayUnion(newPlayer) });
  }
  currentLobbyId = code;
  startHeartbeat(code);
  attachListener(code);
}

// ========== KICKEN ==========
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
    alert("Du wurdest aus der Lobby gekickt.");
  }
}

// ========== VERLASSEN ==========
async function leaveLobby(lobbyId, playerId, hostId) {
  const lobbyRef = doc(db, "lobbies", lobbyId);
  const lobbySnap = await getDoc(lobbyRef);
  if (!lobbySnap.exists()) return;
  const lobby = lobbySnap.data();
  let newPlayers = lobby.players.filter(p => p.id !== playerId);
  let newHostId = hostId;
  if (hostId === playerId && newPlayers.length > 0) newHostId = newPlayers[0].id;
  if (newPlayers.length === 0) {
    await deleteDoc(lobbyRef);
  } else {
    await updateDoc(lobbyRef, { players: newPlayers, hostId: newHostId });
  }
  if (playerId === currentUser.id) {
    currentLobbyId = null;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    showLobbyMenu();
  }
}

// ========== LIVE-LISTENER ==========
function attachListener(lobbyId) {
  if (unsubscribeLobby) unsubscribeLobby();
  const lobbyRef = doc(db, "lobbies", lobbyId);
  unsubscribeLobby = onSnapshot(lobbyRef, async (snap) => {
    if (!snap.exists()) {
      render(`<div class="glass-card"><h2>Lobby wurde aufgelöst</h2><button class="glass-button" id="backHome">Startseite</button></div>`);
      document.getElementById("backHome")?.addEventListener("click", () => { currentLobbyId = null; showLobbyMenu(); });
      return;
    }
    const data = { id: snap.id, ...snap.data() };
    // Inaktivitäts-Check
    await checkInactivePlayers(lobbyId, data.players);
    // Wenn der aktuelle Spieler nicht mehr in players ist, wurde er gekickt
    if (!data.players.find(p => p.id === currentUser.id)) {
      currentLobbyId = null;
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      showLobbyMenu();
      return;
    }
    renderByState(data);
  });
}

function renderByState(lobby) {
  const players = lobby.players || [];
  const currentPlayer = players.find(p => p.id === currentUser.id);
  const isHost = (lobby.hostId === currentUser.id);
  const isConfirmedNarrator = (lobby.confirmedNarratorId === currentUser.id);
  if (!lobby.gameStarted) {
    renderLobbyView(lobby, isHost, currentPlayer);
    return;
  }
  if (isConfirmedNarrator) {
    renderNarratorDashboard(lobby);
  } else if (currentPlayer) {
    renderPlayerGameView(lobby, currentPlayer);
  } else {
    render(`<div class="glass-card"><p>Du bist nicht in dieser Lobby.</p><button class="glass-button" onclick="location.reload()">Neu laden</button></div>`);
  }
}

// ========== LOBBY-ANSICHT ==========
function renderLobbyView(lobby, isHost, currentPlayer) {
  const players = lobby.players;
  const canStart = players.length >= 4 && lobby.confirmedNarratorId !== null;
  const volunteerId = lobby.volunteerNarratorId;
  const confirmedId = lobby.confirmedNarratorId;
  const alreadyVolunteered = (volunteerId === currentUser.id);
  
  let volunteerSection = '';
  if (!confirmedId) {
    if (!alreadyVolunteered) {
      volunteerSection = `<button class="glass-button glass-button-small" id="volunteerBtn">🐺 Als Erzähler melden</button>`;
    } else {
      volunteerSection = `<p>✅ Du hast dich als Erzähler gemeldet. Warte auf Bestätigung durch den Host.</p>`;
    }
  } else {
    volunteerSection = `<p>📢 Erzähler: ${players.find(p => p.id === confirmedId)?.name || 'unbekannt'}</p>`;
  }
  
  let hostControls = '';
  if (isHost) {
    const volunteerPlayer = players.find(p => p.id === volunteerId);
    hostControls = `
      <div style="margin: 1.2rem 0; padding: 1rem; background: rgba(0,0,0,0.3); border-radius: 1.2rem;">
        <h3 style="margin-bottom:0.8rem;">Host-Einstellungen</h3>
        ${volunteerId ? `<p>Freiwilliger Erzähler: ${volunteerPlayer?.name} <button class="glass-button glass-button-small" id="confirmNarratorBtn">Als Erzähler bestätigen</button></p>` : '<p>Kein Freiwilliger bisher.</p>'}
        <div><strong>Rollen aktivieren/deaktivieren:</strong></div>
        <div class="roles-grid" id="roleToggles">
          ${renderRoleToggles(lobby.settings || {})}
        </div>
        <button class="glass-button" id="saveSettingsBtn" style="margin-top:0.8rem;">Einstellungen speichern</button>
      </div>
    `;
  }
  
  const playersHtml = players.map(p => `
    <div class="player-tag">
      ${p.name} ${p.id === lobby.hostId ? '👑 Host' : ''} ${p.id === confirmedId ? '🎙️ Erzähler' : ''}
      ${isHost && p.id !== currentUser.id ? `<button class="glass-button glass-button-small kick-btn" data-player-id="${p.id}" style="margin-left: 0.5rem; background: #ef4444; padding: 0.2rem 0.6rem;">Kicken</button>` : ''}
    </div>
  `).join('');
  
  render(`
    <div class="glass-card">
      <h2><i class="fas fa-door-open"></i> Lobby: ${lobby.code} <span class="public-badge ${lobby.isPublic ? 'public' : 'private'}">${lobby.isPublic ? 'ÖFFENTLICH' : 'PRIVAT'}</span></h2>
      <div class="player-list">${playersHtml}</div>
      <div>${volunteerSection}</div>
      ${hostControls}
      <div style="margin-top: 1.5rem; display: flex; gap: 1rem; flex-wrap: wrap;">
        ${isHost ? `<button class="glass-button" id="startGameBtn" ${!canStart ? 'disabled style="opacity:0.5;"' : ''}>Spiel starten (min. 4 Spieler & Erzähler)</button>` : ''}
        <button class="glass-button" id="leaveLobbyBtn">Lobby verlassen</button>
      </div>
    </div>
  `);
  
  document.querySelectorAll(".kick-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const playerId = btn.dataset.playerId;
      if (confirm("Spieler wirklich kicken?")) await kickPlayer(lobby.id, playerId);
    });
  });
  if (!confirmedId && !alreadyVolunteered) document.getElementById("volunteerBtn")?.addEventListener("click", async () => {
    await updateDoc(doc(db, "lobbies", lobby.id), { volunteerNarratorId: currentUser.id });
  });
  if (isHost && volunteerId) document.getElementById("confirmNarratorBtn")?.addEventListener("click", async () => {
    await updateDoc(doc(db, "lobbies", lobby.id), { confirmedNarratorId: volunteerId });
  });
  if (isHost) {
    document.getElementById("saveSettingsBtn")?.addEventListener("click", async () => {
      const newSettings = {};
      document.querySelectorAll(".role-card").forEach(card => {
        const role = card.dataset.role;
        newSettings[role] = card.classList.contains("selected");
      });
      await updateDoc(doc(db, "lobbies", lobby.id), { settings: newSettings });
    });
    // Rollen-Toggles als Kacheln
    document.querySelectorAll(".role-card").forEach(card => {
      card.addEventListener("click", () => card.classList.toggle("selected"));
    });
  }
  document.getElementById("startGameBtn")?.addEventListener("click", () => startGame(lobby.id, lobby.players, lobby.settings));
  document.getElementById("leaveLobbyBtn")?.addEventListener("click", () => leaveLobby(lobby.id, currentUser.id, lobby.hostId));
}

function renderRoleToggles(settings) {
  const allRoles = ["Dorfbewohner","Werwolf","Seherin","Hexe","Amor","Jäger","Kleines Mädchen"];
  return allRoles.map(role => `
    <div class="role-card ${settings[role] !== false ? 'selected' : ''}" data-role="${role}">
      <i class="fas ${role === 'Werwolf' ? 'fa-paw' : role === 'Seherin' ? 'fa-eye' : role === 'Hexe' ? 'fa-flask' : role === 'Amor' ? 'fa-heart' : role === 'Jäger' ? 'fa-crosshairs' : role === 'Kleines Mädchen' ? 'fa-child' : 'fa-user'}"></i>
      ${role}
    </div>
  `).join('');
}

// ========== SPIEL STARTEN ==========
async function startGame(lobbyCode, playersArr, settings) {
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
  while (rolePool.length < playersArr.length) rolePool.push("Dorfbewohner");
  const shuffled = [...playersArr].sort(() => Math.random() - 0.5);
  const assigned = shuffled.map((p, idx) => ({ ...p, role: rolePool[idx % rolePool.length], isAlive: true }));
  let lovers = [];
  const amor = assigned.find(p => p.role === "Amor");
  if (amor) {
    const alive = assigned.filter(p => p.id !== amor.id);
    if (alive.length >= 2) lovers = [alive[0].id, alive[1].id];
  }
  const nightOrder = ["WEREWOLF", "SMALL_GIRL", "SEER", "WITCH"];
  await updateDoc(doc(db, "lobbies", lobbyCode), {
    gameStarted: true, phase: "NIGHT", players: assigned,
    actionData: { werewolfVotes: {}, seerTarget: null, witch: { usedHeal: false, usedPoison: false, healTarget: null, poisonTarget: null }, smallGirlPeeked: false, peekResult: null, lovers, nightVictim: null, hunterRevenge: null, publicVotes: {} },
    nightActionsOrder: nightOrder, currentNightIndex: 0, narratorStep: "WEREWOLF", votes: {}
  });
}

// ========== ERZÄHLER-DASHBOARD (mit detaillierten Votes) ==========
function renderNarratorDashboard(lobby) {
  const { phase, narratorStep, nightActionsOrder, currentNightIndex, players, actionData, votes, id } = lobby;
  let script = "", canNext = false;
  if (phase === "NIGHT") {
    const step = nightActionsOrder[currentNightIndex];
    if (step === "WEREWOLF") script = "🌕 Werwölfe, erwacht! Wählt ein Opfer.";
    else if (step === "SMALL_GIRL") script = "👧 Kleines Mädchen – willst du spionieren? (50% Risiko)";
    else if (step === "SEER") script = "🔮 Seherin, öffne die Augen. Wähle einen Spieler.";
    else if (step === "WITCH") script = "🧪 Hexe, der Werwolfsangriff fiel auf... Du kannst heilen oder töten.";
    canNext = true;
  } else if (phase === "DAY") {
    script = "🌞 Der Tag bricht an. Diskutiert! Klicke auf 'Weiter' für die Abstimmung.";
    canNext = true;
  } else if (phase === "VOTING") {
    script = "🗳️ Abstimmung! Jeder wählt einen Verdächtigen. Mehrheit entscheidet.";
    canNext = true;
  }
  
  // Detaillierte Vote-Anzeige
  let liveVotesHtml = '';
  if (phase === "NIGHT" && narratorStep === "WEREWOLF") {
    const werewolfVotes = actionData.werewolfVotes || {};
    const voteEntries = Object.entries(werewolfVotes);
    liveVotesHtml = `<div class="vote-detail-list"><strong>🐺 Werwolf-Votes (detailliert):</strong>${voteEntries.length ? voteEntries.map(([pid, targetId]) => {
      const voter = players.find(p => p.id === pid)?.name || "?";
      const target = players.find(p => p.id === targetId)?.name || "?";
      return `<div class="vote-detail-item"><span>${voter}</span><span>→ ${target}</span></div>`;
    }).join('') : '<div>Noch keine Stimmen</div>'}</div>`;
  } else if (phase === "VOTING") {
    const voteEntries = Object.entries(votes || {});
    liveVotesHtml = `<div class="vote-detail-list"><strong>🗳️ Abstimmungsdetails:</strong>${voteEntries.length ? voteEntries.map(([pid, targetId]) => {
      const voter = players.find(p => p.id === pid)?.name || "?";
      const target = players.find(p => p.id === targetId)?.name || "?";
      return `<div class="vote-detail-item"><span>${voter}</span><span>→ ${target}</span></div>`;
    }).join('') : '<div>Noch keine Stimmen</div>'}</div>`;
  }
  
  const nextHandler = async () => {
    if (phase === "NIGHT") await advanceNightPhase(lobby);
    else if (phase === "DAY") await updateDoc(doc(db, "lobbies", id), { phase: "VOTING", narratorStep: "VOTING", votes: {} });
    else if (phase === "VOTING") await resolveVoting(lobby);
  };
  
  render(`
    <div class="glass-card">
      <h2><i class="fas fa-torah"></i> Erzähler-Konsole — ${lobby.code}</h2>
      <div class="narrator-script"><i class="fas fa-microphone-alt"></i> <strong>Skript:</strong><br/>${script}</div>
      <div><strong>Lebende Spieler:</strong> ${players.filter(p => p.isAlive).map(p => p.name).join(', ')}</div>
      ${liveVotesHtml}
      ${canNext ? `<button class="glass-button" id="narratorNext"><i class="fas fa-step-forward"></i> Weiter</button>` : ''}
      <button class="glass-button" id="endGame">Spiel beenden</button>
    </div>
  `);
  if (canNext) document.getElementById("narratorNext")?.addEventListener("click", nextHandler);
  document.getElementById("endGame")?.addEventListener("click", async () => {
    if (confirm("Spiel zurücksetzen?")) { await deleteDoc(doc(db, "lobbies", lobby.id)); showLobbyMenu(); }
  });
}

// ========== NACHT- UND ABSTIMMUNGSLOGIK (wie gehabt, aber gekürzt) ==========
async function advanceNightPhase(lobby) {
  const { id, nightActionsOrder, currentNightIndex } = lobby;
  const step = nightActionsOrder[currentNightIndex];
  if (step === "WEREWOLF") await resolveWerewolfKill(lobby);
  else if (step === "WITCH") await resolveWitch(lobby);
  const nextIdx = currentNightIndex + 1;
  if (nextIdx >= nightActionsOrder.length) {
    await resolveNightDeath(lobby);
    await updateDoc(doc(db, "lobbies", id), { phase: "DAY", narratorStep: "DAY" });
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
    const name = prompt(`⚰️ Jäger stirbt! Wähle Racheopfer: ${alive.map(p => p.name).join(", ")}`);
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
    const revenge = prompt(`🔫 Jäger lyncht! Töte: ${alive.map(p => p.name).join(", ")}`);
    const target = players.find(p => p.name === revenge);
    if (target) players = players.map(p => p.id === target.id ? { ...p, isAlive: false } : p);
  }
  const lovers = lobby.actionData?.lovers || [];
  if (lovers.includes(maxId)) {
    const other = lovers.find(l => l !== maxId);
    players = players.map(p => p.id === other ? { ...p, isAlive: false } : p);
  }
  await updateDoc(doc(db, "lobbies", lobby.id), { players, phase: "NIGHT", currentNightIndex: 0, narratorStep: "WEREWOLF", votes: {}, "actionData.werewolfVotes": {} });
}

// ========== SPIELER-ANSICHT (vereinfacht, aber funktional) ==========
function renderPlayerGameView(lobby, player) {
  if (!player.isAlive) return render(`<div class="glass-card"><h2>⚰️ Du bist tot</h2><p>Beobachte das Spiel.</p></div>`);
  const { phase, narratorStep, actionData, players } = lobby;
  if (phase === "NIGHT") {
    const role = player.role;
    if (narratorStep === "WEREWOLF" && role === "Werwolf") {
      const targets = players.filter(p => p.isAlive && p.id !== player.id);
      render(`
        <div class="glass-card"><h2>🐺 Wählt ein Opfer</h2>
        <div class="vote-grid" id="wolfTargets">${targets.map(t => `<div class="vote-card" data-id="${t.id}">${t.name}</div>`).join('')}</div>
        <button class="glass-button" id="submitWolfVote">Bestätigen</button></div>
      `);
      let selected = null;
      document.querySelectorAll("#wolfTargets .vote-card").forEach(card => card.addEventListener("click", function () { selected = this.dataset.id; document.querySelectorAll("#wolfTargets .vote-card").forEach(c => c.classList.remove("selected")); this.classList.add("selected"); }));
      document.getElementById("submitWolfVote")?.addEventListener("click", async () => {
        if (selected) {
          const current = lobby.actionData?.werewolfVotes || {};
          current[player.id] = selected;
          await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.werewolfVotes": current });
          render(`<div class="glass-card"><p>✅ Abgestimmt.</p></div>`);
        }
      });
      return;
    }
    if (narratorStep === "SMALL_GIRL" && role === "Kleines Mädchen") {
      render(`
        <div class="glass-card"><h2>👧 Durchs Schlüsselloch schauen?</h2>
        <button class="glass-button" id="peekYes">Ja (50% Risiko)</button>
        <button class="glass-button" id="peekNo">Nein</button></div>
      `);
      document.getElementById("peekYes")?.addEventListener("click", async () => {
        const risk = Math.random() < 0.5;
        let result = risk ? "Du wirst entdeckt und stirbst!" : "Du siehst die Werwölfe: " + players.filter(p => p.role === "Werwolf" && p.isAlive).map(p => p.name).join(", ");
        alert(result);
        if (risk) {
          const updated = players.map(p => p.id === player.id ? { ...p, isAlive: false } : p);
          await updateDoc(doc(db, "lobbies", lobby.id), { players: updated, "actionData.smallGirlPeeked": true });
        } else {
          await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.smallGirlPeeked": true });
        }
      });
      document.getElementById("peekNo")?.addEventListener("click", async () => {
        await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.smallGirlPeeked": true });
        render(`<div class="glass-card"><p>Du bleibst im Versteck.</p></div>`);
      });
      return;
    }
    if (narratorStep === "SEER" && role === "Seherin") {
      const targets = players.filter(p => p.isAlive && p.id !== player.id);
      render(`
        <div class="glass-card"><h2>🔮 Wähle einen Spieler</h2>
        <div class="vote-grid" id="seerTargets">${targets.map(t => `<div class="vote-card" data-id="${t.id}">${t.name}</div>`).join('')}</div>
        <button class="glass-button" id="seerSubmit">Rolle erkennen</button></div>
      `);
      let selected = null;
      document.querySelectorAll("#seerTargets .vote-card").forEach(card => card.addEventListener("click", function () { selected = this.dataset.id; document.querySelectorAll("#seerTargets .vote-card").forEach(c => c.classList.remove("selected")); this.classList.add("selected"); }));
      document.getElementById("seerSubmit")?.addEventListener("click", async () => {
        const target = players.find(p => p.id === selected);
        alert(`Die Rolle von ${target.name} ist: ${target.role}`);
        await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.seerTarget": selected });
      });
      return;
    }
    if (narratorStep === "WITCH" && role === "Hexe") {
      const victimId = lobby.actionData?.nightVictim;
      const victimName = players.find(p => p.id === victimId)?.name || "niemand";
      render(`
        <div class="glass-card"><h2>🧪 Hexe – ${victimName} wurde angegriffen</h2>
        <button class="glass-button" id="healBtn">💚 Heilen</button>
        <button class="glass-button" id="poisonBtn">☠️ Vergiften</button>
        <button class="glass-button" id="skipWitch">Nichts tun</button></div>
      `);
      document.getElementById("healBtn")?.addEventListener("click", async () => {
        await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.witch.healTarget": victimId, "actionData.witch.usedHeal": true });
        alert("Du hast geheilt!");
      });
      document.getElementById("poisonBtn")?.addEventListener("click", async () => {
        const aliveOthers = players.filter(p => p.isAlive && p.id !== player.id);
        const name = prompt(`Wen vergiften? ${aliveOthers.map(p => p.name).join(", ")}`);
        const target = aliveOthers.find(p => p.name === name);
        if (target) {
          await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.witch.poisonTarget": target.id, "actionData.witch.usedPoison": true });
          alert(`Du hast ${target.name} vergiftet!`);
        }
      });
      document.getElementById("skipWitch")?.addEventListener("click", () => alert("Nichts getan."));
      return;
    }
    render(`<div class="glass-card"><p>🌙 Nacht – warte auf den Erzähler.</p></div>`);
    return;
  }
  if (phase === "VOTING") {
    const aliveTargets = players.filter(p => p.isAlive && p.id !== player.id);
    render(`
      <div class="glass-card"><h2>🗳️ Wen hinrichten?</h2>
      <div class="vote-grid" id="voteGrid">${aliveTargets.map(t => `<div class="vote-card" data-id="${t.id}">${t.name}</div>`).join('')}</div>
      <button class="glass-button" id="castVote">Abstimmen</button></div>
    `);
    let selected = null;
    document.querySelectorAll("#voteGrid .vote-card").forEach(card => card.addEventListener("click", function () { selected = this.dataset.id; document.querySelectorAll("#voteGrid .vote-card").forEach(c => c.classList.remove("selected")); this.classList.add("selected"); }));
    document.getElementById("castVote")?.addEventListener("click", async () => {
      if (selected) {
        const newVotes = { ...(lobby.votes || {}), [player.id]: selected };
        await updateDoc(doc(db, "lobbies", lobby.id), { votes: newVotes });
        render(`<div class="glass-card"><p>✅ Abgestimmt.</p></div>`);
      }
    });
    return;
  }
  render(`<div class="glass-card"><h2>🌞 Tagphase</h2><p>Der Erzähler leitet die Runde.</p></div>`);
}

// ========== HAUPTSMENÜ ==========
function renderMainMenu() {
  render(`
    <div class="glass-card" style="max-width: 600px; margin:0 auto;">
      <h1><i class="fas fa-moon"></i> WERWOLF MOBILE</h1>
      <input type="text" id="playerName" placeholder="Dein Name" value="">
      <div class="icon-grid">
        <div class="icon-button" id="createLobbyIcon">
          <i class="fas fa-plus-circle"></i>
          <span>Lobby erstellen</span>
        </div>
        <div class="icon-button" id="joinLobbyIcon">
          <i class="fas fa-sign-in-alt"></i>
          <span>Lobby beitreten</span>
        </div>
        <div class="icon-button" id="findLobbyIcon">
          <i class="fas fa-search"></i>
          <span>Lobby finden</span>
        </div>
      </div>
      <div id="lobbyList"></div>
    </div>
  `);
  const nameInput = document.getElementById("playerName");
  nameInput?.addEventListener("input", (e) => { currentUser.name = e.target.value; });
  document.getElementById("createLobbyIcon")?.addEventListener("click", () => showCreateLobbyModal());
  document.getElementById("joinLobbyIcon")?.addEventListener("click", () => showJoinLobbyModal());
  document.getElementById("findLobbyIcon")?.addEventListener("click", () => refreshLobbyList());
  refreshLobbyList();
}

async function refreshLobbyList() {
  const q = query(collection(db, "lobbies"), where("gameStarted", "==", false), where("isPublic", "==", true));
  const snap = await getDocs(q);
  const lobbies = snap.docs.map(d => ({ code: d.id, ...d.data() }));
  const listDiv = document.getElementById("lobbyList");
  if (listDiv) {
    if (lobbies.length === 0) listDiv.innerHTML = '<p>Keine öffentlichen Lobbys gefunden.</p>';
    else listDiv.innerHTML = `<h3>Öffentliche Lobbys</h3><div class="player-list">${lobbies.map(l => `<div class="player-tag">${l.code} (${l.players.length} Spieler) <button class="glass-button glass-button-small" data-code="${l.code}">Beitreten</button></div>`).join('')}</div>`;
    document.querySelectorAll("[data-code]").forEach(btn => btn.addEventListener("click", async (e) => {
      const code = btn.dataset.code;
      const name = document.getElementById("playerName")?.value.trim();
      if (!name) { alert("Bitte gib deinen Namen ein."); return; }
      currentUser.name = name;
      await joinLobby(code, name);
    }));
  }
}

function showCreateLobbyModal() {
  const name = document.getElementById("playerName")?.value.trim();
  if (!name) { alert("Bitte gib deinen Namen ein."); return; }
  currentUser.name = name;
  let isPublic = true;
  let settings = { Dorfbewohner: true, Werwolf: true, Seherin: true, Hexe: true, Amor: true, Jäger: true, "Kleines Mädchen": true };
  const modalContent = `
    <h3>Lobby erstellen</h3>
    <div class="switch-container">
      <span class="switch-label"><i class="fas ${isPublic ? 'fa-globe' : 'fa-lock'}"></i> <span id="privacyText">Öffentlich</span></span>
      <label class="switch"><input type="checkbox" id="publicSwitch" checked><span class="slider"></span></label>
    </div>
    <div><strong>Rollen auswählen:</strong></div>
    <div class="roles-grid" id="roleSettingsModal">
      ${Object.keys(settings).map(role => `<div class="role-card selected" data-role="${role}"><i class="fas ${role === 'Werwolf' ? 'fa-paw' : role === 'Seherin' ? 'fa-eye' : role === 'Hexe' ? 'fa-flask' : role === 'Amor' ? 'fa-heart' : role === 'Jäger' ? 'fa-crosshairs' : role === 'Kleines Mädchen' ? 'fa-child' : 'fa-user'}"></i> ${role}</div>`).join('')}
    </div>
    <button class="glass-button" id="confirmCreateLobby" style="margin-top:1rem;">Erstellen</button>
  `;
  showModal(modalContent, null);
  const modalDiv = document.querySelector(".modal");
  const privacySpan = modalDiv.querySelector("#privacyText");
  const publicSwitch = modalDiv.querySelector("#publicSwitch");
  publicSwitch.addEventListener("change", (e) => {
    isPublic = e.target.checked;
    privacySpan.innerHTML = isPublic ? '<i class="fas fa-globe"></i> Öffentlich' : '<i class="fas fa-lock"></i> Privat';
  });
  // Rollen-Klicks
  modalDiv.querySelectorAll(".role-card").forEach(card => {
    card.addEventListener("click", () => card.classList.toggle("selected"));
  });
  modalDiv.querySelector("#confirmCreateLobby")?.addEventListener("click", async () => {
    const newSettings = {};
    modalDiv.querySelectorAll(".role-card").forEach(card => { newSettings[card.dataset.role] = card.classList.contains("selected"); });
    await createLobby(currentUser.name, isPublic, newSettings);
    modalDiv.remove();
  });
}

function showJoinLobbyModal() {
  const name = document.getElementById("playerName")?.value.trim();
  if (!name) { alert("Bitte gib deinen Namen ein."); return; }
  currentUser.name = name;
  const modalContent = `
    <h3>Lobby beitreten</h3>
    <input type="text" id="lobbyCodeInput" placeholder="6-stelliger Code" maxlength="6" style="text-transform:uppercase">
    <button class="glass-button" id="confirmJoinLobby" style="margin-top:1rem;">Beitreten</button>
  `;
  showModal(modalContent, null);
  const modalDiv = document.querySelector(".modal");
  modalDiv.querySelector("#confirmJoinLobby")?.addEventListener("click", async () => {
    let code = modalDiv.querySelector("#lobbyCodeInput").value.trim().toUpperCase();
    if (!code) return;
    try {
      await joinLobby(code, currentUser.name);
      modalDiv.remove();
    } catch(e) { alert(e.message); }
  });
}

function showLobbyMenu() { renderMainMenu(); }

// ========== PWA-INSTALLATION ==========
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const installDiv = document.getElementById("installPrompt");
  if (installDiv) installDiv.style.display = "block";
  document.getElementById("installBtn")?.addEventListener("click", async () => {
    if (deferredPrompt) { deferredPrompt.prompt(); const { outcome } = await deferredPrompt.userChoice; if (outcome === "accepted") deferredPrompt = null; installDiv.style.display = "none"; }
  });
  document.getElementById("closeInstallBtn")?.addEventListener("click", () => { installDiv.style.display = "none"; });
});

// ========== START ==========
renderMainMenu();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js");