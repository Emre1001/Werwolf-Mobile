// app.js – Werwolf PWA mit Firebase Firestore
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";

// ========== FIREBASE KONFIGURATION (HIER DEINE EIGENEN DATEN EINFÜGEN) ==========
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
const analytics = getAnalytics(app);

// ========== GLOBALE ZUSTÄNDE ==========
let currentUser = { id: localStorage.getItem("ww_player_id") || crypto.randomUUID(), name: "" };
localStorage.setItem("ww_player_id", currentUser.id);
let currentLobbyId = null;
let isNarrator = false;
let unsubscribeLobby = null;

const ui = document.getElementById("ui-container");

// Hilfsfunktionen
function render(html) {
  ui.innerHTML = html;
  ui.classList.add("fade-transition");
  setTimeout(() => ui.classList.remove("fade-transition"), 500);
}

function showLobbyMenu() { window.location.reload(); }

// Lobby-Code (6 Zeichen)
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ========== LOBBY ERSTELLEN ==========
async function createLobby(playerName) {
  const code = generateCode();
  const lobbyRef = doc(db, "lobbies", code);
  const player = { id: currentUser.id, name: playerName, isAlive: true, role: null, hasUsedAction: false };
  await setDoc(lobbyRef, {
    code, hostId: currentUser.id, gameStarted: false, phase: "LOBBY", narratorStep: null,
    players: [player], rolesMap: {},
    actionData: { werewolfVotes: {}, seerTarget: null, witch: { usedHeal: false, usedPoison: false, healTarget: null, poisonTarget: null }, smallGirlPeeked: false, peekResult: null, lovers: [], nightVictim: null, hunterRevenge: null },
    votes: {}, nightActionsOrder: [], currentNightIndex: 0, lastUpdate: Date.now()
  });
  currentLobbyId = code;
  isNarrator = true;
  attachListener(code);
  renderLobbyView();
}

// ========== LOBBY BEITRETEN ==========
async function joinLobby(code, playerName) {
  const q = query(collection(db, "lobbies"), where("code", "==", code));
  const snap = await getDocs(q);
  if (snap.empty) throw new Error("Lobby nicht gefunden");
  const lobbyDoc = snap.docs[0];
  const data = lobbyDoc.data();
  if (data.gameStarted) throw new Error("Spiel läuft bereits");
  const newPlayer = { id: currentUser.id, name: playerName, isAlive: true, role: null, hasUsedAction: false };
  await updateDoc(lobbyDoc.ref, { players: arrayUnion(newPlayer) });
  currentLobbyId = code;
  isNarrator = false;
  attachListener(code);
}

// ========== LIVE-LISTENER ==========
function attachListener(lobbyId) {
  if (unsubscribeLobby) unsubscribeLobby();
  const lobbyRef = doc(db, "lobbies", lobbyId);
  unsubscribeLobby = onSnapshot(lobbyRef, (snap) => {
    if (!snap.exists()) { render(`<div class="glass-card"><h2>Lobby gelöscht</h2><button class="glass-button" id="backHome">Zurück</button></div>`);
      document.getElementById("backHome")?.addEventListener("click", showLobbyMenu);
      return;
    }
    const data = { id: snap.id, ...snap.data() };
    renderByState(data);
  });
}

// ========== ROUTING ==========
function renderByState(lobby) {
  const players = lobby.players || [];
  const currentPlayer = players.find(p => p.id === currentUser.id);
  if (!currentPlayer && !isNarrator) { showLobbyMenu(); return; }
  const isHost = (lobby.hostId === currentUser.id);
  isNarrator = isHost;
  if (!lobby.gameStarted) return renderLobbyView(lobby);
  if (isHost) renderNarrator(lobby);
  else renderPlayer(lobby, currentPlayer);
}

// ========== LOBBY-ANSICHT (WARTEZONE) ==========
function renderLobbyView(lobby = null) {
  if (!lobby) {
    render(`
      <div class="glass-card" style="max-width: 500px; margin:0 auto;">
        <h1><i class="fas fa-moon"></i> WERWOLF LEGENDS</h1>
        <p>Synchroner Erzähler-Modus • Echtzeit-PWA</p>
        <input type="text" id="playerName" placeholder="Dein Name" value="Spieler${Math.floor(Math.random()*100)}">
        <div style="display:flex; gap:1rem; margin-top:1rem;">
          <button class="glass-button" id="createLobbyBtn"><i class="fas fa-crown"></i> Lobby erstellen</button>
          <button class="glass-button" id="joinLobbyBtn"><i class="fas fa-code"></i> Beitreten</button>
        </div>
        <div id="lobbyList"></div>
      </div>
    `);
    document.getElementById("createLobbyBtn")?.addEventListener("click", async () => {
      let name = document.getElementById("playerName").value.trim();
      if (!name) name = "Erzähler";
      currentUser.name = name;
      await createLobby(name);
    });
    document.getElementById("joinLobbyBtn")?.addEventListener("click", () => {
      const code = prompt("6-stelliger Lobby-Code:");
      const name = document.getElementById("playerName").value.trim() || "Gast";
      if (code) joinLobby(code, name).catch(e => alert(e.message));
    });
    // Verfügbare Lobbys anzeigen
    (async () => {
      const q = query(collection(db, "lobbies"), where("gameStarted", "==", false));
      const snap = await getDocs(q);
      const lobbies = snap.docs.map(d => ({ code: d.id, ...d.data() }));
      const listDiv = document.getElementById("lobbyList");
      if (listDiv && lobbies.length) {
        listDiv.innerHTML = `<h3>Öffentliche Lobbys</h3><div class="player-list">${lobbies.map(l => `<div class="player-tag">${l.code} (${l.players.length} Spieler) <button class="glass-button small" data-code="${l.code}">Beitreten</button></div>`).join('')}</div>`;
        document.querySelectorAll("[data-code]").forEach(btn => btn.addEventListener("click", (e) => joinLobby(btn.dataset.code, document.getElementById("playerName")?.value.trim() || "Spieler")));
      }
    })();
    return;
  }
  // Bestehende Lobby anzeigen
  const playersList = lobby.players.map(p => `<div class="player-tag">${p.name} ${p.id === lobby.hostId ? '👑 Erzähler' : ''}</div>`).join('');
  render(`
    <div class="glass-card">
      <h2><i class="fas fa-door-open"></i> Lobby: ${lobby.code}</h2>
      <div class="player-list">${playersList}</div>
      ${isNarrator ? `<button class="glass-button" id="startGameBtn"><i class="fas fa-play"></i> Spiel starten (Rollen verteilen)</button>` : `<p>⏳ Warte auf den Erzähler...</p>`}
      <button class="glass-button" id="leaveLobby">Verlassen</button>
    </div>
  `);
  if (isNarrator) document.getElementById("startGameBtn")?.addEventListener("click", () => startGame(lobby.code, lobby.players));
  document.getElementById("leaveLobby")?.addEventListener("click", () => { if (unsubscribeLobby) unsubscribeLobby(); currentLobbyId = null; showLobbyMenu(); });
}

// ========== SPIEL STARTEN (ROLLENVERTEILUNG) ==========
async function startGame(lobbyCode, playersArr) {
  const roles = ["Dorfbewohner", "Werwolf", "Werwolf", "Seherin", "Hexe", "Amor", "Jäger", "Kleines Mädchen"];
  const shuffledPlayers = [...playersArr].sort(() => Math.random() - 0.5);
  const assigned = shuffledPlayers.map((p, idx) => ({ ...p, role: roles[idx % roles.length], isAlive: true }));
  // Amor verliebt zwei Spieler
  let lovers = [];
  const amor = assigned.find(p => p.role === "Amor");
  if (amor) {
    const alive = assigned.filter(p => p.id !== amor.id);
    if (alive.length >= 2) {
      lovers = [alive[0].id, alive[1].id];
    }
  }
  const nightOrder = ["WEREWOLF", "SMALL_GIRL", "SEER", "WITCH"];
  await updateDoc(doc(db, "lobbies", lobbyCode), {
    gameStarted: true, phase: "NIGHT", players: assigned,
    actionData: { werewolfVotes: {}, seerTarget: null, witch: { usedHeal: false, usedPoison: false, healTarget: null, poisonTarget: null }, smallGirlPeeked: false, peekResult: null, lovers, nightVictim: null, hunterRevenge: null },
    nightActionsOrder: nightOrder, currentNightIndex: 0, narratorStep: "WEREWOLF", votes: {}
  });
}

// ========== ERZÄHLER-DASHBOARD (MIT SKRIPT & WEITER) ==========
function renderNarrator(lobby) {
  const { phase, narratorStep, nightActionsOrder, currentNightIndex, players, actionData } = lobby;
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
  } else if (phase === "GAME_END") script = "🏆 Spiel beendet!";

  const nextHandler = async () => {
    if (phase === "NIGHT") await advanceNightPhase(lobby);
    else if (phase === "DAY") await updateDoc(doc(db, "lobbies", lobby.id), { phase: "VOTING", narratorStep: "VOTING", votes: {} });
    else if (phase === "VOTING") await resolveVoting(lobby);
  };

  render(`
    <div class="glass-card">
      <h2><i class="fas fa-torah"></i> Erzähler-Konsole — ${lobby.id}</h2>
      <div class="narrator-script"><i class="fas fa-microphone-alt"></i> <strong>Skript:</strong><br/>${script}</div>
      <div><strong>Lebende Spieler:</strong> ${players.filter(p => p.isAlive).map(p => p.name).join(', ')}</div>
      ${canNext ? `<button class="glass-button" id="narratorNext"><i class="fas fa-step-forward"></i> Weiter ➡️</button>` : ''}
      <button class="glass-button" id="endGame">Spiel beenden</button>
    </div>
  `);
  if (canNext) document.getElementById("narratorNext")?.addEventListener("click", nextHandler);
  document.getElementById("endGame")?.addEventListener("click", async () => { if (confirm("Spiel zurücksetzen?")) await deleteDoc(doc(db, "lobbies", lobby.id)); showLobbyMenu(); });
}

// Nachtphasen-Automatik
async function advanceNightPhase(lobby) {
  const { id, nightActionsOrder, currentNightIndex, actionData } = lobby;
  const step = nightActionsOrder[currentNightIndex];
  if (step === "WEREWOLF") await resolveWerewolfKill(lobby);
  else if (step === "SMALL_GIRL") await resolveSmallGirl(lobby);
  else if (step === "SEER") await resolveSeer(lobby);
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
async function resolveSmallGirl(lobby) { /* wird durch Spieler-Aktion gesetzt – hier nichts tun */ }
async function resolveSeer(lobby) { /* wurde bereits vom Spieler ausgeführt */ }
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
  // Liebestod
  const lovers = lobby.actionData?.lovers || [];
  if (lovers.includes(maxId)) {
    const other = lovers.find(l => l !== maxId);
    players = players.map(p => p.id === other ? { ...p, isAlive: false } : p);
  }
  await updateDoc(doc(db, "lobbies", lobby.id), { players, phase: "NIGHT", currentNightIndex: 0, narratorStep: "WEREWOLF", votes: {}, "actionData.werewolfVotes": {} });
}

// ========== SPIELER-ANSICHT (DYNAMISCHE AKTIONEN) ==========
function renderPlayer(lobby, player) {
  if (!player.isAlive) return render(`<div class="glass-card"><h2>⚰️ Du bist tot</h2><p>Du kannst das Spiel nun beobachten.</p></div>`);
  const { phase, narratorStep, actionData, players } = lobby;
  if (phase === "NIGHT") {
    const role = player.role;
    if (narratorStep === "WEREWOLF" && role === "Werwolf") {
      const targets = players.filter(p => p.isAlive && p.id !== player.id);
      render(`
        <div class="glass-card"><h2>🐺 Wählt euer Opfer</h2>
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
          render(`<div class="glass-card"><p>✅ Abgestimmt. Warte auf Erzähler.</p></div>`);
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
          await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.smallGirlPeeked": true, "actionData.peekResult": result });
        }
      });
      document.getElementById("peekNo")?.addEventListener("click", async () => {
        await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.smallGirlPeeked": true });
        render(`<div class="glass-card"><p>Du schweigst und bleibst sicher.</p></div>`);
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
        <button class="glass-button" id="poisonBtn">☠️ Jemanden vergiften</button>
        <button class="glass-button" id="skipWitch">Nichts tun</button></div>
      `);
      document.getElementById("healBtn")?.addEventListener("click", async () => {
        await updateDoc(doc(db, "lobbies", lobby.id), { "actionData.witch.healTarget": victimId, "actionData.witch.usedHeal": true });
        alert("Du hast das Opfer geheilt!");
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
      document.getElementById("skipWitch")?.addEventListener("click", () => alert("Du tust nichts."));
      return;
    }
    render(`<div class="glass-card"><p>🌙 Es ist Nacht. Der Erzähler ruft die Rollen auf.</p></div>`);
    return;
  }
  if (phase === "VOTING") {
    const aliveTargets = players.filter(p => p.isAlive && p.id !== player.id);
    render(`
      <div class="glass-card"><h2>🗳️ Wen möchtest du hinrichten?</h2>
      <div class="vote-grid" id="voteGrid">${aliveTargets.map(t => `<div class="vote-card" data-id="${t.id}">${t.name}</div>`).join('')}</div>
      <button class="glass-button" id="castVote">Abstimmen</button></div>
    `);
    let selected = null;
    document.querySelectorAll("#voteGrid .vote-card").forEach(card => card.addEventListener("click", function () { selected = this.dataset.id; document.querySelectorAll("#voteGrid .vote-card").forEach(c => c.classList.remove("selected")); this.classList.add("selected"); }));
    document.getElementById("castVote")?.addEventListener("click", async () => {
      if (selected) {
        const newVotes = { ...(lobby.votes || {}), [player.id]: selected };
        await updateDoc(doc(db, "lobbies", lobby.id), { votes: newVotes });
        render(`<div class="glass-card"><p>✅ Du hast abgestimmt.</p></div>`);
      }
    });
    return;
  }
  render(`<div class="glass-card"><h2>🌞 Tagphase</h2><p>Der Erzähler leitet die Diskussion.</p></div>`);
}

// Service Worker registrieren (PWA)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js"));
}