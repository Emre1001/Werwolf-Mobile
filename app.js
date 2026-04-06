// app.js – Werwolf Mobile | Professional Edition
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, onSnapshot, updateDoc, collection, query, where, getDocs, setDoc, deleteDoc, arrayUnion, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ========== FIREBASE KONFIGURATION (VOM USER) ==========
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

// ========== GLOBALE ZUSTÄNDE ==========
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
let currentUser = { 
  id: localStorage.getItem("ww_player_id") || uuid(), 
  name: localStorage.getItem("ww_player_name") || "" 
};
localStorage.setItem("ww_player_id", currentUser.id);

let currentLobbyId = null;
let unsubscribeLobby = null;
let deferredPrompt = null;

const ui = document.getElementById("ui-container");

// Scene Transition Helper
function renderScene(html) {
  ui.classList.add("fade-out");
  setTimeout(() => {
    ui.innerHTML = html;
    ui.classList.remove("fade-out");
    ui.classList.add("fade-in");
    setTimeout(() => ui.classList.remove("fade-in"), 600);
  }, 300);
}

// Show Modal
function showModal(contentHtml) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal-content glass-card">${contentHtml}</div>`;
  document.body.appendChild(overlay);
  return overlay;
}

// ========== LOGIK-FUNKTIONEN ==========

// Lobby Erstellen
async function createLobbyAction(playerName, isPublic, settings) {
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const player = { id: currentUser.id, name: playerName, isAlive: true, role: null, hasUsedAction: false };
  const lobbyRef = doc(db, "lobbies", code);
  
  await setDoc(lobbyRef, {
    code,
    hostId: currentUser.id,
    gameStarted: false,
    phase: "LOBBY",
    players: [player],
    isPublic: isPublic,
    settings: settings,
    volunteerNarratorId: null,
    confirmedNarratorId: null,
    actionData: { 
      werewolfVotes: {}, 
      seerTarget: null, 
      witch: { usedHeal: false, usedPoison: false, healTarget: null, poisonTarget: null },
      lovers: [],
      nightVictim: null,
      publicVotes: {}
    },
    votes: {},
    lastUpdate: Date.now()
  });
  
  currentLobbyId = code;
  attachLobbyListener(code);
}

// Lobby Beitreten
async function joinLobbyAction(code, playerName) {
  const lobbyRef = doc(db, "lobbies", code.toUpperCase());
  const snap = await getDoc(lobbyRef);
  
  if (!snap.exists()) throw new Error("Lobby nicht gefunden!");
  const data = snap.data();
  if (data.gameStarted) throw new Error("Das Spiel läuft bereits!");
  
  const player = { id: currentUser.id, name: playerName, isAlive: true, role: null, hasUsedAction: false };
  await updateDoc(lobbyRef, { players: arrayUnion(player) });
  
  currentLobbyId = code;
  attachLobbyListener(code);
}

// Verlassen
async function leaveLobbyAction() {
  if (!currentLobbyId) return;
  const lobbyRef = doc(db, "lobbies", currentLobbyId);
  const snap = await getDoc(lobbyRef);
  
  if (snap.exists()) {
    const data = snap.data();
    const updatedPlayers = data.players.filter(p => p.id !== currentUser.id);
    
    if (updatedPlayers.length === 0) {
      await deleteDoc(lobbyRef);
    } else {
      let newHostId = data.hostId;
      if (data.hostId === currentUser.id) newHostId = updatedPlayers[0].id;
      await updateDoc(lobbyRef, { players: updatedPlayers, hostId: newHostId });
    }
  }
  
  if (unsubscribeLobby) unsubscribeLobby();
  currentLobbyId = null;
  renderMainMenu();
}

// ========== UI SCENES ==========

// HAUPTMENÜ
function renderMainMenu() {
  renderScene(`
    <h1 class="brand-title">Werwolf Mobile</h1>
    
    <div class="input-group">
      <input type="text" id="nameInput" class="sleek-input" placeholder="Name" value="${currentUser.name}">
    </div>

    <div class="menu-grid">
      <div class="icon-card" id="btnCreate">
        <div class="icon-circle"><i class="fas fa-plus"></i></div>
        <div class="icon-content">
          <h3>Lobby erstellen</h3>
          <p>Starte ein neues Abenteuer</p>
        </div>
      </div>
      
      <div class="icon-card" id="btnJoin">
        <div class="icon-circle"><i class="fas fa-sign-in-alt"></i></div>
        <div class="icon-content">
          <h3>Lobby beitreten</h3>
          <p>Nutze einen 6-stelligen Code</p>
        </div>
      </div>
      
      <div class="icon-card" id="btnFind">
        <div class="icon-circle"><i class="fas fa-search"></i></div>
        <div class="icon-content">
          <h3>Lobby finden</h3>
          <p>Tritt öffentlichen Spielen bei</p>
        </div>
      </div>
    </div>
  `);

  setTimeout(() => {
    document.getElementById("nameInput")?.addEventListener("input", (e) => {
      currentUser.name = e.target.value;
      localStorage.setItem("ww_player_name", currentUser.name);
    });
    
    document.getElementById("btnCreate")?.addEventListener("click", showCreateOptions);
    document.getElementById("btnJoin")?.addEventListener("click", showJoinDialog);
    document.getElementById("btnFind")?.addEventListener("click", showPublicLobbies);
  }, 400);
}

// Optionen zum Erstellen
function showCreateOptions() {
  if (!currentUser.name) return alert("Gib erst deinen Namen ein!");
  
  const modal = showModal(`
    <h2 style="margin-bottom:1.5rem;">Lobby-Einstellungen</h2>
    <div class="setting-row">
      <span>Öffentlich (Grün) / Privat (Rot)</span>
      <input type="checkbox" id="checkPublic" class="modern-switch private" checked>
    </div>
    <div style="margin: 1.5rem 0;">
      <p style="margin-bottom:0.8rem; color:var(--text-muted);">Rollen auswählen:</p>
      <div id="roleSelection" style="font-size:0.9rem;">
        ${["Werwolf", "Seherin", "Hexe", "Amor", "Jäger", "Kleines Mädchen"].map(r => `
          <div class="setting-row" style="padding: 0.5rem 0;">
            <span>${r}</span>
            <input type="checkbox" class="role-check" data-role="${r}" checked style="width:20px;height:20px;cursor:pointer;">
          </div>
        `).join('')}
      </div>
    </div>
    <button class="primary-btn" id="confirmCreate">Lobby erstellen</button>
    <button class="secondary-btn" id="cancelModal">Abbrechen</button>
  `);

  modal.querySelector("#confirmCreate").onclick = async () => {
    const isPublic = modal.querySelector("#checkPublic").checked;
    const settings = {};
    modal.querySelectorAll(".role-check").forEach(cb => { settings[cb.dataset.role] = cb.checked; });
    await createLobbyAction(currentUser.name, isPublic, settings);
    modal.remove();
  };
  modal.querySelector("#cancelModal").onclick = () => modal.remove();
}

// Beitreten Dialog
function showJoinDialog() {
  if (!currentUser.name) return alert("Gib erst deinen Namen ein!");
  
  const modal = showModal(`
    <h2>Lobby beitreten</h2>
    <p style="color:var(--text-muted); margin: 0.5rem 0 1.5rem;">Gib den 6-stelligen Code ein:</p>
    <input type="text" id="joinCode" class="sleek-input" maxlength="6" style="text-transform:uppercase; text-align:center; font-size:1.5rem; letter-spacing:0.5rem;" placeholder="ABCDEF">
    <button class="primary-btn" id="confirmJoin">Beitreten</button>
    <button class="secondary-btn" id="cancelModal">Abbrechen</button>
  `);

  modal.querySelector("#confirmJoin").onclick = async () => {
    const code = modal.querySelector("#joinCode").value.trim().toUpperCase();
    if (code.length === 6) {
      try {
        await joinLobbyAction(code, currentUser.name);
        modal.remove();
      } catch(e) { alert(e.message); }
    }
  };
  modal.querySelector("#cancelModal").onclick = () => modal.remove();
}

// Öffentliche Lobbys
async function showPublicLobbies() {
  const q = query(collection(db, "lobbies"), where("isPublic", "==", true), where("gameStarted", "==", false));
  const snap = await getDocs(q);
  const lobbies = snap.docs.map(d => d.data());

  const modal = showModal(`
    <h2>Lobby finden</h2>
    <div style="max-height: 40vh; overflow-y: auto; margin:1.5rem 0;">
      ${lobbies.length === 0 ? '<p style="text-align:center; color:var(--text-muted);">Keine öffentlichen Spiele gefunden.</p>' : 
        lobbies.map(l => `
          <div class="setting-row">
            <div>
              <span style="font-weight:600;">#${l.code}</span><br>
              <small style="color:var(--text-muted);">${l.players.length} Spieler</small>
            </div>
            <button class="primary-btn" style="width:auto; padding:0.5rem 1rem; margin:0;" data-join="${l.code}">Beitreten</button>
          </div>
        `).join('')}
    </div>
    <button class="secondary-btn" id="cancelModal">Zurück</button>
  `);

  modal.querySelectorAll("[data-join]").forEach(btn => {
    btn.onclick = async () => {
      await joinLobbyAction(btn.dataset.join, currentUser.name);
      modal.remove();
    };
  });
  modal.querySelector("#cancelModal").onclick = () => modal.remove();
}

// ========== LOBBY & GAME VIEW ==========

function attachLobbyListener(code) {
  if (unsubscribeLobby) unsubscribeLobby();
  unsubscribeLobby = onSnapshot(doc(db, "lobbies", code), (snap) => {
    if (!snap.exists()) {
      alert("Diese Lobby existiert nicht mehr.");
      renderMainMenu();
      return;
    }
    const data = snap.data();
    renderLobbyOrGame(data);
  });
}

function renderLobbyOrGame(lobby) {
  const isHost = lobby.hostId === currentUser.id;
  const isNarrator = lobby.confirmedNarratorId === currentUser.id;
  const players = lobby.players || [];
  const pCount = players.length;
  
  if (!lobby.gameStarted) {
    // LOBBY VIEW
    const canStart = pCount >= 4;
    const hasVolunteer = !!lobby.volunteerNarratorId;
    const confirmedNarratorName = players.find(p => p.id === lobby.confirmedNarratorId)?.name;

    renderScene(`
      <div class="glass-card">
        <h2 style="text-align:center;">Lobby: ${lobby.code}</h2>
        <p style="text-align:center; color:var(--text-muted); margin-bottom:1.5rem;">Warte auf Spieler (${pCount}/4+)</p>
        
        <div class="player-grid">
          ${players.map(p => `
            <div class="player-bubble ${p.id === lobby.hostId ? 'host' : ''} ${p.id === lobby.confirmedNarratorId ? 'narrator' : ''}">
              ${p.name}
            </div>
          `).join('')}
        </div>

        <div style="background: rgba(255,255,255,0.05); border-radius:1rem; padding:1.5rem; margin: 1.5rem 0;">
          <h4 style="margin-bottom:0.5rem;">🎙️ Erzähler</h4>
          ${confirmedNarratorName ? `<p>Bestätigt: <b>${confirmedNarratorName}</b></p>` : 
            (isHost && lobby.volunteerNarratorId) ? 
            `<button class="primary-btn" style="margin:0;" id="btnConfirmNarrator">FREIWILLIGEN BESTÄTIGEN</button>` :
            (lobby.volunteerNarratorId === currentUser.id) ? `<p>Du hast dich gemeldet...</p>` :
            `<button class="secondary-btn" style="margin:0;" id="btnVolunteer">ALS ERZÄHLER MELDEN</button>`
          }
        </div>

        ${isHost ? `
          <button class="primary-btn" id="btnStart" ${!canStart ? 'disabled' : ''}>${canStart ? 'SPIEL STARTEN' : 'MIN. 4 SPIELER NÖTIG'}</button>
        ` : '<p style="text-align:center; font-size:0.9rem; color:var(--text-muted);">Der Host startet das Spiel...</p>'}
        
        <button class="secondary-btn" id="btnLeave">LEAVEN</button>
      </div>
    `);

    document.getElementById("btnVolunteer")?.addEventListener("click", async () => {
      await updateDoc(doc(db, "lobbies", lobby.code), { volunteerNarratorId: currentUser.id });
    });

    document.getElementById("btnConfirmNarrator")?.addEventListener("click", async () => {
      await updateDoc(doc(db, "lobbies", lobby.code), { confirmedNarratorId: lobby.volunteerNarratorId });
    });

    document.getElementById("btnStart")?.addEventListener("click", () => startGame(lobby));
    document.getElementById("btnLeave")?.addEventListener("click", leaveLobbyAction);
  } else {
    // GAME VIEW
    if (isNarrator) {
      renderNarratorView(lobby);
    } else {
      renderPlayerView(lobby);
    }
  }
}

async function startGame(lobby) {
  const roles = ["Werwolf", "Dorfbewohner", "Werwolf", "Dorfbewohner", "Seherin", "Hexe", "Amor", "Jäger", "Kleines Mädchen"];
  const players = [...lobby.players].sort(() => Math.random() - 0.5);
  
  // Assign roles based on settings and count
  const activeRoles = Object.entries(lobby.settings).filter(([k,v]) => v).map(([k,v]) => k);
  if (activeRoles.length < 2) activeRoles.push("Werwolf", "Dorfbewohner"); // Fallback

  const assigned = players.map((p, i) => {
    if (p.id === lobby.confirmedNarratorId) return { ...p, role: "Erzähler", isAlive: true };
    const role = i < activeRoles.length ? activeRoles[i] : "Dorfbewohner";
    return { ...p, role, isAlive: true };
  });

  await updateDoc(doc(db, "lobbies", lobby.code), {
    gameStarted: true,
    players: assigned,
    phase: "NIGHT",
    narratorStep: "WERWOLF_START"
  });
}

function renderNarratorView(lobby) {
  renderScene(`
    <div class="glass-card narrator-board">
      <h2>🎙️ Erzähler Dashboard</h2>
      <p style="color:var(--secondary); margin-bottom:1rem;">Lobby: ${lobby.code}</p>
      
      <div id="narratorLog" style="height: 200px; overflow-y: auto; margin-bottom:1.5rem; background:rgba(0,0,0,0.3); padding:1rem; border-radius:1rem;">
        <div class="log-entry">🎙️ System: Phase ${lobby.phrase || lobby.phase} gestartet.</div>
        ${Object.entries(lobby.actionData.werewolfVotes || {}).map(([voterId, targetId]) => {
          const voter = lobby.players.find(p => p.id === voterId)?.name;
          const target = lobby.players.find(p => p.id === targetId)?.name;
          return `<div class="log-entry">🐺 Wolf-Vote: ${voter} → ${target}</div>`;
        }).join('')}
        ${Object.entries(lobby.votes || {}).map(([voterId, targetId]) => {
          const voter = lobby.players.find(p => p.id === voterId)?.name;
          const target = lobby.players.find(p => p.id === targetId)?.name;
          return `<div class="log-entry">🗳️ Tag-Vote: ${voter} → ${target}</div>`;
        }).join('')}
      </div>

      <div style="margin-bottom:1rem;">
        <p><b>Lebende Spieler:</b> ${lobby.players.filter(p => p.isAlive && p.role !== 'Erzähler').length}</p>
        <div class="player-grid" style="grid-template-columns: repeat(3, 1fr); font-size:0.7rem;">
          ${lobby.players.map(p => `<div class="player-bubble ${p.isAlive ? '' : 'dead'}" style="${!p.isAlive ? 'opacity:0.3;' : ''}">${p.name} (${p.role})</div>`).join('')}
        </div>
      </div>

      <button class="primary-btn" id="btnNextPhase">NÄCHSTER SCHRITT</button>
      <button class="secondary-btn" id="btnEndGame">SPIEL BEENDEN</button>
    </div>
  `);

  document.getElementById("btnEndGame")?.addEventListener("click", async () => {
    if (confirm("Spiel wirklich abbrechen?")) {
      await deleteDoc(doc(db, "lobbies", lobby.code));
    }
  });

  document.getElementById("btnNextPhase")?.addEventListener("click", async () => {
    // Logic for phases would go here
    alert("Nächste Phase getriggert!");
  });
}

function renderPlayerView(lobby) {
  const me = lobby.players.find(p => p.id === currentUser.id);
  if (!me.isAlive) {
    renderScene(`
      <div class="glass-card">
        <h2 style="color:var(--danger)">⚰️ Du bist gestorben</h2>
        <p>Du kannst das Spiel nun als Geist beobachten.</p>
        <button class="secondary-btn" id="btnLeave">Haupmenü</button>
      </div>
    `);
    document.getElementById("btnLeave").onclick = leaveLobbyAction;
    return;
  }

  renderScene(`
    <div class="glass-card">
      <h2>Deine Rolle: ${me.role}</h2>
      <p style="color:var(--text-muted); margin: 1rem 0;">Phase: ${lobby.phase === 'NIGHT' ? '🌙 Nacht' : '🌞 Tag'}</p>
      
      <div style="background:rgba(0,0,0,0.2); padding:1.5rem; border-radius:1rem; text-align:center;">
        <p>Warte auf Anweisungen vom Erzähler...</p>
      </div>

      <button class="secondary-btn" id="btnLeave" style="margin-top:2rem;">SPIEL VERLASSEN</button>
    </div>
  `);
  document.getElementById("btnLeave").onclick = leaveLobbyAction;
}

// Initialer Start
renderMainMenu();

// PWA Install Prompt
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  // Hier könnte man einen eigenen Install-Banner zeigen
});