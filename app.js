// app.js – Werwolf Mobile v6 | UI, sync & presence. Game rules live in engine.js.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  initializeFirestore, getFirestore, doc, onSnapshot, updateDoc, collection, query, where, getDocs,
  deleteDoc, getDoc, addDoc, orderBy, limitToLast, runTransaction, arrayUnion, deleteField
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { LANGS, initLang, setLang, getLang, getLangPref, langName, detectLang, onLangChange, t, roleName, roleDesc } from "./i18n.js?v=6.0";
import {
  NARRATOR, MIN_PLAYERS, MAX_PLAYERS, OPTIONAL_ROLES, DAY_TIMES, defaultSettings, QUICK_ROLES,
  defaultActionData, inGame, alivePlayers, byId, hasRoleAlive, roleEnabled, buildRolePool, wolfCountFor,
  buildStartGame, buildRestart, buildAdvance, buildStartVoting, buildHunterShot, buildWinCheck,
  finalizeUpdate, stepDone, voteTally
} from "./engine.js?v=6.0";

// Keep in sync with service-worker.js, version.json and the ?v= query strings.
const APP_VERSION = "6.0";

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
  // Long-polling auto-detection keeps the realtime connection alive on mobile networks and
  // proxies that break Firestore's default WebChannel stream (a big source of "random" drops).
  try { db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true }); }
  catch { db = getFirestore(app); }
  firebaseReady = true;
} catch (e) { console.error("Firebase init error", e); }

// ========== STORAGE ==========
// localStorage can throw (storage disabled, private modes) — never let that kill the module.
function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, value); } catch {} }
function storageDel(key) { try { localStorage.removeItem(key); } catch {} }

const CONSENT_KEY = "werwolf_consent_given";
const SESSION_KEY = "ww_session";
const NAME_KEY = "ww_name";
let consentGiven = storageGet(CONSENT_KEY) === "true";

// ========== TIMING ==========
const HB_MS = 15000;               // heartbeat interval
const OFFLINE_MS = 50000;          // no new heartbeat seen for this long → shown as offline
const LOBBY_PRUNE_MS = 5 * 60000;  // pre-game only: drop players gone this long (they auto-rejoin on return)
const GRACE_MS = 12000;            // non-host clients push a timed-out step after this extra wait
const LOBBY_EXPIRE_MS = 60 * 60000;
const PUBLIC_FRESH_MS = 2 * 60000;

// ========== STATE ==========
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36); }

let deviceId = storageGet("ww_device_id");
const currentUser = { id: storageGet("ww_player_id") || uuid(), name: storageGet(NAME_KEY) || "", deviceId };

let currentLobbyId = null;
let currentLobby = null;
let unsubscribeLobby = null;
let unsubscribeChat = null;
let heartbeatTimer = null;
let tickTimer = null;
let deferredPrompt = null;
let lastFp = null;
let lastPhase = null;
let lastRevealId = null;
let lastLoverNotice = null;
let screenKey = null;
let currentRender = null;
let transitionBusy = false;
let rejoinAttemptAt = 0;
const uiSel = new Map();

// Presence without trusting device clocks: we record the LOCAL time at which we last saw each
// player's heartbeat value change. Clock skew between phones can therefore never make someone
// look offline (the old code compared foreign timestamps with Date.now() and kicked people).
const presence = { hb: {}, seenAt: {} };
// Same idea for step timers: deadline = local time we first saw this step + its duration.
let seqSeen = { seq: null, at: 0 };

const ui = document.getElementById("ui-container");
const mainEl = document.getElementById("app-main");   // the only scroll container (app shell)
const $ = (id) => document.getElementById(id);

// ========== BACK (gesture / button / browser back / Esc) ==========
// lib/back-stack.js: every overlay and the lobby screen is a history entry, so back closes the
// most recent thing instead of leaving the app. backPush returns the release function to call
// when the overlay is closed by other means (X, backdrop, action done).
const Back = window.BackStack;
function backPush(id, onBack) { return Back ? Back.push(id, onBack) : () => {}; }
let overlaySeq = 0;

// Only the topmost overlay is interactive: everything below it (the app shell, lower sheets) is inert,
// so taps, focus and TalkBack can't reach controls hidden behind a backdrop.
const OVERLAYS = ".modal, .guide-overlay, .role-display, .upd-overlay, .lang-pop, .chat-container";
const compactChat = window.matchMedia("(max-width: 899px)");
const finePointer = window.matchMedia("(pointer: fine)");
function overlayIsOpen(el) {
  if (el.matches(".chat-container")) return el.classList.contains("open") && compactChat.matches;
  return el.style.display !== "none" && getComputedStyle(el).display !== "none";
}
function syncInert() {
  const open = [...document.querySelectorAll(OVERLAYS)].filter(overlayIsOpen);
  const z = (el) => parseInt(getComputedStyle(el).zIndex, 10) || 0;
  const top = open.reduce((best, el) => (!best || z(el) >= z(best) ? el : best), null);
  const shell = document.getElementById("app-shell");
  if (shell) shell.inert = !!top;
  document.querySelectorAll(OVERLAYS).forEach(el => { el.inert = !!top && el !== top && overlayIsOpen(el); });
}
let inertQueued = false;
const queueInert = () => { if (inertQueued) return; inertQueued = true; requestAnimationFrame(() => { inertQueued = false; syncInert(); }); };
new MutationObserver(queueInert).observe(document.body, { childList: true });
["consent-modal", "legal-modal", "ios-install-modal", "role-display", "chat-container"].forEach(id => {
  const el = document.getElementById(id);
  if (el) new MutationObserver(queueInert).observe(el, { attributes: true, attributeFilter: ["style", "class"] });
});
compactChat.addEventListener?.("change", queueInert);

// ========== GENERIC HELPERS ==========
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function buzz(pattern) { try { navigator.vibrate?.(pattern); } catch {} }
const lobbyRef = (id = currentLobbyId) => doc(db, "lobbies", id);
const isMe = (id) => id === currentUser.id;

const ROLE_ICONS = { "Werwolf": "🐺", "Dorfbewohner": "🏘️", "Seherin": "🔮", "Hexe": "🧪", "Amor": "💘", "Jäger": "🎯", "Kleines Mädchen": "👧", "Beschützer": "🛡️", "Prinz": "👑", "Älteste": "👴", [NARRATOR]: "🎙️" };
const getRoleIcon = (role) => ROLE_ICONS[role] || "🎭";

const AV_COLORS = ["#2563eb", "#7c3aed", "#db2777", "#ea580c", "#16a34a", "#0891b2", "#ca8a04", "#dc2626", "#4f46e5", "#0d9488"];
function avatar(p, cls = "") {
  const name = (p?.name || "?").trim();
  let h = 0;
  for (const c of (p?.id || name)) h = (h * 31 + c.charCodeAt(0)) | 0;
  const ini = escapeHtml(([...name][0] || "?").toUpperCase());
  return `<span class="avatar ${cls}" style="--av:${AV_COLORS[Math.abs(h) % AV_COLORS.length]}">${ini}</span>`;
}

// ========== CONSENT / LEGAL ==========
function showConsentModal() { $("consent-modal").style.display = "flex"; }
function acceptConsent() { storageSet(CONSENT_KEY, "true"); consentGiven = true; $("consent-modal").style.display = "none"; initApp(); setupInstallBanner(); }
function rejectConsent() { showToast(t("consentNeeded"), "warning"); }

let legalRelease = null;
function openLegal() {
  $("legal-modal").style.display = "flex";
  legalRelease?.();
  legalRelease = backPush("legal", () => { legalRelease = null; $("legal-modal").style.display = "none"; });
}
function closeLegal() { legalRelease?.(); legalRelease = null; $("legal-modal").style.display = "none"; }
function showImpressum() { $("legal-modal-title").innerText = t("imprint"); $("legal-modal-body").innerHTML = `<p><strong>Angaben gemäß § 5 TMG:</strong></p><p>Emre Asik<br>E-Mail: emre.asik201060@gmail.com</p><p>Die Anschrift wird aus Datenschutzgründen nicht öffentlich angezeigt. Sie erhalten diese auf Anfrage.</p><p><strong>Verantwortlich für den Inhalt:</strong> Emre Asik</p>`; openLegal(); }
function showDatenschutz() { $("legal-modal-title").innerText = t("privacy"); $("legal-modal-body").innerHTML = `<p><strong>1. Verantwortlicher</strong><br>Emre Asik, emre.asik201060@gmail.com</p><p><strong>2. Erhobene Daten</strong><br>Spieler-ID, Geräte-ID, Spielername (LocalStorage). Technisch notwendig.</p><p><strong>3. Rechtsgrundlage</strong><br>Art. 6 Abs. 1 lit. a, b DSGVO. Einwilligung jederzeit widerrufbar.</p><p><strong>4. Verarbeitung</strong><br>Lobbys, Spielzüge und Chat-Nachrichten werden über Google Firebase (Firestore, Google Ireland Ltd.) gespeichert und synchronisiert. Keine Weitergabe zu Werbe- oder Analysezwecken.</p>`; openLegal(); }

// ========== NETWORK BANNER ==========
// Brief network blips are normal on phones — show an unobtrusive banner instead of a blocking modal.
let netBannerTimer = null;
function setNetProblem(on) {
  const b = $("net-banner");
  if (!b) return;
  if (on) {
    if (!netBannerTimer && !b.classList.contains("show")) netBannerTimer = setTimeout(() => { b.classList.add("show"); netBannerTimer = null; }, 2500);
  } else {
    clearTimeout(netBannerTimer); netBannerTimer = null;
    b.classList.remove("show");
  }
}
window.addEventListener("online", () => {
  setNetProblem(false);
  if (currentLobbyId) sendHeartbeat();
  else if (consentGiven && firebaseReady && (storageGet(SESSION_KEY) || ui.querySelector(".loader"))) initApp();
});
window.addEventListener("offline", () => setNetProblem(true));

// ========== I18N / THEME ==========
function applyStaticI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach(el => { el.setAttribute("placeholder", t(el.dataset.i18nPh)); });
  document.querySelectorAll("[data-i18n-aria]").forEach(el => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
}
// Bridge for lib/language-picker.js and lib/update-dialog.js (they expect a global I18n).
window.I18n = {
  t: (key, vars) => t(key, vars),
  current: getLang,
  preference: getLangPref,
  languages: () => LANGS.map(l => ({ code: l.code, name: l.label })),
  nameOf: langName,
  resolve: (code) => (code === "system" ? detectLang() : code),
  onChange: (fn) => onLangChange(fn),
  number: (n, opts) => new Intl.NumberFormat(getLang(), opts).format(n),
  // Soft crossfade while the language changes (instant with reduced motion / without View Transitions).
  setLanguage(code) {
    const root = document.documentElement;
    if (typeof document.startViewTransition !== "function" || reduceMotion()) { setLang(code); return; }
    root.classList.add("lang-switching");
    try { document.startViewTransition(() => setLang(code)).finished.finally(() => root.classList.remove("lang-switching")); }
    catch { root.classList.remove("lang-switching"); setLang(code); }
  }
};

const THEME_KEY = "ww_theme";
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const parseRGB = (str, fallback) => { const a = String(str).split(",").map(x => parseFloat(x)); return a.length === 3 && a.every(Number.isFinite) ? a : fallback; };
// Particle colours glide towards the theme's colours instead of snapping.
const pColor = { cur: [96, 165, 250], target: [96, 165, 250] };
const lColor = { cur: [56, 189, 248], target: [56, 189, 248] };
function readThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  pColor.target = parseRGB(cs.getPropertyValue("--particle-rgb"), pColor.target);
  lColor.target = parseRGB(cs.getPropertyValue("--line-rgb"), lColor.target);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", cs.getPropertyValue("--meta-color").trim() || "#0a1733");
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;
  $("theme-toggle")?.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  readThemeColors();
}
// Stored preference: "light" | "dark", nothing = follow the system.
const themeMq = window.matchMedia("(prefers-color-scheme: light)");
function themePref() { const v = storageGet(THEME_KEY); return v === "light" || v === "dark" ? v : "system"; }
function resolveTheme(pref) { return pref === "system" ? (themeMq.matches ? "light" : "dark") : pref; }

let themeBusy = false;
// Quick toggle in the top bar: flips light ⇄ dark (an explicit choice).
function toggleTheme(e) {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  setThemePref(next, e, $("theme-toggle"));
}
// pref: "system" | "light" | "dark". The new theme grows as a circle out of the control that was used
// (View Transitions API); browsers without it cross-fade the palette (registered @property colour tokens).
function setThemePref(pref, e, originEl) {
  if (themeBusy) return;
  const root = document.documentElement;
  const next = resolveTheme(pref);
  const store = () => { if (pref === "system") storageDel(THEME_KEY); else storageSet(THEME_KEY, pref); };
  const commit = () => { store(); applyTheme(next); };
  document.dispatchEvent(new CustomEvent("themepref", { detail: pref }));
  if (root.getAttribute("data-theme") === next) { store(); return; }
  const btn = originEl || $("theme-toggle");
  const rect = btn?.getBoundingClientRect();
  const x = e && e.clientX ? e.clientX : rect ? rect.left + rect.width / 2 : innerWidth - 40;
  const y = e && e.clientY ? e.clientY : rect ? rect.top + rect.height / 2 : 30;
  buzz(12);
  if (reduceMotion()) { commit(); return; }
  if (!e && !originEl) {                       // not triggered by the user (OS switched): soft crossfade
    root.classList.add("theme-fade"); commit();
    setTimeout(() => root.classList.remove("theme-fade"), 900);
    return;
  }

  // expanding ring at the top-bar button
  if (btn && btn.id === "theme-toggle") {
    const ring = document.createElement("span");
    ring.className = "theme-ring";
    btn.appendChild(ring);
    ring.addEventListener("animationend", () => ring.remove());
  }
  themeBusy = true;
  const done = () => { themeBusy = false; root.classList.remove("theme-switching", "theme-fade"); };

  if (typeof document.startViewTransition === "function") {
    root.classList.add("theme-switching"); // no CSS transitions while the browser captures the new state
    let vt;
    try { vt = document.startViewTransition(commit); } catch { commit(); done(); return; }
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    vt.ready.then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 800, easing: "cubic-bezier(0.65, 0, 0.35, 1)", pseudoElement: "::view-transition-new(root)" }
      );
      // the old theme dims and shrinks slightly while it is being covered
      root.animate(
        { transform: ["scale(1)", "scale(0.97)"], opacity: [1, 0.6] },
        { duration: 800, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards", pseudoElement: "::view-transition-old(root)" }
      );
    }).catch(() => {});
    vt.finished.then(done, done);
  } else {
    root.classList.add("theme-fade");
    commit();
    setTimeout(done, 900);
  }
}
function initTheme() {
  applyTheme(resolveTheme(themePref()));
  themeMq.addEventListener?.("change", () => { if (themePref() === "system") setThemePref("system"); });
  // Sky: three layers of tiny stars (generated once, animated via opacity only → very cheap).
  const layers = document.querySelectorAll("#stars i");
  const count = innerWidth < 760 ? 26 : 48;
  layers.forEach((el, li) => {
    const shadows = [];
    for (let i = 0; i < count; i++) {
      const sz = [0, 0, 1][Math.floor(Math.random() * 3)];
      shadows.push(`${(Math.random() * 100).toFixed(1)}vw ${(Math.random() * 100).toFixed(1)}vh 0 ${sz}px rgba(255,255,255,${(0.5 + Math.random() * 0.5).toFixed(2)})`);
    }
    el.style.boxShadow = shadows.join(",");
    el.style.animationDelay = (-li * 1.7) + "s";
  });
}

// ========== TOASTS ==========
function showToast(msg, type = "info", ms = 3200) {
  const container = $("toast-container");
  if (!container) return;
  while (container.children.length >= 3) container.firstChild.remove();
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", "status");
  toast.style.setProperty("--dur", ms + "ms");
  toast.textContent = msg;
  toast.addEventListener("click", () => toast.remove());
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add("toast-exit"); setTimeout(() => toast.remove(), 350); }, ms);
}

// ========== PARTICLES (throttled, paused when hidden) ==========
function initParticles() {
  const canvas = $("particles");
  if (!canvas) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) { canvas.remove(); return; }
  const ctx = canvas.getContext("2d");
  const small = window.innerWidth < 760;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  let w, h;
  const count = small ? 22 : Math.min(55, Math.floor(window.innerWidth / 28));
  const maxDist = small ? 105 : 130;
  const particles = [];
  function resize() {
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize, { passive: true });
  for (let i = 0; i < count; i++) particles.push({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.5, vy: (Math.random() - 0.5) * 0.5, r: Math.random() * 1.6 + 0.8 });
  let last = 0;
  function draw(ts) {
    requestAnimationFrame(draw);
    if (document.hidden || ts - last < 33) return; // ~30 fps is plenty and saves battery
    last = ts;
    ctx.clearRect(0, 0, w, h);
    for (let k = 0; k < 3; k++) { pColor.cur[k] += (pColor.target[k] - pColor.cur[k]) * 0.12; lColor.cur[k] += (lColor.target[k] - lColor.cur[k]) * 0.12; }
    const particleRGB = pColor.cur.map(Math.round).join(","), lineRGB = lColor.cur.map(Math.round).join(",");
    ctx.fillStyle = `rgba(${particleRGB}, 0.5)`;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      for (let j = i + 1; j < particles.length; j++) {
        const q = particles[j];
        const dx = p.x - q.x, dy = p.y - q.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < maxDist * maxDist) {
          const d = Math.sqrt(d2);
          ctx.strokeStyle = `rgba(${lineRGB}, ${0.14 * (1 - d / maxDist)})`;
          ctx.lineWidth = 0.6;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        }
      }
    }
  }
  requestAnimationFrame(draw);
}

// ========== PHASE OVERLAY ==========
function showPhaseTransition(phase) {
  const overlay = $("phase-overlay");
  if (!overlay) return;
  const meta = { NIGHT: ["🌙", t("nightFalls"), "phase-night"], DAY: ["☀️", t("dayBreaks"), "phase-day"], VOTING: ["🗳️", t("votingTime"), "phase-vote"] }[phase];
  if (!meta) return;
  $("phase-overlay-icon").textContent = meta[0];
  $("phase-overlay-text").textContent = meta[1];
  overlay.className = `phase-overlay ${meta[2]}`;
  void overlay.offsetWidth;
  overlay.classList.add("active");
  clearTimeout(phaseOverlayTimer);
  phaseOverlayTimer = setTimeout(() => overlay.classList.remove("active"), 1600);
}
let phaseOverlayTimer = null;
function setPhaseTheme(phase) { document.body.dataset.phase = phase || ""; }

// ========== GUIDE ==========
function showGuide() {
  const existing = document.querySelector(".guide-overlay");
  if (existing) { existing.close?.(); return; }
  const keys = ["Werwolf", "Dorfbewohner", ...OPTIONAL_ROLES];
  const overlay = document.createElement("div");
  overlay.className = "guide-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `
    <div class="guide-container glass-card">
      <div class="sheet-bar"><button class="sheet-close" id="closeGuideX" aria-label="${t("close")}">${ICON_X}</button></div>
      <div class="sheet-scroll">
      <div class="guide-header"><h2>${t("guideTitle")}</h2><p class="muted">${t("guideSub")}</p></div>
      <div class="guide-section"><h3>${t("guideGoal")}</h3><p>${t("guideGoalText")}</p></div>
      <div class="guide-section">
        <h3>${t("guidePhases")}</h3>
        <div class="guide-phase-flow">
          <div class="guide-phase-step"><span>🌙</span>${t("phaseNight")}</div><span class="guide-phase-arrow">→</span>
          <div class="guide-phase-step"><span>☀️</span>${t("phaseDay")}</div><span class="guide-phase-arrow">→</span>
          <div class="guide-phase-step"><span>🗳️</span>${t("phaseVote")}</div><span class="guide-phase-arrow">→</span>
          <div class="guide-phase-step"><span>🔁</span>${t("phaseRepeat")}</div>
        </div>
        <p class="small muted">${t("guidePhaseText")}</p>
      </div>
      <div class="guide-section"><h3>${t("guideRoles")}</h3>
        <div class="guide-role-grid">${keys.map(k => `
          <div class="guide-role-item"><div class="guide-role-icon">${getRoleIcon(k)}</div>
            <div class="guide-role-info"><strong>${roleName(k)}</strong> <span class="tiny muted">(${k === "Werwolf" ? t("teamWolves") : t("teamVillage")})</span><p>${roleDesc(k)}</p></div>
          </div>`).join("")}</div>
      </div>
      <div class="guide-section"><h3>${t("guideTips")}</h3>
        <ul class="guide-tips">${["tip1", "tip2", "tip3", "tip4", "tip5"].map(k => `<li>${t(k)}</li>`).join("")}</ul>
      </div>
      <button class="glass-button block" id="closeGuide">${t("understood")}</button>
    </div></div>`;
  document.body.appendChild(overlay);
  let release = backPush("guide", () => { release = null; overlay.remove(); });
  const close = () => { release?.(); release = null; overlay.remove(); };
  overlay.close = close;
  overlay.querySelector("#closeGuide").addEventListener("click", close);
  overlay.querySelector("#closeGuideX").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
}

// ========== MODALS ==========
const ICON_X = `<svg class="svg-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
const ICON_CHEV = `<svg class="svg-ico chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;

// Sheet on phones, centred dialog on larger screens. Back / Esc / backdrop / X all close it the same way.
function showModal(contentHtml, { onClose, closeLabel = t("close"), className = "", label = "" } = {}) {
  const modalDiv = document.createElement("div");
  modalDiv.className = "modal dyn-modal";
  modalDiv.setAttribute("role", "dialog");
  modalDiv.setAttribute("aria-modal", "true");
  if (label) modalDiv.setAttribute("aria-label", label);
  modalDiv.innerHTML = `<div class="modal-content glass-card ${className}"><div class="sheet-bar"><button class="sheet-close" data-close aria-label="${t("close")}">${ICON_X}</button></div><div class="sheet-scroll">${contentHtml}${closeLabel ? `<button class="glass-button ghost block" data-close style="margin-top:1rem;">${closeLabel}</button>` : ""}</div></div>`;
  document.body.appendChild(modalDiv);
  const finish = () => { if (!modalDiv.isConnected) return; modalDiv.remove(); onClose?.(); };
  let release = backPush("modal" + (++overlaySeq), () => { release = null; finish(); });
  const close = () => { release?.(); release = null; finish(); };
  modalDiv.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", close));
  modalDiv.addEventListener("click", (e) => { if (e.target === modalDiv) close(); });
  modalDiv.close = close;
  return modalDiv;
}

function showConfirmModal(message, onConfirm, { yes = t("yes"), danger = true } = {}) {
  const m = showModal(`
    <h3 class="center">${t("confirmTitle")}</h3>
    <p class="center muted" style="margin-bottom:1.2rem;">${message}</p>
    <button class="glass-button block ${danger ? "btn-danger" : ""}" id="confirmYes">${yes}</button>`, { closeLabel: t("cancel") });
  m.querySelector("#confirmYes").addEventListener("click", () => { m.close(); onConfirm(); });
}

function spawnConfetti() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#2563eb", "#3b82f6", "#60a5fa", "#38bdf8", "#7dd3fc", "#f59e0b", "#ec4899", "#22c55e"];
  const n = window.innerWidth < 760 ? 30 : 50;
  for (let i = 0; i < n; i++) {
    const el = document.createElement("div");
    el.className = "confetti-piece";
    el.style.left = Math.random() * 100 + "vw";
    el.style.background = colors[Math.floor(Math.random() * colors.length)];
    el.style.animationDelay = Math.random() * 1.2 + "s";
    el.style.animationDuration = (2 + Math.random() * 2) + "s";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
}

// ========== RENDER ==========
// Same screenKey → swap content silently (no animation, scroll kept) so live updates don't flicker.
function render(html, key = null) {
  const same = key !== null && key === screenKey;
  const y = mainEl.scrollTop;
  // Live updates of the same screen must not replay the entrance animations.
  if (same) ui.classList.remove("screen-enter");
  ui.innerHTML = html;
  syncDock(!same);
  if (same) { mainEl.scrollTop = y; return; }
  screenKey = key;
  document.querySelectorAll(".dyn-modal.step-bound").forEach(m => m.close?.());
  ui.classList.remove("screen-enter");
  void ui.offsetWidth;
  ui.classList.add("screen-enter");
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => ui.classList.remove("screen-enter"), 1500);
  mainEl.scrollTop = 0;
}
let enterTimer = null;

// The screen's primary actions move from the content into the dock (own shell row above the gesture bar),
// so they are always reachable and never cover a list. Ids stay the same, bindings work unchanged.
const dock = $("dock");
function syncDock(enter) {
  const items = ui.querySelectorAll(".action-bar, .lobby-actions, .dock-note");
  dock.replaceChildren(...items);
  const has = items.length > 0;
  dock.hidden = !has;
  $("app-shell")?.classList.toggle("has-dock", has);
  if (has && enter && !reduceMotion()) {
    dock.classList.remove("dock-enter"); void dock.offsetWidth; dock.classList.add("dock-enter");
  }
}
if (window.ResizeObserver) new ResizeObserver(() => document.documentElement.style.setProperty("--dock-h", (dock.hidden ? 0 : dock.offsetHeight) + "px")).observe(dock);

// Tap-to-select list of player cards. Selection survives live re-renders of the same screen.
function bindPicker(gridId, { multi = 0, initial = null, allowNone = false, onChange } = {}) {
  const grid = $(gridId);
  if (!grid) return () => null;
  const k = screenKey + "|" + gridId;
  let sel = uiSel.has(k) ? uiSel.get(k) : (initial ?? (multi ? [] : null));
  const valid = new Set([...grid.querySelectorAll(".pick:not(.disabled)")].map(c => c.dataset.id));
  sel = multi ? sel.filter(id => valid.has(id)) : (valid.has(sel) ? sel : null);
  const paint = () => grid.querySelectorAll(".pick").forEach(c => {
    const on = multi ? sel.includes(c.dataset.id) : sel === c.dataset.id;
    c.classList.toggle("selected", on);
    c.setAttribute("aria-pressed", on ? "true" : "false");
  });
  grid.addEventListener("click", (e) => {
    const c = e.target.closest(".pick");
    if (!c || c.classList.contains("disabled")) return;
    const id = c.dataset.id;
    if (multi) {
      if (sel.includes(id)) sel = sel.filter(x => x !== id);
      else if (sel.length < multi) sel = [...sel, id];
      else return;
    } else sel = allowNone && sel === id ? null : id;
    uiSel.set(k, sel);
    buzz(8);
    paint();
    c.classList.remove("pop"); void c.offsetWidth; c.classList.add("pop");
    c.addEventListener("animationend", () => c.classList.remove("pop"), { once: true });
    onChange?.(sel);
  });
  paint();
  onChange?.(sel);
  return () => sel;
}

function pickCard(p, { badge = "", sub = "", disabled = false } = {}) {
  return `<button type="button" class="pick${disabled ? " disabled" : ""}" data-id="${escapeHtml(p.id)}" ${disabled ? "disabled" : ""}>
    ${avatar(p)}<span class="pick-name">${escapeHtml(p.name)}${isMe(p.id) ? ` <span class="tiny muted">(${t("you")})</span>` : ""}</span>
    ${sub ? `<span class="pick-sub">${sub}</span>` : ""}${badge ? `<span class="pick-badge">${badge}</span>` : ""}
  </button>`;
}

// Busy-guard for buttons that write to Firestore (prevents double taps / double writes).
function onAction(id, fn) {
  const el = $(id);
  if (!el) return;
  el.addEventListener("click", async () => {
    if (el.dataset.busy) return;
    el.dataset.busy = "1"; el.classList.add("busy");
    try { await fn(); } finally { delete el.dataset.busy; el.classList.remove("busy"); }
  });
}

async function act(fields) {
  try { await updateDoc(lobbyRef(), fields); return true; }
  catch (e) { console.warn("action failed", e); showToast(t("actionFailed"), "error"); return false; }
}

// ========== ROLE CARD ==========
let roleDisplayTimer = null;
function roleExtras(d, me) {
  const extras = [];
  if (me.role === "Werwolf") {
    const pack = d.players.filter(p => inGame(p) && p.role === "Werwolf" && p.id !== me.id);
    if (pack.length) extras.push(`🐺 ${t("yourPack")}: <strong>${pack.map(p => escapeHtml(p.name)).join(", ")}</strong>`);
  }
  const lovers = d.actionData?.lovers || [];
  if (lovers.includes(me.id)) {
    const other = byId(d, lovers.find(l => l !== me.id));
    if (other) extras.push(`💘 ${t("inLoveWith")}: <strong>${escapeHtml(other.name)}</strong>`);
  }
  return extras;
}

function showRoleCard(role, extras = [], timed = false) {
  const box = $("role-display");
  $("role-name").innerText = roleName(role);
  $("role-description").innerHTML = escapeHtml(roleDesc(role)) + (extras.length ? `<div class="role-extras">${extras.map(e => `<div>${e}</div>`).join("")}</div>` : "");
  $("role-reveal-icon").textContent = getRoleIcon(role);
  const fill = $("role-timer-fill");
  box.querySelector(".role-timer-bar").style.display = timed ? "" : "none";
  box.style.display = "flex";
  if (!roleRelease) roleRelease = backPush("role", () => { roleRelease = null; hideRoleCard(); });
  clearTimeout(roleDisplayTimer);
  if (timed) {
    fill.style.transition = "none"; fill.style.width = "100%";
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.transition = "width 9s linear"; fill.style.width = "0%"; }));
    roleDisplayTimer = setTimeout(hideRoleCard, 9000);
  }
}
let roleRelease = null;
function hideRoleCard() {
  clearTimeout(roleDisplayTimer);
  roleRelease?.(); roleRelease = null;
  const b = $("role-display"); if (b) b.style.display = "none";
}

// ========== PRESENCE & HEARTBEAT ==========
function trackPresence(d) {
  const now = Date.now();
  const hb = d.heartbeats || {};
  for (const p of d.players || []) {
    const v = hb[p.id] || 0;
    if (presence.hb[p.id] !== v) { presence.hb[p.id] = v; presence.seenAt[p.id] = now; }
  }
}
function isPlayerOnline(id) {
  if (isMe(id)) return true;
  const s = presence.seenAt[id];
  return s != null && Date.now() - s < OFFLINE_MS;
}
function noteSeq(d) { if (d.seq !== seqSeen.seq) seqSeen = { seq: d.seq, at: Date.now() }; }
function localDeadline(d) { return d.stepDuration ? seqSeen.at + d.stepDuration : 0; }

async function sendHeartbeat() {
  if (!currentLobbyId || !firebaseReady) return;
  try { await updateDoc(lobbyRef(), { [`heartbeats.${currentUser.id}`]: Date.now(), lastUpdate: Date.now() }); } catch {}
}
function startHeartbeat() {
  clearInterval(heartbeatTimer);
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, HB_MS);
}

// Keep the screen awake during a game: a sleeping phone stops sending heartbeats and timers.
let wakeLock = null;
async function requestWakeLock() {
  try {
    if (!currentLobbyId || wakeLock || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch { wakeLock = null; }
}
function releaseWakeLock() { try { wakeLock?.release(); } catch {} wakeLock = null; }

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !currentLobbyId) return;
  sendHeartbeat();
  requestWakeLock();
  if (currentLobby) tick();
});

// ========== SESSION ==========
function saveSession(code) { storageSet(SESSION_KEY, code); }
function clearSession() { storageDel(SESSION_KEY); }

const seenLobbyPlayers = new Set();
function enterLobby(code) {
  detachLobby(false, { keepScreen: true });
  if (Back && Back.route !== "lobby") Back.navigate("lobby");   // back from the lobby = leave (see onLobbyBack)
  seenLobbyPlayers.clear();
  currentLobbyId = code;
  saveSession(code);
  presence.hb = {}; presence.seenAt = {};
  seqSeen = { seq: null, at: 0 };
  lastFp = null; lastPhase = null; screenKey = null;
  uiSel.clear();
  startHeartbeat();
  attachListener(code);
  attachChatListener(code);
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 1000);
  requestWakeLock();
  render(`<div class="loader" style="margin-top:20vh;"></div>`, "loading");
}

function detachLobby(toMenu = true, { keepScreen = false } = {}) {
  unsubscribeLobby?.(); unsubscribeLobby = null;
  unsubscribeChat?.(); unsubscribeChat = null;
  clearInterval(heartbeatTimer); heartbeatTimer = null;
  clearInterval(tickTimer); tickTimer = null;
  currentLobbyId = null; currentLobby = null;
  chatMessages = []; chatChannel = null; chatOpen = false; renderedMsgIds.clear(); lastUnread = 0;
  updateChatUI();
  releaseWakeLock();
  hideRoleCard();
  setPhaseTheme(null);
  setNetProblem(false);
  document.querySelectorAll(".dyn-modal").forEach(m => m.close?.());
  if (!keepScreen && Back?.route === "lobby") Back.leave();
  if (toMenu) renderMainMenu();
}

// System back on the lobby/game screen: a running game asks first, a lobby or finished game is left directly.
function onLobbyBack() {
  const d = currentLobby;
  if (!currentLobbyId) return;
  if (d?.gameStarted && d.phase !== "ENDED") {
    Back.navigate("lobby");                      // stay on the game screen until the player confirms
    showConfirmModal(t("leaveConfirm"), leaveLobby, { yes: t("leave") });
  } else leaveLobby();
}

// ========== LOBBY MANAGEMENT ==========
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genCode() {
  const a = new Uint32Array(6);
  crypto.getRandomValues(a);
  return [...a].map(x => CODE_CHARS[x % CODE_CHARS.length]).join("");
}
function newPlayer(name) { return { id: currentUser.id, name, deviceId, isAlive: true, role: null }; }

async function createLobby(playerName, isPublic, mode, settings) {
  if (!consentGiven || !firebaseReady || !navigator.onLine) throw new Error(t("noConnection"));
  const now = Date.now();
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = genCode();
    const ref = doc(db, "lobbies", code);
    const ok = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists() && now - (snap.data().lastUpdate || 0) < LOBBY_EXPIRE_MS) return false;
      tx.set(ref, {
        code, hostId: currentUser.id, isPublic, mode, settings,
        gameStarted: false, phase: "LOBBY", narratorStep: null, seq: 0, stepDuration: 0,
        players: [newPlayer(playerName)], kicked: [],
        volunteerNarratorId: null, confirmedNarratorId: mode === "online" ? "AUTOMATIC" : null,
        actionData: defaultActionData(), votes: {}, readyVotes: {}, news: [], winner: null, round: 0,
        nightActionsOrder: [], currentNightIndex: 0, gameId: null, firstNightDone: false,
        heartbeats: { [currentUser.id]: now }, lastUpdate: now, createdAt: now
      });
      return true;
    });
    if (ok) { enterLobby(code); return code; }
  }
  throw new Error(t("createFailed"));
}

async function joinLobby(rawCode, playerName, { silent = false } = {}) {
  if (!consentGiven || !firebaseReady || !navigator.onLine) throw new Error(t("noConnection"));
  const code = String(rawCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 6) throw new Error(t("lobbyNotFound"));
  const ref = doc(db, "lobbies", code);
  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return "notfound";
    const d = snap.data();
    if (Date.now() - (d.lastUpdate || 0) > LOBBY_EXPIRE_MS) return "expired";
    if ((d.kicked || []).includes(currentUser.id)) return "kicked";
    // Already part of this lobby (same id, or same device) → just reconnect, even mid-game.
    const existing = d.players.find(p => p.id === currentUser.id || (deviceId && p.deviceId === deviceId));
    if (existing && !existing.left) {
      if (existing.id !== currentUser.id) { currentUser.id = existing.id; storageSet("ww_player_id", existing.id); }
      tx.update(ref, { [`heartbeats.${existing.id}`]: Date.now(), lastUpdate: Date.now() });
      return "ok";
    }
    if (d.gameStarted) return "running";
    if (d.players.length >= MAX_PLAYERS) return "full";
    let name = playerName;
    const taken = new Set(d.players.map(p => p.name.toLowerCase()));
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${playerName} ${i}`;
    tx.update(ref, {
      players: [...d.players.filter(p => p.id !== currentUser.id), newPlayer(name)],
      [`heartbeats.${currentUser.id}`]: Date.now(), lastUpdate: Date.now()
    });
    return "ok";
  });
  const errors = { notfound: "lobbyNotFound", expired: "lobbyExpired", kicked: "youWereKicked", running: "gameRunning", full: "lobbyFull" };
  if (result !== "ok") throw new Error(t(errors[result] || "lobbyNotFound"));
  if (currentLobbyId !== code) enterLobby(code);
  if (!silent) buzz(15);
}

async function kickPlayer(pid) {
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(lobbyRef());
      if (!snap.exists()) return;
      const d = snap.data();
      if (d.hostId !== currentUser.id || isMe(pid)) return;
      const upd = { kicked: arrayUnion(pid), [`heartbeats.${pid}`]: deleteField() };
      if (d.gameStarted && d.phase !== "ENDED") upd.players = d.players.map(p => p.id === pid ? { ...p, isAlive: false, left: true } : p);
      else upd.players = d.players.filter(p => p.id !== pid);
      if (d.volunteerNarratorId === pid) upd.volunteerNarratorId = null;
      if (d.confirmedNarratorId === pid && !d.gameStarted) upd.confirmedNarratorId = null;
      tx.update(lobbyRef(), upd);
    });
  } catch (e) { showToast(t("actionFailed"), "error"); }
}

async function leaveLobby() {
  const id = currentLobbyId;
  const me = currentUser.id;
  clearSession();
  detachLobby(true);
  if (!id) return;
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "lobbies", id);
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const d = snap.data();
      const midGame = d.gameStarted && d.phase !== "ENDED";
      // Mid-game we keep the seat (marked dead + left) so the role reveal and win check stay correct.
      const players = midGame ? d.players.map(p => p.id === me ? { ...p, isAlive: false, left: true } : p) : d.players.filter(p => p.id !== me);
      const remaining = players.filter(p => !p.left);
      if (!remaining.length) { tx.delete(ref); return; }
      const upd = { players, [`heartbeats.${me}`]: deleteField(), lastUpdate: Date.now() };
      if (d.hostId === me) upd.hostId = (remaining.find(p => p.role !== NARRATOR) || remaining[0]).id;
      if (d.volunteerNarratorId === me) upd.volunteerNarratorId = null;
      if (!d.gameStarted && d.confirmedNarratorId === me) upd.confirmedNarratorId = null;
      tx.update(ref, upd);
    });
  } catch (e) { console.warn("leave failed", e); }
}

function confirmLeave() {
  const d = currentLobby;
  if (d?.gameStarted && d.phase !== "ENDED") showConfirmModal(t("leaveConfirm"), leaveLobby, { yes: t("leave") });
  else leaveLobby();
}

// Seq-guarded transaction: `build(freshData)` returns the update or null. A second caller with the
// same expected seq (other client, timeout, double tap) is a harmless no-op.
// Calls are queued: a tap that lands while the automatic narrator is mid-transition waits for it
// (the seq guard then decides) instead of being silently dropped.
let transitionQueue = Promise.resolve();
function transition(expectSeq, build) {
  const run = transitionQueue.then(() => runTransition(expectSeq, build));
  transitionQueue = run.catch(() => false);
  return run;
}
async function runTransition(expectSeq, build) {
  if (!currentLobbyId) return false;
  transitionBusy = true;
  const ref = lobbyRef();
  try {
    return await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return false;
      const d = { id: snap.id, ...snap.data() };
      if ((d.seq || 0) !== expectSeq) return false;
      let upd = build(d);
      if (!upd) return false;
      upd = finalizeUpdate(d, upd);
      tx.update(ref, { ...upd, seq: expectSeq + 1, lastUpdate: Date.now() });
      return true;
    });
  } catch (e) { console.warn("transition failed", e); return false; }
  finally { transitionBusy = false; }
}
const advance = (d) => transition(d.seq || 0, buildAdvance);

// ========== LISTENER ==========
let cacheTimer = null;
function attachListener(code) {
  unsubscribeLobby?.();
  unsubscribeLobby = onSnapshot(lobbyRef(code), { includeMetadataChanges: true }, (snap) => {
    if (code !== currentLobbyId) return;
    if (snap.metadata.fromCache) setNetProblem(true); else setNetProblem(false);
    if (!snap.exists()) { if (!snap.metadata.fromCache) onLobbyGone(); return; }
    const d = { id: snap.id, ...snap.data() };
    const me = (d.players || []).find(p => p.id === currentUser.id);
    if (!me || me.left) { handleRemoved(d, me); return; }
    currentLobby = d;
    trackPresence(d);
    noteSeq(d);
    if (d.gameStarted && lastPhase && d.phase !== lastPhase) showPhaseTransition(d.phase);
    lastPhase = d.phase;
    setPhaseTheme(d.gameStarted ? d.phase : null);
    refreshChatChannel(d, me);
    tick();
  }, (err) => { console.warn("lobby listener error", err); setNetProblem(true); });
}

function onLobbyGone() {
  clearSession();
  detachLobby(false);
  render(`<div class="glass-card narrow center">
    <div class="big-emoji">🚪</div><h2>${t("lobbyClosed")}</h2><p class="muted" style="margin:1rem 0;">${t("lobbyClosedBody")}</p>
    <button class="glass-button block" id="backHome">${t("backToMenu")}</button></div>`, "gone");
  $("backHome")?.addEventListener("click", renderMainMenu);
}

let rejoinInFlight = false;
async function handleRemoved(d, me) {
  if (rejoinInFlight) return;
  const kicked = (d.kicked || []).includes(currentUser.id);
  // Dropped for inactivity before the game started → quietly sit back down instead of kicking.
  if (!kicked && !me && !d.gameStarted && Date.now() - rejoinAttemptAt > 10000 && currentUser.name) {
    rejoinAttemptAt = Date.now();
    rejoinInFlight = true;
    try { await joinLobby(d.id, currentUser.name, { silent: true }); return; } catch {}
    finally { rejoinInFlight = false; }
    if (currentLobbyId !== d.id) return;
  }
  clearSession();
  detachLobby(true);
  showToast(kicked ? t("youWereKicked") : t("removedFromLobby"), "warning", 4500);
}

// ========== THE TICK (1s): countdown, presence, re-render, automatic narrator ==========
function fingerprint(d) {
  const { heartbeats, lastUpdate, ...rest } = d;
  const online = (d.players || []).filter(p => isPlayerOnline(p.id)).map(p => p.id).join(",");
  return JSON.stringify(rest) + "|" + online + "|" + getLang();
}

function tick() {
  const d = currentLobby;
  if (!d) return;
  const fp = fingerprint(d);
  if (fp !== lastFp) { lastFp = fp; renderByState(d); }
  updateCountdown(d);
  drive(d);
}

function updateCountdown(d) {
  const el = $("phaseCountdown");
  const bar = $("phaseBar");
  const deadline = localDeadline(d);
  if (!el || !deadline) return;
  const left = Math.max(0, deadline - Date.now());
  const s = Math.ceil(left / 1000);
  el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  el.classList.toggle("urgent", s <= 10);
  if (bar) bar.style.width = (100 * left / d.stepDuration).toFixed(1) + "%";
}

let lastDriveAt = 0;
async function drive(d) {
  const now = Date.now();
  if (transitionBusy || now - lastDriveAt < 900) return;
  lastDriveAt = now;
  const iAmHost = d.hostId === currentUser.id;

  // Host failover: host's heartbeat hasn't changed for a while → the first online player takes over.
  // The host only loses the crown, never their seat.
  if (!iAmHost && !isPlayerOnline(d.hostId)) {
    const successor = d.players.find(p => !p.left && isPlayerOnline(p.id));
    if (successor && isMe(successor.id)) {
      const seenHb = presence.hb[d.hostId] || 0;
      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(lobbyRef());
          if (!snap.exists()) return;
          const f = snap.data();
          if (f.hostId !== d.hostId || (f.heartbeats?.[d.hostId] || 0) !== seenHb) return; // host is back
          tx.update(lobbyRef(), { hostId: currentUser.id });
        });
      } catch {}
      return;
    }
  }

  // Pre-game cleanup of long-gone players (never during a game – there they just show as offline).
  if (iAmHost && !d.gameStarted) {
    const gone = d.players.filter(p => !isMe(p.id) && presence.seenAt[p.id] != null && now - presence.seenAt[p.id] > LOBBY_PRUNE_MS);
    if (gone.length) {
      const seen = Object.fromEntries(gone.map(p => [p.id, presence.hb[p.id] || 0]));
      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(lobbyRef());
          if (!snap.exists() || snap.data().gameStarted) return;
          const f = snap.data();
          const drop = new Set(Object.keys(seen).filter(id => (f.heartbeats?.[id] || 0) === seen[id]));
          if (!drop.size) return;
          tx.update(lobbyRef(), { players: f.players.filter(p => !drop.has(p.id)) });
        });
      } catch {}
    }
    return;
  }
  if (!d.gameStarted || d.phase === "ENDED") return;

  // Someone left/won outside a transition → end the game.
  if (buildWinCheck(d)) { await transition(d.seq || 0, buildWinCheck); return; }
  if (d.mode !== "online") return; // local mode: the human narrator drives

  const deadline = localDeadline(d);
  const elapsed = now - seqSeen.at;
  if (iAmHost) {
    if (stepDone(d, elapsed, isPlayerOnline) || (deadline && now >= deadline)) await advance(d);
  } else if (deadline && now >= deadline + GRACE_MS) {
    // Safety net: if the host is frozen, anyone may push the timed-out step (seq-guarded).
    await advance(d);
  }
}

// ========== CHAT ==========
let chatMessages = [];
let chatChannel = null;
let chatOpen = false;
let chatReadAt = {};
let lastChatSend = 0;
let lastUnread = 0;
const renderedMsgIds = new Set();

function chatChannelFor(d, me) {
  if (!d || !me || d.mode === "lokal" || me.role === NARRATOR) return null;
  if (!d.gameStarted || d.phase === "ENDED") return "public";
  if (!me.isAlive) return "dead";
  if (d.phase === "NIGHT") return me.role === "Werwolf" ? "wolf" : null;
  return "public";
}
const chatGame = (d) => (d?.gameStarted ? d.gameId : "lobby");

function refreshChatChannel(d, me) {
  const ch = chatChannelFor(d, me);
  if (ch !== chatChannel) {
    chatChannel = ch;
    if (!ch) chatOpen = false;
    if (ch === "wolf") $("chat-top")?.classList.add("pulse");
  }
  updateChatUI();
}

function attachChatListener(code) {
  unsubscribeChat?.();
  const q2 = query(collection(db, "lobbies", code, "messages"), orderBy("timestamp", "asc"), limitToLast(120));
  unsubscribeChat = onSnapshot(q2, (snap) => {
    chatMessages = snap.docs.map(x => ({ id: x.id, ...x.data() }));
    updateChatUI();
  }, (e) => console.warn("chat listener", e));
}

function visibleMessages() {
  const g = chatGame(currentLobby);
  return chatMessages.filter(m => m.channel === chatChannel && (m.g ?? "lobby") === g);
}

function updateChatUI() {
  const sheet = $("chat-container");
  const top = $("chat-top");
  if (!sheet || !top) return;
  const show = !!chatChannel;
  if (!show && chatRelease) { chatRelease(); chatRelease = null; }
  top.hidden = !show;
  top.dataset.channel = chatChannel || "";
  top.classList.toggle("active", show && chatOpen);
  top.setAttribute("aria-expanded", String(show && chatOpen));
  sheet.classList.toggle("open", show && chatOpen);
  document.documentElement.classList.toggle("chat-open", show && chatOpen);
  if (!show) return;
  const title = chatChannel === "wolf" ? t("wolfChat") : chatChannel === "dead" ? t("ghostChat") : t("chat");
  $("chat-title").textContent = title;
  const msgs = visibleMessages();
  const readKey = chatChannel + ":" + chatGame(currentLobby);
  if (chatOpen) chatReadAt[readKey] = msgs.length;
  const unread = Math.max(0, msgs.length - (chatReadAt[readKey] || 0));
  if (unread > lastUnread) { top.classList.remove("bump"); void top.offsetWidth; top.classList.add("bump"); }
  lastUnread = unread;
  const badge = $("chat-badge-top");
  if (badge) { badge.textContent = unread > 9 ? "9+" : String(unread); badge.hidden = !unread; }
  if (!chatOpen) return;
  const box = $("chat-messages");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const animate = renderedMsgIds.size > 0;
  box.innerHTML = msgs.length ? msgs.map(m => {
    let cls = "chat-msg";
    if (animate && !renderedMsgIds.has(m.id)) cls += " new";
    renderedMsgIds.add(m.id);
    if (isMe(m.senderId)) cls += " chat-msg-own";
    if (m.channel === "wolf") cls += " chat-msg-wolf";
    if (m.channel === "dead") cls += " chat-msg-dead";
    return `<div class="${cls}"><span class="chat-msg-name">${escapeHtml(m.senderName)}</span><span class="chat-msg-text">${escapeHtml(m.text)}</span></div>`;
  }).join("") : `<div class="chat-empty">${t("noMessages")}</div>`;
  if (atBottom || box.dataset.justOpened) { box.scrollTop = box.scrollHeight; delete box.dataset.justOpened; }
}

let chatRelease = null;
function setChatOpen(open) {
  chatOpen = open && !!chatChannel;
  if (chatOpen && !chatRelease) chatRelease = backPush("chat", () => { chatRelease = null; setChatOpen(false); });
  if (!chatOpen && chatRelease) { chatRelease(); chatRelease = null; }
  $("chat-top")?.classList.remove("pulse");
  if (chatOpen) $("chat-messages").dataset.justOpened = "1";
  updateChatUI();
  // Focus the field only with a mouse/trackpad: on touch screens the keyboard would cover half the screen uninvited.
  if (chatOpen && finePointer.matches) setTimeout(() => $("chat-input")?.focus(), 150);
}

async function sendChatMessage() {
  const input = $("chat-input");
  const text = input?.value.trim();
  if (!text || !currentLobbyId || !chatChannel) return;
  if (Date.now() - lastChatSend < 700) return; // basic flood guard
  lastChatSend = Date.now();
  input.value = "";
  try {
    await addDoc(collection(db, "lobbies", currentLobbyId, "messages"), {
      senderId: currentUser.id, senderName: currentLobby?.players.find(p => isMe(p.id))?.name || currentUser.name,
      text: text.slice(0, 200), timestamp: Date.now(), channel: chatChannel, g: chatGame(currentLobby)
    });
  } catch (e) { input.value = text; showToast(t("actionFailed"), "error"); }
}

// Keep the chat sheet above the on-screen keyboard (iOS ignores interactive-widget).
function initKeyboardOffset() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--kb", kb + "px");
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
}

// ========== RENDER DISPATCH ==========
const PHASE_META = {
  NIGHT: { icon: "🌙", key: "phaseNight" }, DAY: { icon: "☀️", key: "phaseDay" },
  VOTING: { icon: "🗳️", key: "phaseVote" }, HUNTER: { icon: "🎯", key: "phaseHunter" }
};

function renderByState(d) {
  currentRender = () => { lastFp = null; tick(); };
  const me = d.players.find(p => isMe(p.id));
  if (!me) return;
  if (d.phase === "ENDED") { renderWinScreen(d, me); return; }
  if (!d.gameStarted) { renderLobbyView(d, me); return; }

  // Role reveal once per game for every player.
  if (me.role && me.role !== NARRATOR && lastRevealId !== d.gameId) {
    lastRevealId = d.gameId;
    showRoleCard(me.role, roleExtras(d, me), true);
    buzz([30, 60, 30]);
  }
  // Lovers learn about each other once.
  const lovers = d.actionData?.lovers || [];
  if (lovers.includes(me.id) && lastLoverNotice !== d.gameId + lovers.join()) {
    lastLoverNotice = d.gameId + lovers.join();
    const other = byId(d, lovers.find(l => l !== me.id));
    if (other) { showToast(`💘 ${t("inLoveWith")}: ${other.name}`, "success", 6000); buzz([20, 40, 20]); }
  }

  if (me.role === NARRATOR) renderNarratorDashboard(d);
  else renderPlayerGameView(d, me);
}

// ---------- shared game fragments ----------
function gameHeader(d, me) {
  const ph = PHASE_META[d.phase] || { icon: "🎭", key: "phaseNight" };
  const timed = d.mode === "online" && d.stepDuration;
  const roleBtn = me && me.role && me.role !== NARRATOR
    ? `<button class="role-chip" id="roleChip" aria-label="${t("showRole")}"><span>🎭</span><span>${t("myRole")}</span></button>` : "";
  return `
    <div class="game-head">
      <div class="phase-pill"><span class="phase-icon">${ph.icon}</span><span><strong>${t(ph.key)}</strong>${d.round ? `<span class="round">${t("roundN", { n: d.round })}</span>` : ""}</span></div>
      ${timed ? `<span class="countdown" id="phaseCountdown">–</span>` : ""}
      ${roleBtn}
    </div>
    ${timed ? `<div class="timer-bar"><div id="phaseBar"></div></div>` : ""}`;
}

function newsHtml(d) {
  const reveal = d.settings?.revealRoles !== false;
  const roleTxt = (n) => (reveal && n.role ? ` <span class="news-role">(${getRoleIcon(n.role)} ${roleName(n.role)})</span>` : "");
  const name = (n) => `<strong>${escapeHtml(n.name)}</strong>`;
  const lines = (d.news || []).map(n => {
    switch (n.t) {
      case "killed": return `☠️ ${t("newsKilled", { name: name(n) })}${roleTxt(n)}`;
      case "lover": return `💔 ${t("newsLover", { name: name(n) })}${roleTxt(n)}`;
      case "girlCaught": return `👧 ${t("newsGirlCaught", { name: name(n) })}${roleTxt(n)}`;
      case "executed": return `⚖️ ${t("newsExecuted", { name: name(n) })}${roleTxt(n)}`;
      case "shot": return `🎯 ${t("newsShot", { by: `<strong>${escapeHtml(n.by)}</strong>`, name: name(n) })}${roleTxt(n)}`;
      case "prince": return `👑 ${t("princeSurvived", { name: name(n) })}`;
      case "tie": return `🤝 ${t("tieNoExec")}`;
      case "noVotes": return `🤷 ${t("noVotesNoExec")}`;
      default: return "";
    }
  }).filter(Boolean);
  if (!lines.length) return d.phase === "DAY" ? `<div class="news good">🌅 ${t("nobodyDied")}</div>` : "";
  const bad = (d.news || []).some(n => ["killed", "lover", "girlCaught", "executed", "shot"].includes(n.t));
  return `<div class="news ${bad ? "bad" : ""}">${lines.map(l => `<div>${l}</div>`).join("")}</div>`;
}

function playersPanel(d, me, { showRoles = false } = {}) {
  const reveal = d.settings?.revealRoles !== false;
  const lovers = d.actionData?.lovers || [];
  const iAmLover = lovers.includes(me?.id);
  const list = d.players.filter(p => p.role !== NARRATOR);
  const aliveN = list.filter(p => p.isAlive && !p.left).length;
  return `<div class="panel">
    <div class="panel-title">👥 ${t("aliveCount", { n: aliveN })}</div>
    <div class="mini-list">${list.map(p => {
      const marks = [];
      if (p.id === d.hostId) marks.push("👑");
      if (me?.role === "Werwolf" && p.role === "Werwolf" && !isMe(p.id)) marks.push("🐺");
      if (iAmLover && lovers.includes(p.id) && !isMe(p.id)) marks.push("💘");
      const roleShown = (showRoles || (!p.isAlive && reveal)) && p.role ? `<span class="mini-role">${getRoleIcon(p.role)} ${roleName(p.role)}</span>` : "";
      return `<div class="mini ${p.isAlive ? "" : "dead"} ${p.left ? "left" : ""}">
        ${avatar(p, "sm")}<span class="mini-name">${escapeHtml(p.name)}${isMe(p.id) ? ` (${t("you")})` : ""} ${marks.join("")}</span>
        ${roleShown}${p.left ? `<span class="tiny muted">${t("leftGame")}</span>` : (!isPlayerOnline(p.id) ? `<span class="offline-dot" title="${t("offline")}"></span>` : "")}
      </div>`;
    }).join("")}</div>
  </div>`;
}

function gameFooter(d) {
  const isHost = d.hostId === currentUser.id;
  return `<div class="game-footer">
    <button class="glass-button ghost small" id="leaveLobbyBtn"><span class="ico" aria-hidden="true">🚪</span> ${t("leave")}</button>
    ${isHost ? `<button class="glass-button ghost small danger-text" id="endGameHost"><span class="ico" aria-hidden="true">⏹</span> ${t("endGame")}</button>` : ""}
  </div>`;
}

function bindGameChrome(d, me) {
  $("roleChip")?.addEventListener("click", () => showRoleCard(me.role, roleExtras(d, me), false));
  $("leaveLobbyBtn")?.addEventListener("click", confirmLeave);
  $("endGameHost")?.addEventListener("click", () => showConfirmModal(t("endGameConfirm"), () => transition(currentLobby?.seq || 0, (f) => f.gameStarted ? buildRestart(f) : null)));
}

function stepScript(d) {
  if (d.phase === "NIGHT") {
    const step = d.nightActionsOrder?.[d.currentNightIndex || 0];
    return { AMOR: t("scriptAmor"), "BESCHÜTZER": t("scriptGuard"), WEREWOLF: t("scriptWolf"), SMALL_GIRL: t("scriptGirl"), SEER: t("scriptSeer"), WITCH: t("scriptWitch") }[step] || t("scriptNight");
  }
  return { DAY: t("scriptDay"), VOTING: t("scriptVote"), HUNTER: t("scriptHunter") }[d.phase] || "";
}

// ---------- player view ----------
function renderPlayerGameView(d, me) {
  const body = playerBody(d, me);
  const key = `${d.gameId}:${d.seq}:${body.key || ""}`;
  const isYourTurn = !!body.turn;
  render(`<div class="game ${isYourTurn ? "your-turn" : ""}">
    ${gameHeader(d, me)}
    <div class="game-grid">
      <div class="game-main">${body.hideNews ? "" : newsHtml(d)}${body.html}</div>
      <aside class="game-side">${playersPanel(d, me, { showRoles: !me.isAlive })}${gameFooter(d)}</aside>
    </div>
  </div>`, key);
  if (isYourTurn && screenKey === key && !uiSel.has(key + "|buzzed")) { uiSel.set(key + "|buzzed", 1); buzz([40, 50, 40]); }
  bindGameChrome(d, me);
  body.bind?.();
  updateCountdown(d);
}

function waitCard(icon, title, text = "") {
  return `<div class="glass-card stage center"><div class="big-emoji">${icon}</div><h2>${title}</h2>${text ? `<p class="muted">${text}</p>` : ""}</div>`;
}

function playerBody(d, me) {
  const ad = d.actionData || {};
  const alive = alivePlayers(d);

  if (d.phase === "HUNTER") {
    const hunter = byId(d, ad.pendingHunterId);
    if (hunter && isMe(hunter.id)) {
      const targets = alive.filter(p => p.id !== me.id);
      return {
        key: "hunter", turn: true,
        html: `<div class="glass-card stage">
          <h2>${t("hunterTitle")}</h2><p class="muted">${t("hunterHint")}</p>
          <div class="pick-grid" id="hunterTargets">${targets.map(p => pickCard(p)).join("")}</div>
          <div class="action-bar">
            <button class="glass-button ghost" id="hunterSkip">${t("hunterNone")}</button>
            <button class="glass-button btn-danger" id="hunterSubmit" disabled>${t("hunterTake")}</button>
          </div></div>`,
        bind: () => {
          const get = bindPicker("hunterTargets", { onChange: (s) => { const b = $("hunterSubmit"); if (b) b.disabled = !s; } });
          onAction("hunterSubmit", () => transition(d.seq || 0, (f) => f.actionData?.pendingHunterId === me.id ? buildHunterShot(f, get()) : null));
          onAction("hunterSkip", () => transition(d.seq || 0, (f) => f.actionData?.pendingHunterId === me.id ? buildHunterShot(f, null) : null));
        }
      };
    }
    return { key: "hunterWait", html: waitCard("🎯", t("hunterKilled", { name: escapeHtml(hunter?.name || roleName("Jäger")) }), t("hunterShooting")) };
  }

  if (!me.isAlive) {
    return { key: "dead", html: `<div class="glass-card stage center ghost-card"><div class="big-emoji">👻</div><h2>${t("youAreDead")}</h2>
      <p class="muted">${t("deadHint")}</p><div class="script-line">${stepScript(d)}</div></div>` };
  }

  if (d.phase === "NIGHT") return nightBody(d, me, ad, alive);
  if (d.phase === "VOTING") return votingBody(d, me, alive);
  return dayBody(d, me, alive);
}

function nightBody(d, me, ad, alive) {
  const step = d.nightActionsOrder?.[d.currentNightIndex || 0];
  const seq = d.seq || 0;
  const sleeping = () => ({
    key: "sleep",
    html: `<div class="glass-card stage center night-card"><div class="big-emoji moon">🌙</div><h2>${t("sleeping")}</h2>
      <div class="script-line">${stepScript(d)}</div>
      ${me.role === "Werwolf" && d.mode === "online" ? `<p class="small muted">${t("wolfChatHint")}</p>` : ""}</div>`
  });

  if (step === "AMOR" && me.role === "Amor") {
    if (ad.amorDone) {
      const names = (ad.lovers || []).map(id => escapeHtml(byId(d, id)?.name || "?")).join(" & ");
      return { key: "amorDone", html: waitCard("💘", t("loversSet"), names) };
    }
    return {
      key: "amor", turn: true,
      html: `<div class="glass-card stage"><h2>${t("amorTitle")}</h2><p class="muted">${t("amorHint")}</p>
        <div class="pick-grid" id="amorTargets">${alive.map(p => pickCard(p)).join("")}</div>
        <div class="action-bar"><button class="glass-button block" id="amorSubmit" disabled>${t("amorConfirm")}</button></div></div>`,
      bind: () => {
        const get = bindPicker("amorTargets", { multi: 2, onChange: (s) => { const b = $("amorSubmit"); if (b) b.disabled = s.length !== 2; } });
        onAction("amorSubmit", async () => { const s = get(); if (s.length === 2 && d.seq === currentLobby?.seq) await act({ "actionData.lovers": s, "actionData.amorDone": true }); });
      }
    };
  }

  if (step === "BESCHÜTZER" && me.role === "Beschützer") {
    if (ad.guardDone) return { key: "guardDone", html: waitCard("🛡️", t("guardActive"), escapeHtml(byId(d, ad.guardTarget)?.name || "")) };
    const last = ad.lastGuardTarget;
    return {
      key: "guard", turn: true,
      html: `<div class="glass-card stage"><h2>${t("guardTitle")}</h2>${last ? `<p class="small muted">${t("guardCantSame")}</p>` : ""}
        <div class="pick-grid" id="guardTargets">${alive.map(p => pickCard(p, { disabled: p.id === last })).join("")}</div>
        <div class="action-bar"><button class="glass-button block" id="guardSubmit" disabled>${t("guardConfirm")}</button></div></div>`,
      bind: () => {
        const get = bindPicker("guardTargets", { onChange: (s) => { const b = $("guardSubmit"); if (b) b.disabled = !s; } });
        onAction("guardSubmit", async () => { const s = get(); if (s && d.seq === currentLobby?.seq) await act({ "actionData.guardTarget": s, "actionData.guardDone": true }); });
      }
    };
  }

  if (step === "WEREWOLF" && me.role === "Werwolf") {
    const votes = ad.werewolfVotes || {};
    const wolves = alive.filter(p => p.role === "Werwolf");
    const targets = alive.filter(p => p.role !== "Werwolf");
    const myVote = votes[me.id] || null;
    const votersFor = (id) => wolves.filter(w => votes[w.id] === id);
    const voted = wolves.filter(w => votes[w.id]).length;
    return {
      key: "wolf", turn: !myVote,
      html: `<div class="glass-card stage wolf-card"><h2>${t("wolfTitle")}</h2>
        <p class="small muted">${t("wolfPackVotes", { n: voted, t: wolves.length })}${wolves.length > 1 ? " · 🐺 " + wolves.map(w => escapeHtml(w.name)).join(", ") : ""}</p>
        <div class="pick-grid" id="wolfTargets">${targets.map(p => {
          const v = votersFor(p.id);
          return pickCard(p, { badge: v.length ? "🐺".repeat(v.length) : "", sub: v.length ? v.map(w => escapeHtml(w.name)).join(", ") : "" });
        }).join("")}</div>
        <div class="action-bar"><button class="glass-button btn-danger block" id="submitWolfVote" disabled>${myVote ? t("changeVote") : t("wolfConfirm")}</button></div>
        ${myVote ? `<p class="small center muted">✅ ${t("wolfVotedFor", { name: escapeHtml(byId(d, myVote)?.name || "?") })}</p>` : ""}</div>`,
      bind: () => {
        const get = bindPicker("wolfTargets", { initial: myVote, onChange: (s) => { const b = $("submitWolfVote"); if (b) b.disabled = !s || s === (currentLobby?.actionData?.werewolfVotes || {})[me.id]; } });
        onAction("submitWolfVote", async () => { const s = get(); if (s && d.seq === currentLobby?.seq) { if (await act({ [`actionData.werewolfVotes.${me.id}`]: s })) buzz(15); } });
      }
    };
  }

  if (step === "SMALL_GIRL" && me.role === "Kleines Mädchen") {
    const g = ad.girl;
    if (g?.done) {
      if (!g.peeked) return { key: "girlHidden", html: waitCard("🙈", t("girlHidden")) };
      if (g.caught) return { key: "girlCaught", html: waitCard("😱", t("girlCaught"), t("girlCaughtHint")) };
      return { key: "girlFound", html: waitCard("👀", t("girlFoundTitle"), `🐺 <strong>${(g.wolves || []).map(escapeHtml).join(", ") || t("nobody")}</strong>`) };
    }
    return {
      key: "girl", turn: true,
      html: `<div class="glass-card stage center"><div class="big-emoji">👧</div><h2>${t("girlTitle")}</h2><p class="muted">${t("girlHint")}</p>
        <div class="action-bar"><button class="glass-button ghost" id="peekNo">${t("girlNo")}</button><button class="glass-button btn-warning" id="peekYes">${t("girlYes")}</button></div></div>`,
      bind: () => {
        onAction("peekYes", async () => {
          if (d.seq !== currentLobby?.seq) return;
          const caught = Math.random() < 0.5;
          const wolves = caught ? [] : alive.filter(p => p.role === "Werwolf").map(p => p.name);
          await act({ "actionData.girl": { done: true, peeked: true, caught, id: me.id, wolves } });
        });
        onAction("peekNo", () => d.seq === currentLobby?.seq && act({ "actionData.girl": { done: true, peeked: false, caught: false, id: me.id, wolves: [] } }));
      }
    };
  }

  if (step === "SEER" && me.role === "Seherin") {
    const history = (ad.seerLog || []).map(e => {
      const p = byId(d, e.id);
      return `<div class="vision">${avatar(p)}<span>${escapeHtml(p?.name || "?")}</span><strong>${getRoleIcon(e.role)} ${roleName(e.role)}</strong><span class="tiny muted">${t("roundN", { n: e.r })}</span></div>`;
    }).join("");
    if (ad.seerTarget) {
      const p = byId(d, ad.seerTarget);
      return { key: "seerDone", html: `<div class="glass-card stage center"><div class="big-emoji">🔮</div><h2>${escapeHtml(p?.name || "?")}</h2>
        <p class="seer-result">${getRoleIcon(p?.role)} ${roleName(p?.role)}</p>${history ? `<div class="visions">${history}</div>` : ""}</div>` };
    }
    const targets = alive.filter(p => p.id !== me.id);
    return {
      key: "seer", turn: true,
      html: `<div class="glass-card stage"><h2>${t("seerTitle")}</h2>
        <div class="pick-grid" id="seerTargets">${targets.map(p => pickCard(p)).join("")}</div>
        <div class="action-bar"><button class="glass-button block" id="seerSubmit" disabled>${t("seerConfirm")}</button></div>
        ${history ? `<div class="panel-title" style="margin-top:1rem;">${t("yourVisions")}</div><div class="visions">${history}</div>` : ""}</div>`,
      bind: () => {
        const get = bindPicker("seerTargets", { onChange: (s) => { const b = $("seerSubmit"); if (b) b.disabled = !s; } });
        onAction("seerSubmit", async () => {
          const s = get();
          const p = byId(d, s);
          if (!p || d.seq !== currentLobby?.seq) return;
          await act({ "actionData.seerTarget": s, "actionData.seerLog": arrayUnion({ r: d.round || 1, id: s, role: p.role }) });
        });
      }
    };
  }

  if (step === "WITCH" && me.role === "Hexe") {
    const w = ad.witch || {};
    if (ad.witchDone) return { key: "witchDone", html: waitCard("🧪", t("witchDoneView")) };
    const victim = byId(d, ad.nightVictim);
    const canHeal = !w.usedHeal && victim && victim.isAlive;
    const canPoison = !w.usedPoison;
    const healKey = `${seq}|witchHeal`;
    const healOn = !!uiSel.get(healKey);
    return {
      key: "witch", turn: true,
      html: `<div class="glass-card stage"><h2>${t("witchTitle")}</h2>
        <div class="news ${victim ? "bad" : "good"}">🐺 ${t("witchVictim")} <strong>${victim ? escapeHtml(victim.name) : t("nobody")}</strong></div>
        ${canHeal ? `<button class="toggle-row ${healOn ? "on" : ""}" id="healToggle" aria-pressed="${healOn}"><span>💚 ${t("witchHeal", { name: escapeHtml(victim.name) })}</span><span class="toggle-dot"></span></button>` : `<p class="small muted">💚 ${w.usedHeal ? t("potionUsed") : t("witchNoVictim")}</p>`}
        ${canPoison ? `<div class="panel-title" style="margin-top:1rem;">☠️ ${t("witchPoison")} <span class="tiny muted">(${t("optional")})</span></div>
          <div class="pick-grid compact" id="poisonTargets">${alive.filter(p => p.id !== me.id).map(p => pickCard(p)).join("")}</div>` : `<p class="small muted">☠️ ${t("potionUsed")}</p>`}
        <div class="action-bar"><button class="glass-button block" id="witchDoneBtn">${t("witchFinish")}</button></div></div>`,
      bind: () => {
        // Tapping the selected poison target again clears it (poison is optional).
        const getPoison = canPoison ? bindPicker("poisonTargets", { allowNone: true }) : () => null;
        $("healToggle")?.addEventListener("click", () => { uiSel.set(healKey, !uiSel.get(healKey)); const on = !!uiSel.get(healKey); $("healToggle").classList.toggle("on", on); $("healToggle").setAttribute("aria-pressed", on); buzz(8); });
        onAction("witchDoneBtn", async () => {
          if (d.seq !== currentLobby?.seq) return;
          const heal = canHeal && uiSel.get(healKey) ? victim.id : null;
          const poison = canPoison ? (getPoison() || null) : null;
          const ok = await act({ "actionData.witch.healTarget": heal, "actionData.witch.poisonTarget": poison, "actionData.witchDone": true });
          if (ok && (heal || poison)) showToast(heal && poison ? t("witchBoth") : heal ? t("healed", { name: victim.name }) : t("poisoned", { name: byId(d, poison)?.name || "?" }), "success");
        });
      }
    };
  }

  return sleeping();
}

function votingBody(d, me, alive) {
  const votes = d.votes || {};
  const tally = voteTally(d);
  const myVote = votes[me.id] || null;
  const voted = alive.filter(p => votes[p.id]).length;
  const targets = alive.filter(p => p.id !== me.id);
  return {
    key: "vote", turn: !myVote,
    html: `<div class="glass-card stage"><h2>${t("voteTitle")}</h2>
      <p class="small muted">${t("voteCount", { n: voted, t: alive.length })}</p>
      <div class="pick-grid" id="voteGrid">${targets.map(p => {
        const n = tally[p.id] || 0;
        const voters = alive.filter(v => votes[v.id] === p.id).map(v => escapeHtml(v.name));
        return pickCard(p, { badge: n ? String(n) : "", sub: voters.join(", ") });
      }).join("")}</div>
      <div class="action-bar"><button class="glass-button block" id="castVote" disabled>${myVote ? t("changeVote") : t("voteBtn")}</button></div>
      ${myVote ? `<p class="small center muted">✅ ${t("youVotedFor", { name: escapeHtml(byId(d, myVote)?.name || "?") })}</p>` : ""}</div>`,
    bind: () => {
      const get = bindPicker("voteGrid", { initial: myVote, onChange: (s) => { const b = $("castVote"); if (b) b.disabled = !s || s === (currentLobby?.votes || {})[me.id]; } });
      onAction("castVote", async () => { const s = get(); if (s && currentLobby?.phase === "VOTING") { if (await act({ [`votes.${me.id}`]: s })) { buzz(15); showToast(t("voteCast"), "success", 1800); } } });
    }
  };
}

function dayBody(d, me, alive) {
  const isHost = d.hostId === currentUser.id;
  const ready = alive.filter(p => d.readyVotes?.[p.id]).length;
  const meReady = !!d.readyVotes?.[me.id];
  const need = Math.floor(alive.length / 2) + 1;
  const online = d.mode === "online";
  return {
    key: "day",
    html: `<div class="glass-card stage"><h2>${t("dayTitle")}</h2>
      <p class="muted">${t("discuss")}</p>
      ${online ? `<p class="small muted" style="margin-top:.5rem;">${t("readyInfo", { n: ready, t: need })}</p>
        <div class="action-bar">
          ${isHost ? `<button class="glass-button ghost" id="startVoteNow">${t("startVoteNow")}</button>` : ""}
          <button class="glass-button ${meReady ? "btn-success" : ""}" id="readyBtn">${meReady ? "✅ " + t("readyDone") : "🗳️ " + t("readyToVote")}</button>
        </div>` : `<p class="small muted" style="margin-top:.5rem;">${t("narratorWillVote")}</p>`}
    </div>`,
    bind: () => {
      onAction("readyBtn", () => act({ [`readyVotes.${me.id}`]: !meReady }));
      onAction("startVoteNow", () => transition(d.seq || 0, buildStartVoting));
    }
  };
}

// ---------- narrator (local mode) ----------
function renderNarratorDashboard(d) {
  const ad = d.actionData || {};
  const step = d.phase === "NIGHT" ? d.nightActionsOrder?.[d.currentNightIndex || 0] : d.phase;
  const roleForStep = { AMOR: "Amor", "BESCHÜTZER": "Beschützer", SMALL_GIRL: "Kleines Mädchen", SEER: "Seherin", WITCH: "Hexe" }[step];
  let status = "";
  if (d.phase === "NIGHT") {
    if (roleForStep && !hasRoleAlive(d, roleForStep)) status = `💀 ${t("roleDeadSkip", { role: roleName(roleForStep) })}`;
    else status = stepDone(d, 0) ? `✅ ${t("stepDone")}` : `⏳ ${t("stepWaiting")}`;
  } else if (d.phase === "VOTING" || d.phase === "DAY") status = stepDone(d, 0) ? `✅ ${t("stepDone")}` : "";

  const list = (obj) => {
    const entries = Object.entries(obj || {}).filter(([pid]) => byId(d, pid));
    return entries.length ? entries.map(([pid, tid]) => `<div class="vote-detail-item"><span>${escapeHtml(byId(d, pid)?.name)}</span><span>→ ${escapeHtml(byId(d, tid)?.name || "?")}</span></div>`).join("") : `<div class="muted small">${t("waitingVotes")}</div>`;
  };
  let detail = "";
  if (d.phase === "NIGHT" && step === "WEREWOLF") detail = `<div class="vote-detail-list"><strong>${t("wolfVotes")}</strong>${list(ad.werewolfVotes)}</div>`;
  if (d.phase === "VOTING") detail = `<div class="vote-detail-list"><strong>${t("votingLabel")}</strong>${list(d.votes)}</div>`;
  if (d.phase === "NIGHT" && step === "WITCH") detail = `<div class="vote-detail-list small">🐺 ${t("witchVictim")} <strong>${escapeHtml(byId(d, ad.nightVictim)?.name || t("nobody"))}</strong></div>`;

  let hunterHtml = "";
  if (d.phase === "HUNTER") {
    const hunter = byId(d, ad.pendingHunterId);
    hunterHtml = `<div class="vote-detail-list"><strong>${t("narratorHunter", { name: escapeHtml(hunter?.name || roleName("Jäger")) })}</strong>
      <div class="pick-grid compact" id="narratorHunterTargets">${alivePlayers(d).filter(p => p.id !== hunter?.id).map(p => pickCard(p)).join("")}</div>
      <div class="action-bar"><button class="glass-button ghost" id="narratorHunterSkip">${t("narratorHunterSkip")}</button><button class="glass-button btn-danger" id="narratorHunterShoot" disabled>${t("hunterTake")}</button></div></div>`;
  }

  render(`<div class="game">
    ${gameHeader(d, null)}
    <div class="game-grid"><div class="game-main">
    <div class="glass-card stage">
      <h2>🎙️ ${t("narratorConsole")} <span class="tiny muted">${d.code}</span></h2>
      <div class="narrator-script"><strong>${t("script")}</strong><br>${stepScript(d)}</div>
      ${status ? `<p class="small">${status}</p>` : ""}
      ${detail}${hunterHtml}
      ${d.phase !== "HUNTER" ? `<div class="action-bar"><button class="glass-button block" id="narratorNext">${t("phaseNext")} ⏭️</button></div>` : ""}
    </div>
    ${newsHtml(d)}</div>
    <aside class="game-side">${playersPanel(d, null, { showRoles: true })}${gameFooter(d)}</aside>
    </div>
  </div>`, `${d.gameId}:${d.seq}:narr`);
  bindGameChrome(d, null);
  onAction("narratorNext", () => advance(d));
  if (d.phase === "HUNTER") {
    const get = bindPicker("narratorHunterTargets", { onChange: (s) => { const b = $("narratorHunterShoot"); if (b) b.disabled = !s; } });
    onAction("narratorHunterShoot", () => transition(d.seq || 0, (f) => buildHunterShot(f, get())));
    onAction("narratorHunterSkip", () => transition(d.seq || 0, (f) => buildHunterShot(f, null)));
  }
}

// ---------- win screen ----------
function renderWinScreen(d, me) {
  const w = d.winner || "DRAW";
  const key = `${d.gameId}:end`;
  const first = screenKey !== key;
  const emoji = { VILLAGE: "🏘️", WEREWOLF: "🐺", LOVERS: "💘", DRAW: "🤝" }[w] || "🐺";
  const title = { VILLAGE: t("villageWins"), WEREWOLF: t("werewolfWins"), LOVERS: t("loversWin"), DRAW: t("drawTitle") }[w];
  const desc = { VILLAGE: t("villageWinsDesc"), WEREWOLF: t("werewolfWinsDesc"), LOVERS: t("loversWinDesc"), DRAW: t("drawDesc") }[w];
  const lovers = d.actionData?.lovers || [];
  const isWinner = (p) => w === "VILLAGE" ? p.role !== "Werwolf" : w === "WEREWOLF" ? p.role === "Werwolf" : w === "LOVERS" ? lovers.includes(p.id) : false;
  const iWon = me.role !== NARRATOR && isWinner(me);
  const isHost = d.hostId === currentUser.id;
  render(`<div class="glass-card narrow center win-card">
    <div class="big-emoji win-emoji">${emoji}</div>
    <h1>${title}</h1><p class="muted">${desc}</p>
    ${me.role !== NARRATOR && w !== "DRAW" ? `<div class="win-badge ${iWon ? "won" : "lost"}">${iWon ? "🏆 " + t("youWon") : "💀 " + t("youLost")}</div>` : ""}
    ${newsHtml(d)}
    <div class="panel-title" style="margin-top:1rem;">${t("finalStand")}</div>
    <div class="mini-list">${d.players.filter(p => p.role && p.role !== NARRATOR).map(p => `
      <div class="mini ${p.isAlive ? "" : "dead"} ${isWinner(p) ? "winner" : ""}">${avatar(p, "sm")}<span class="mini-name">${escapeHtml(p.name)}${lovers.includes(p.id) ? " 💘" : ""}</span>
      <span class="mini-role">${getRoleIcon(p.role)} ${roleName(p.role)}</span><span>${p.isAlive ? "✅" : "💀"}</span></div>`).join("")}</div>
    <div class="action-bar">
      <button class="glass-button ghost" id="leaveLobbyBtn">${t("leave")}</button>
      ${isHost ? `<button class="glass-button" id="playAgain">🔁 ${t("playAgain")}</button>` : `<span class="small muted">${t("waitHostAgain")}</span>`}
    </div></div>`, key);
  if (first && w !== "DRAW") { spawnConfetti(); buzz([50, 80, 50]); }
  $("leaveLobbyBtn")?.addEventListener("click", leaveLobby);
  onAction("playAgain", () => transition(d.seq || 0, (f) => f.phase === "ENDED" ? buildRestart(f) : null));
}

// ---------- lobby ----------
function shareLink(code) { return `${location.origin}${location.pathname}?join=${code}`; }
async function shareLobby(code) {
  const url = shareLink(code);
  try {
    if (navigator.share) { await navigator.share({ title: "Werwolf Mobile", text: t("shareText", { code }), url }); return; }
  } catch (e) { if (e?.name === "AbortError") return; }
  try { await navigator.clipboard.writeText(url); showToast(t("linkCopied"), "success"); }
  catch { showToast(url, "info", 6000); }
}

function rolePreview(n, settings) {
  if (n < 1) return "";
  const pool = buildRolePool(Math.max(n, MIN_PLAYERS), settings, () => 0.5);
  const wolves = wolfCountFor(Math.max(n, MIN_PLAYERS), settings?.wolves);
  const specials = pool.filter(r => r !== "Werwolf" && r !== "Dorfbewohner").length;
  const villagers = pool.length - wolves - specials;
  return t("rolePreview", { w: wolves, s: specials, v: villagers });
}

function renderLobbyView(d, me) {
  currentRender = () => { lastFp = null; tick(); };
  const isHost = d.hostId === currentUser.id;
  const local = d.mode === "lokal";
  const narrId = local ? d.confirmedNarratorId : null;
  const activeN = d.players.length - (narrId ? 1 : 0);
  const canStart = activeN >= MIN_PLAYERS && (!local || !!narrId);
  const s = d.settings || defaultSettings();

  const playersHtml = d.players.map(p => `
    <div class="lobby-player ${isPlayerOnline(p.id) ? "" : "is-offline"} ${seenLobbyPlayers.size && !seenLobbyPlayers.has(p.id) ? "pop" : ""}">
      ${avatar(p)}<span class="lp-name">${escapeHtml(p.name)}${isMe(p.id) ? ` <span class="tiny muted">(${t("you")})</span>` : ""}</span>
      <span class="lp-marks">${p.id === d.hostId ? "👑" : ""}${p.id === narrId ? "🎙️" : ""}${!isPlayerOnline(p.id) ? `<span class="offline-dot" title="${t("offline")}"></span>` : ""}</span>
      ${isHost && !isMe(p.id) ? `<button class="icon-btn kick-btn" data-player-id="${escapeHtml(p.id)}" aria-label="${t("kick")}"><span class="ico" aria-hidden="true">✕</span></button>` : ""}
    </div>`).join("");

  const popped = d.players.some(p => seenLobbyPlayers.size && !seenLobbyPlayers.has(p.id));
  d.players.forEach(p => seenLobbyPlayers.add(p.id));
  if (popped) buzz(10);

  let narratorHtml = "";
  if (local) {
    if (narrId) narratorHtml = `<p class="small">🎙️ ${t("narratorIs")} <strong>${escapeHtml(byId(d, narrId)?.name || "?")}</strong></p>`;
    else {
      const vol = byId(d, d.volunteerNarratorId);
      narratorHtml = `<div class="row-wrap">
        ${d.volunteerNarratorId === me.id ? `<span class="small" style="color:var(--success)">${t("volunteered")}</span>` : `<button class="glass-button ghost small" id="volunteerBtn">${t("volunteerNarrator")}</button>`}
        ${isHost && vol ? `<button class="glass-button small" id="confirmNarratorBtn">${t("confirm")}: ${escapeHtml(vol.name)} 🎙️</button>` : ""}
        ${isHost && !vol ? `<span class="small muted">${t("noVolunteer")}</span>` : ""}
      </div>`;
    }
  }

  const roleChips = ["Werwolf", "Dorfbewohner", ...OPTIONAL_ROLES].map(r => {
    const locked = r === "Werwolf" || r === "Dorfbewohner";
    const on = locked || roleEnabled(s, r);
    return `<button class="chip-toggle ${on ? "on" : ""} ${locked ? "locked" : ""}" data-role="${r}" ${!isHost || locked ? "disabled" : ""} aria-pressed="${on}">${getRoleIcon(r)} ${roleName(r)}</button>`;
  }).join("");

  const seg = (name, options, value, label) => `<div class="setting-row"><span>${label}</span><div class="segmented" data-setting="${name}">${options.map(([v, l]) => `<button class="${String(value) === String(v) ? "on" : ""}" data-value="${v}" ${isHost ? "" : "disabled"}>${l}</button>`).join("")}</div></div>`;

  const settingsHtml = `<div class="panel">
    <div class="panel-title">⚙️ ${t("settings")} ${isHost ? "" : `<span class="tiny muted">(${t("hostOnly")})</span>`}</div>
    <div class="chip-grid" id="roleToggles">${roleChips}</div>
    <p class="small muted" style="margin:.4rem 0 .8rem;">${rolePreview(activeN, s)}</p>
    ${seg("wolves", [["auto", t("auto")], [1, "1"], [2, "2"], [3, "3"], [4, "4"]], s.wolves ?? "auto", "🐺 " + t("wolvesSetting"))}
    ${!local ? seg("dayTime", DAY_TIMES.map(x => [x, x < 120 ? `${x}s` : `${x / 60}m`]), s.dayTime ?? 120, "☀️ " + t("dayTimeSetting")) : ""}
    ${seg("revealRoles", [[true, t("yes")], [false, t("no")]], s.revealRoles !== false, "🎭 " + t("revealRolesSetting"))}
  </div>`;

  let hint = "";
  if (activeN < MIN_PLAYERS) hint = t("needPlayers", { n: MIN_PLAYERS - activeN });
  else if (local && !narrId) hint = t("needNarrator");

  render(`<div class="lobby">
    <div class="lobby-grid">
    <div class="glass-card stage">
      <div class="lobby-top">
        <div>
          <div class="tiny muted">${t("lobbyCode")} · ${d.isPublic ? "🌍 " + t("public") : "🔒 " + t("private")} · ${local ? "🏠 " + t("local") : "🌐 " + t("online")}</div>
          <button class="code-big" id="copyCode" aria-label="${t("copyCode")}">${d.code}</button>
        </div>
        <button class="glass-button small" id="shareBtn"><span class="ico" aria-hidden="true">📤</span> ${t("invite")}</button>
      </div>
      <div class="panel-title">👥 ${t("players")} <span class="muted">${d.players.length}/${MAX_PLAYERS}</span></div>
      <div class="lobby-players">${playersHtml}</div>
      ${local ? narratorHtml : `<p class="small muted">${t("autoNarrator")}</p>`}
    </div>
    ${settingsHtml}
    </div>
    <div class="lobby-actions">
      <button class="glass-button ghost" id="leaveLobbyBtn">${t("leave")}</button>
      ${isHost ? `<button class="glass-button grow" id="startGameBtn" ${canStart ? "" : "disabled"}>${t("startGame")}</button>` : `<span class="grow small muted center">${t("waitingForHost")}</span>`}
    </div>
    ${isHost && hint ? `<p class="small muted center dock-note" style="margin-top:.4rem;">${hint}</p>` : ""}
  </div>`, `lobby:${d.id}`);

  $("leaveLobbyBtn")?.addEventListener("click", leaveLobby);
  $("shareBtn")?.addEventListener("click", () => shareLobby(d.code));
  $("copyCode")?.addEventListener("click", async () => { try { await navigator.clipboard.writeText(d.code); showToast(t("codeCopied"), "success", 1600); } catch {} });
  document.querySelectorAll(".kick-btn").forEach(btn => btn.addEventListener("click", () => {
    const p = byId(d, btn.dataset.playerId);
    showConfirmModal(t("kickConfirm", { name: escapeHtml(p?.name || "?") }), () => kickPlayer(btn.dataset.playerId), { yes: t("kick") });
  }));
  onAction("volunteerBtn", () => act({ volunteerNarratorId: currentUser.id }));
  onAction("confirmNarratorBtn", () => act({ confirmedNarratorId: d.volunteerNarratorId }));
  if (isHost) {
    const saveSettings = (patch) => act({ settings: { ...defaultSettings(), ...s, ...patch } });
    document.querySelectorAll("#roleToggles .chip-toggle:not(.locked)").forEach(c => c.addEventListener("click", () => {
      buzz(8);
      saveSettings({ roles: { ...defaultSettings().roles, ...(s.roles || {}), [c.dataset.role]: !roleEnabled(s, c.dataset.role) } });
    }));
    document.querySelectorAll("#roleToggles .chip-toggle.locked").forEach(c => c.addEventListener("click", () => showToast(t("lockedRoleToast", { role: roleName(c.dataset.role) }), "warning")));
    document.querySelectorAll(".segmented").forEach(sg => sg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      let v = b.dataset.value;
      if (sg.dataset.setting === "dayTime") v = Number(v);
      if (sg.dataset.setting === "revealRoles") v = v === "true";
      buzz(8);
      saveSettings({ [sg.dataset.setting]: v });
    }));
    onAction("startGameBtn", async () => {
      const ok = await transition(d.seq || 0, (f) => f.hostId === currentUser.id ? buildStartGame(f, uuid()) : null);
      if (!ok) showToast(t("startFailed"), "error");
    });
  }
}

// ========== MAIN MENU ==========
function flashNameInput() {
  const input = $("playerName");
  if (!input) return;
  input.classList.add("error-flash");
  input.placeholder = t("nameRequired");
  input.focus();
  buzz(30);
  setTimeout(() => input.classList.remove("error-flash"), 800);
}
function requireName() {
  const name = ($("playerName")?.value || "").trim().slice(0, 20);
  if (!name) { flashNameInput(); return null; }
  currentUser.name = name;
  storageSet(NAME_KEY, name);
  return name;
}

let pendingJoinCode = null;
function renderMainMenu() {
  currentRender = renderMainMenu;
  setPhaseTheme(null);
  render(`
    <div class="glass-card narrow menu">
      <div class="menu-col">
      <div class="brand"><img src="icon-192.png" alt="" class="brand-icon"><div><h1>WERWOLF</h1><div class="tiny muted">${t("tagline")}</div></div></div>
      <label class="field-label" for="playerName">${t("yourName")}</label>
      <input type="text" id="playerName" placeholder="${t("namePlaceholder")}" value="${escapeHtml(currentUser.name || "")}" maxlength="20" autocomplete="nickname" enterkeyhint="done">
      </div>
      <div class="menu-col">
      ${pendingJoinCode ? `<button class="glass-button block big" id="joinPending">🔑 ${t("joinCode", { code: pendingJoinCode })}</button>` : ""}
      <button class="glass-button block big ${pendingJoinCode ? "ghost" : ""}" id="quickGameBtn">${t("quickStart")}</button>
      <p class="tiny muted center" style="margin:.4rem 0 1rem;">${t("quickHint")}</p>
      <div class="icon-grid">
        <button class="icon-button" id="joinLobbyIcon"><span class="ib-icon">🔑</span><span>${t("join")}</span></button>
        <button class="icon-button" id="createPrivateLobby"><span class="ib-icon">🔒</span><span>${t("privateLobby")}</span></button>
        <button class="icon-button" id="createPublicLobby"><span class="ib-icon">🌍</span><span>${t("publicLobby")}</span></button>
      </div>
      <div class="menu-footer">
        <a href="https://paypal.me/Emre100120" target="_blank" rel="noopener" class="link-btn"><span class="ico" aria-hidden="true">💝</span> ${t("donate")}</a>
        <a href="#" class="link-btn" id="menuImprint">${t("imprint")}</a>
        <a href="#" class="link-btn" id="menuPrivacy">${t("privacy")}</a>
      </div>
      </div>
    </div>`, "menu");
  $("playerName")?.addEventListener("input", (e) => { currentUser.name = e.target.value.trim(); storageSet(NAME_KEY, currentUser.name); });
  $("playerName")?.addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
  onAction("quickGameBtn", startQuickGame);
  onAction("joinPending", async () => {
    const name = requireName(); if (!name) return;
    try { await joinLobby(pendingJoinCode, name); pendingJoinCode = null; } catch (e) { showToast(e.message, "error"); }
  });
  $("createPublicLobby")?.addEventListener("click", () => showCreateLobbyModal("public"));
  $("createPrivateLobby")?.addEventListener("click", () => showCreateLobbyModal("private"));
  $("joinLobbyIcon")?.addEventListener("click", showJoinLobbyModal);
  $("menuImprint")?.addEventListener("click", (e) => { e.preventDefault(); showImpressum(); });
  $("menuPrivacy")?.addEventListener("click", (e) => { e.preventDefault(); showDatenschutz(); });
}

async function startQuickGame() {
  const name = requireName(); if (!name) return;
  try { await createLobby(name, false, "online", defaultSettings(QUICK_ROLES)); showToast(t("quickCreated"), "success"); }
  catch (e) { showToast(e.message, "error"); }
}

function showCreateLobbyModal(type) {
  const name = requireName(); if (!name) return;
  const isPublic = type === "public";
  let mode = "online";
  const settings = defaultSettings();
  const m = showModal(`
    <h3>${isPublic ? t("createPublicTitle") : t("createPrivateTitle")}</h3>
    ${isPublic ? `<p class="small muted">${t("publicHint")}</p>` : `
      <div class="segmented wide" id="modeSeg"><button class="on" data-mode="online">🌐 ${t("modeOnline")}</button><button data-mode="lokal">🏠 ${t("modeLocal")}</button></div>
      <p class="small muted" id="modeHint" style="margin:.5rem 0;">${t("onlineModeAuto")}</p>`}
    <div class="panel-title" style="margin-top:.8rem;">${t("selectRoles")}</div>
    <div class="chip-grid" id="roleSettingsModal">${["Werwolf", "Dorfbewohner", ...OPTIONAL_ROLES].map(r => {
      const locked = r === "Werwolf" || r === "Dorfbewohner";
      return `<button class="chip-toggle on ${locked ? "locked" : ""}" data-role="${r}">${getRoleIcon(r)} ${roleName(r)}</button>`;
    }).join("")}</div>
    <p class="tiny muted">${t("rolesChangeLater")}</p>
    <button class="glass-button block big" id="confirmCreate" style="margin-top:1rem;">${t("create")}</button>`, { closeLabel: null });
  m.querySelectorAll("#roleSettingsModal .chip-toggle").forEach(c => c.addEventListener("click", () => {
    if (c.classList.contains("locked")) { showToast(t("lockedRoleToast", { role: roleName(c.dataset.role) }), "warning"); return; }
    c.classList.toggle("on"); buzz(8);
  }));
  m.querySelector("#modeSeg")?.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    mode = b.dataset.mode;
    m.querySelectorAll("#modeSeg button").forEach(x => x.classList.toggle("on", x === b));
    m.querySelector("#modeHint").textContent = mode === "online" ? t("onlineModeAuto") : t("localModeNarrator");
  });
  const btn = m.querySelector("#confirmCreate");
  btn.addEventListener("click", async () => {
    if (btn.dataset.busy) return;
    btn.dataset.busy = "1"; btn.classList.add("busy");
    m.querySelectorAll("#roleSettingsModal .chip-toggle:not(.locked)").forEach(c => { settings.roles[c.dataset.role] = c.classList.contains("on"); });
    try { await createLobby(currentUser.name, isPublic, isPublic ? "online" : mode, settings); m.close(); }
    catch (e) { showToast(e.message, "error"); }
    finally { delete btn.dataset.busy; btn.classList.remove("busy"); }
  });
}

async function showJoinLobbyModal() {
  const name = requireName(); if (!name) return;
  const m = showModal(`
    <h3><span class="ico" aria-hidden="true">🔑</span> ${t("enterCode")}</h3>
    <input type="text" id="codeInput" class="code-input" maxlength="6" placeholder="ABC123" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" value="${escapeHtml(pendingJoinCode || "")}">
    <button class="glass-button block big" id="confirmJoin">${t("join")}</button>
    <div class="panel-title" style="margin-top:1.4rem;display:flex;justify-content:space-between;align-items:center;">
      <span><span class="ico" aria-hidden="true">🌍</span> ${t("joinPublicTitle")}</span>
      <button class="icon-btn" id="refreshLobbies" aria-label="${t("refresh")}"><span class="ico" aria-hidden="true">🔄</span></button>
    </div>
    <div id="joinModalLobbyList"><div class="loader"></div></div>`, { closeLabel: null });
  const input = m.querySelector("#codeInput");
  input.addEventListener("input", () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6); });
  const doJoin = async (code) => {
    try { await joinLobby(code, currentUser.name); pendingJoinCode = null; m.close(); }
    catch (e) { showToast(e.message, "error"); }
  };
  const btn = m.querySelector("#confirmJoin");
  const submit = async () => {
    if (btn.dataset.busy) return;
    if (input.value.length !== 6) { input.classList.add("error-flash"); setTimeout(() => input.classList.remove("error-flash"), 800); return; }
    btn.dataset.busy = "1"; btn.classList.add("busy");
    await doJoin(input.value);
    delete btn.dataset.busy; btn.classList.remove("busy");
  };
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  if (finePointer.matches) setTimeout(() => input.focus(), 120);

  const load = async () => {
    const listDiv = m.querySelector("#joinModalLobbyList");
    if (!listDiv) return;
    listDiv.innerHTML = `<div class="loader"></div>`;
    try {
      const snap = await getDocs(query(collection(db, "lobbies"), where("gameStarted", "==", false), where("isPublic", "==", true)));
      const now = Date.now();
      const lobbies = snap.docs.map(x => ({ code: x.id, ...x.data() }));
      // Only abandoned lobbies (no heartbeat for an hour) are cleaned up — never live ones.
      lobbies.filter(l => now - (l.lastUpdate || 0) > LOBBY_EXPIRE_MS).forEach(l => deleteDoc(doc(db, "lobbies", l.code)).catch(() => {}));
      const active = lobbies.filter(l => now - (l.lastUpdate || 0) < PUBLIC_FRESH_MS && (l.players || []).length < MAX_PLAYERS)
        .sort((a, b) => (b.players?.length || 0) - (a.players?.length || 0));
      listDiv.innerHTML = active.length ? active.map(l => `
        <button class="public-lobby-item" data-join-code="${escapeHtml(l.code)}">
          <span class="public-lobby-code">${escapeHtml(l.code)}</span>
          <span class="public-lobby-players"><span class="ico" aria-hidden="true">👥</span> ${(l.players || []).length}</span>
          <span class="public-lobby-host">${escapeHtml((l.players || []).find(p => p.id === l.hostId)?.name || "")}</span>
          <span class="ico" aria-hidden="true">›</span>
        </button>`).join("") : `<p class="small muted center" style="padding:1rem 0;">${t("noLobbies")}</p>`;
      listDiv.querySelectorAll("[data-join-code]").forEach(b => b.addEventListener("click", () => doJoin(b.dataset.joinCode)));
    } catch (e) { listDiv.innerHTML = `<p class="small muted">${t("loadError")}</p>`; }
  };
  m.querySelector("#refreshLobbies")?.addEventListener("click", load);
  if (firebaseReady) load(); else m.querySelector("#joinModalLobbyList").innerHTML = `<p class="small muted">${t("loadError")}</p>`;
}

// Material-style press ripple for buttons and chips (compositor-only, removed when finished).
function initRipples() {
  if (reduceMotion()) return;
  const SEL = ".glass-button, .icon-button, .chip-toggle, .public-lobby-item, .toggle-row, .role-chip, .top-btn:not(.theme-toggle), .segmented button";
  document.addEventListener("pointerdown", (e) => {
    const el = e.target.closest?.(SEL);
    if (!el || el.disabled) return;
    const r = el.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2.2;
    const s = document.createElement("span");
    s.className = "ripple";
    s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    el.appendChild(s);
    s.addEventListener("animationend", () => s.remove());
  }, { passive: true });
}

// ========== INIT ==========
document.addEventListener("DOMContentLoaded", () => {
  initLang();
  applyStaticI18n();
  onLangChange(() => {
    applyStaticI18n();
    updateChatUI();
    refreshSettings();
    currentRender?.();
  });
  initTheme();
  initParticles();
  initKeyboardOffset();

  // Pick up an invite link (?join=CODE) and clean the URL so a reload doesn't re-trigger it.
  try {
    const params = new URLSearchParams(location.search);
    const code = (params.get("join") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length === 6) pendingJoinCode = code;
    if (params.has("join")) history.replaceState(null, "", location.pathname);
  } catch {}
  // Root = main menu. Back there leaves the app (system behaviour, keeps Android's predictive back).
  Back?.init({ root: "menu" });
  Back?.onRoute(({ direction }) => { if (direction === "back" && currentLobbyId) onLobbyBack(); });

  $("theme-toggle")?.addEventListener("click", toggleTheme);
  initRipples();
  $("accept-consent")?.addEventListener("click", acceptConsent);
  $("reject-consent")?.addEventListener("click", rejectConsent);
  $("show-impressum")?.addEventListener("click", (e) => { e.preventDefault(); showImpressum(); });
  $("show-datenschutz")?.addEventListener("click", (e) => { e.preventDefault(); showDatenschutz(); });
  $("close-legal-modal")?.addEventListener("click", closeLegal);
  $("settings-btn")?.addEventListener("click", showSettings);
  $("role-display")?.addEventListener("click", hideRoleCard);

  $("chat-top")?.addEventListener("click", () => setChatOpen(!chatOpen));
  $("chat-backdrop")?.addEventListener("click", () => setChatOpen(false));
  $("chat-close")?.addEventListener("click", () => setChatOpen(false));
  $("chat-send")?.addEventListener("click", sendChatMessage);
  $("chat-input")?.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); sendChatMessage(); } });
  // Esc is handled by BackStack (closes the top overlay through the same path as the back gesture).
  // While typing, the dock steps aside so the field stays visible above the keyboard.
  document.addEventListener("focusin", (e) => {
    if (!e.target.matches?.("input, textarea")) return;
    document.documentElement.classList.add("typing");
    // the dock just left and the keyboard is opening: keep the field in view once the layout settled
    setTimeout(() => { if (document.activeElement === e.target) e.target.scrollIntoView({ block: "nearest" }); }, 300);
  });
  // Keyboard opening/closing resizes the content area: the focused field stays visible.
  const keepFocusedVisible = () => { const a = document.activeElement; if (a?.matches?.("input, textarea") && mainEl.contains(a)) a.scrollIntoView({ block: "nearest" }); };
  if (window.ResizeObserver) new ResizeObserver(keepFocusedVisible).observe(mainEl);
  document.fonts?.addEventListener?.("loadingdone", keepFocusedVisible);
  document.addEventListener("focusout", () => document.documentElement.classList.remove("typing"));
  initUpdates();

  if (!consentGiven) showConsentModal();
  else { initApp(); setupInstallBanner(); }
});

async function initApp() {
  if (!firebaseReady) { showToast(t("firebaseError"), "error"); renderMainMenu(); return; }
  deviceId = storageGet("ww_device_id");
  if (!deviceId) { deviceId = uuid(); storageSet("ww_device_id", deviceId); }
  currentUser.id = storageGet("ww_player_id") || currentUser.id;
  storageSet("ww_player_id", currentUser.id);
  currentUser.deviceId = deviceId;
  if (currentLobbyId) return;
  // Reload / app switch / crash → put the player straight back into their running game.
  const saved = storageGet(SESSION_KEY);
  if (saved && navigator.onLine) {
    render(`<div class="glass-card narrow center"><div class="loader"></div><p class="muted">${t("reconnecting")}</p></div>`, "resume");
    try {
      const snap = await getDoc(doc(db, "lobbies", saved));
      if (snap.exists()) {
        const d = snap.data();
        const me = d.players?.find(p => p.id === currentUser.id);
        if (me && !me.left) { enterLobby(saved); return; }
        if (!d.gameStarted && !(d.kicked || []).includes(currentUser.id) && currentUser.name) { await joinLobby(saved, currentUser.name, { silent: true }); return; }
      }
    } catch (e) { console.warn("resume failed", e); }
    clearSession();
  }
  renderMainMenu();
  if (pendingJoinCode && currentUser.name) showJoinLobbyModal();
}

// ========== INSTALL BANNER (top bar, iOS + Android) ==========
const INSTALL_DISMISS_KEY = "ww_install_dismissed";
const INSTALL_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;
function isStandalone() { return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true; }
function isIos() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }
function installRecentlyDismissed() { const v = storageGet(INSTALL_DISMISS_KEY); return !!v && (Date.now() - parseInt(v, 10)) < INSTALL_DISMISS_MS; }
function showInstallBar() { $("install-bar")?.classList.add("show"); document.documentElement.classList.add("install-bar-open"); }
function hideInstallBar() { $("install-bar")?.classList.remove("show"); document.documentElement.classList.remove("install-bar-open"); }
function dismissInstallBar() { storageSet(INSTALL_DISMISS_KEY, String(Date.now())); hideInstallBar(); }
let installBarReady = false;
let iosRelease = null;
function openIosInstall() {
  $("ios-install-modal").style.display = "flex";
  iosRelease = backPush("ios-install", () => { iosRelease = null; $("ios-install-modal").style.display = "none"; });
}
function setupInstallBanner() {
  if (isStandalone() || installRecentlyDismissed()) return;
  const btn = $("install-bar-btn");
  const closeBtn = $("install-bar-close");
  if (!btn || !closeBtn) return;
  if (!installBarReady) {
    installBarReady = true;
    closeBtn.addEventListener("click", dismissInstallBar);
    btn.addEventListener("click", async () => {
      if (isIos() && !deferredPrompt) { openIosInstall(); return; }
      if (deferredPrompt) {
        deferredPrompt.prompt();
        try { await deferredPrompt.userChoice; } catch {}
        deferredPrompt = null;
        hideInstallBar();
      }
    });
    $("ios-install-close")?.addEventListener("click", () => { iosRelease?.(); iosRelease = null; $("ios-install-modal").style.display = "none"; dismissInstallBar(); });
  }
  if (isIos() || deferredPrompt) showInstallBar();
}
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e; if (consentGiven) setupInstallBanner(); });
window.addEventListener("appinstalled", () => { deferredPrompt = null; dismissInstallBar(); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js").catch(() => {});

// ========== UPDATES (PWA) ==========
// A new deploy installs a new service worker, which then waits. The popup (lib/update-dialog.js) offers it:
// "Jetzt aktualisieren" activates it and reloads (a running game resumes via the saved session),
// "Später" asks again after a day, "Überspringen" stays silent until a newer version exists.
const updateAdapter = {
  mode: "web",
  async check() {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) return null;
    await reg.update().catch(() => {});
    if (!reg.waiting) return null;
    const v = await fetch("./version.json", { cache: "no-store" }).then(r => r.json()).then(j => j.version).catch(() => "");
    // The page already runs the new code (network-first loading): let the waiting worker take over quietly.
    if (v === APP_VERSION) { reg.waiting.postMessage({ type: "SKIP_WAITING" }); return null; }
    return v ? { version: v, current: APP_VERSION, notes: "" } : null;
  },
  async install() {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg?.waiting) { location.reload(); return; }
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
      reg.waiting.postMessage({ type: "SKIP_WAITING" });
      setTimeout(resolve, 4000);
    });
    location.reload();
  }
};
function initUpdates() {
  if (!window.UpdateUI || !("serviceWorker" in navigator)) return;
  // First check a bit later than the skill default: the start is busy with Firestore and the role reveal.
  window.UpdateUI.init({ adapter: updateAdapter, currentVersion: APP_VERSION, firstDelayMs: 8000 });
}

// ========== SETTINGS SHEET ==========
// Top bar ⚙ → one sheet with appearance (theme, language), help (guide, legal, donate) and updates.
const THEMES = () => [["system", t("theme.system")], ["light", t("theme.light")], ["dark", t("theme.dark")]];
const themeIdx = (p) => Math.max(0, THEMES().findIndex(([v]) => v === p));
function settingsHtml() {
  const pref = themePref();
  const themes = THEMES(), idx = themeIdx;
  return `<h3 id="settings-title">${t("settings.title")}</h3>
    <section class="set-group" aria-labelledby="sg-look">
      <h4 class="set-group-title" id="sg-look">${t("settings.appearance")}</h4>
      <div class="set-card">
        <div class="set-row">
          <div class="set-text"><span class="set-label" id="sl-theme">${t("settings.theme")}</span><span class="set-hint">${t("settings.theme.hint")}</span></div>
          <div class="theme-seg" role="radiogroup" aria-labelledby="sl-theme" style="--seg-i:${idx(pref)}">
            ${themes.map(([v, l]) => `<button type="button" role="radio" data-theme-pref="${v}" aria-checked="${v === pref}">${l}</button>`).join("")}
          </div>
        </div>
        <div class="set-row">
          <div class="set-text"><span class="set-label" id="sl-lang">${t("settings.language")}</span><span class="set-hint">${t("settings.language.hint")}</span></div>
          <button class="lang-trigger" id="lang-trigger" type="button" aria-haspopup="dialog" aria-expanded="false" aria-labelledby="sl-lang">
            <span data-lang-current></span>
            <svg class="lang-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 8l5 5 5-5"/></svg>
          </button>
        </div>
      </div>
    </section>
    <section class="set-group" aria-labelledby="sg-help">
      <h4 class="set-group-title" id="sg-help">${t("settings.help")}</h4>
      <div class="set-card">
        <button type="button" class="set-row" id="setGuide"><span class="set-text"><span class="set-label">${t("settings.guide")}</span><span class="set-hint">${t("settings.guide.hint")}</span></span>${ICON_CHEV}</button>
        <button type="button" class="set-row" id="setImprint"><span class="set-text"><span class="set-label">${t("imprint")}</span></span>${ICON_CHEV}</button>
        <button type="button" class="set-row" id="setPrivacy"><span class="set-text"><span class="set-label">${t("privacy")}</span></span>${ICON_CHEV}</button>
        <a class="set-row" href="https://paypal.me/Emre100120" target="_blank" rel="noopener"><span class="set-text"><span class="set-label">${t("donate")}</span></span>${ICON_CHEV}</a>
      </div>
    </section>
    <section class="set-group" aria-labelledby="sg-upd">
      <h4 class="set-group-title" id="sg-upd">${t("settings.updates")}</h4>
      <div class="set-card">
        <div class="set-row">
          <div class="set-text"><span class="set-label" data-update-version></span><span class="set-hint" data-update-status role="status"></span></div>
          <button type="button" class="glass-button ghost small" data-update-check>${t("update.check")}</button>
        </div>
        <div class="set-row">
          <div class="set-text"><span class="set-label" id="sl-auto">${t("update.auto")}</span><span class="set-hint">${t("update.auto.hint")}</span></div>
          <button class="switch" type="button" role="switch" aria-checked="true" aria-labelledby="sl-auto" data-update-auto></button>
        </div>
      </div>
    </section>`;
}
function showSettings() {
  if (document.querySelector(".settings-sheet")) return;
  const m = showModal("", { closeLabel: null, className: "settings-sheet", label: t("settings.title"), onClose: () => document.removeEventListener("themepref", syncSettingsTheme) });
  document.addEventListener("themepref", syncSettingsTheme);
  fillSettings(m);
}
// Re-filled on a language change, so the open sheet switches language together with the rest of the app.
function fillSettings(m) {
  const body = m.querySelector(".sheet-scroll");
  const y = body.scrollTop;
  body.innerHTML = settingsHtml();
  body.scrollTop = y;
  const seg = m.querySelector(".theme-seg");
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-theme-pref]");
    if (b) setThemePref(b.dataset.themePref, e, b);
  });
  seg.addEventListener("keydown", (e) => {                 // radiogroup: arrow keys move the choice
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    const dir = (e.key === "ArrowRight") !== (document.documentElement.dir === "rtl") ? 1 : -1;
    const themes = THEMES();
    const next = themes[(themeIdx(themePref()) + dir + themes.length) % themes.length][0];
    const btn = seg.querySelector(`[data-theme-pref="${next}"]`);
    setThemePref(next, null, btn); btn.focus();
  });
  if (window.initLanguagePicker) window.initLanguagePicker(m.querySelector("#lang-trigger"));
  m.querySelector("#setGuide").addEventListener("click", showGuide);
  m.querySelector("#setImprint").addEventListener("click", showImpressum);
  m.querySelector("#setPrivacy").addEventListener("click", showDatenschutz);
  if (window.UpdateUI) window.UpdateUI.bindSettings(m);
  else m.querySelector(".set-group:last-of-type")?.remove();
}
function syncSettingsTheme(e) {
  const seg = document.querySelector(".settings-sheet .theme-seg");
  if (!seg) return;
  const p = e?.detail || themePref();
  seg.style.setProperty("--seg-i", String(themeIdx(p)));
  seg.querySelectorAll("button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.themePref === p)));
}
function refreshSettings() {
  const m = document.querySelector(".settings-sheet")?.closest(".modal");
  if (m) fillSettings(m);
}
