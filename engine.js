// engine.js – Werwolf Mobile | Pure game rules (no DOM, no Firebase).
// Every phase transition is a pure function `(lobbyData) => update | null`. app.js applies the
// returned update inside a Firestore transaction guarded by `seq`, so a transition can never
// run twice and any client may safely drive the game when the host is unreachable.

export const NARRATOR = "ERZÄHLER";
export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 20;

export const OPTIONAL_ROLES = ["Seherin", "Hexe", "Amor", "Jäger", "Kleines Mädchen", "Beschützer", "Prinz", "Älteste"];
export const ALL_ROLES = ["Werwolf", "Dorfbewohner", ...OPTIONAL_ROLES];

// Step durations (ms) for the automatic narrator (online mode only).
export const DUR = {
  night: 45000,
  wolf: 60000,
  vote: 60000,
  hunter: 40000,
  revealBonus: 10000 // extra time on the very first step so everyone can read their role
};
export const DAY_TIMES = [60, 120, 180, 300];

export const defaultSettings = (roles = {}) => ({
  roles: { Seherin: true, Hexe: true, Amor: true, "Jäger": true, "Kleines Mädchen": true, "Beschützer": true, Prinz: true, "Älteste": true, ...roles },
  wolves: "auto",
  dayTime: 120,
  revealRoles: true
});
export const QUICK_ROLES = { Seherin: true, Hexe: true, "Jäger": true, Amor: false, "Kleines Mädchen": false, "Beschützer": false, Prinz: false, "Älteste": false };

export function defaultActionData() {
  return {
    werewolfVotes: {}, nightVictim: null,
    seerTarget: null, seerLog: [],
    witch: { usedHeal: false, usedPoison: false, healTarget: null, poisonTarget: null }, witchDone: false,
    girl: null,
    lovers: [], amorDone: false,
    guardTarget: null, lastGuardTarget: null, guardDone: false,
    elderSurvivedIds: [], princeSurvivedIds: [],
    pendingHunterId: null, pendingHunterQueue: [], hunterReturn: null, hunterUsedIds: []
  };
}

// ---------- small helpers ----------
export const inGame = (p) => !!p && p.role !== NARRATOR && !p.left;
export const alivePlayers = (d) => (d.players || []).filter(p => p.isAlive && inGame(p));
export const byId = (d, id) => (d.players || []).find(p => p.id === id);
export const hasRoleAlive = (d, role) => alivePlayers(d).some(p => p.role === role);
export const roleEnabled = (settings, role) => settings?.roles?.[role] !== false;
const isOnlineMode = (d) => d.mode !== "lokal";
const dur = (d, ms) => (isOnlineMode(d) ? ms : 0);
export const dayMs = (d) => (DAY_TIMES.includes(Number(d.settings?.dayTime)) ? Number(d.settings.dayTime) : 120) * 1000;
export const stepMs = (step) => (step === "WEREWOLF" ? DUR.wolf : DUR.night);

export function shuffle(arr, rnd = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- setup ----------
// Wolves must always be strictly fewer than everyone else, otherwise the game is won at start.
export function wolfCountFor(n, setting) {
  const auto = n <= 5 ? 1 : n <= 9 ? 2 : n <= 13 ? 3 : 4;
  const wanted = setting && setting !== "auto" ? Number(setting) || auto : auto;
  const max = Math.max(1, Math.ceil(n / 2) - 1);
  return Math.min(Math.max(1, wanted), max);
}

export function buildRolePool(n, settings, rnd = Math.random) {
  const pool = Array(wolfCountFor(n, settings?.wolves)).fill("Werwolf");
  const enabled = OPTIONAL_ROLES.filter(r => roleEnabled(settings, r));
  // The seer is the village's key role, so she's picked first when space is short.
  const ordered = [...enabled.filter(r => r === "Seherin"), ...shuffle(enabled.filter(r => r !== "Seherin"), rnd)];
  for (const r of ordered) { if (pool.length >= n) break; pool.push(r); }
  while (pool.length < n) pool.push("Dorfbewohner");
  return pool;
}

// Steps are based on the roles dealt at game start (dead or alive) so the night's rhythm doesn't
// reveal who already died – dead roles get a short fake pause instead.
export function buildNightOrder(d, firstNight) {
  const roles = new Set((d.players || []).filter(inGame).map(p => p.role));
  const order = [];
  if (firstNight && roles.has("Amor")) order.push("AMOR");
  if (roles.has("Beschützer")) order.push("BESCHÜTZER");
  order.push("WEREWOLF");
  if (roles.has("Kleines Mädchen")) order.push("SMALL_GIRL");
  if (roles.has("Seherin")) order.push("SEER");
  if (roles.has("Hexe")) order.push("WITCH");
  return order;
}

// ---------- win condition ----------
export function checkWin(players, lovers = []) {
  const alive = (players || []).filter(p => p.isAlive && inGame(p));
  if (alive.length === 0) return "DRAW";
  if (Array.isArray(lovers) && lovers.length === 2 && alive.length === 2 && alive.every(p => lovers.includes(p.id))) {
    const roles = alive.map(p => p.role);
    if (roles.includes("Werwolf") && roles.some(r => r !== "Werwolf")) return "LOVERS";
  }
  const wolves = alive.filter(p => p.role === "Werwolf").length;
  if (wolves === 0) return "VILLAGE";
  if (wolves >= alive.length - wolves) return "WEREWOLF";
  return null;
}

// ---------- deaths ----------
const newsItem = (t, p, extra = {}) => ({ t, id: p?.id || null, name: p?.name || "?", role: p?.role || null, ...extra });

// Kill `ids` (if alive), chaining the lover. Returns new players + news + list of the dead.
function applyDeaths(players, ids, lovers, kind, extra = {}) {
  let list = [...players];
  const dead = [];
  const news = [];
  const kill = (id, t) => {
    const p = list.find(x => x.id === id);
    if (!p || !p.isAlive || !inGame(p) || dead.includes(id)) return;
    list = list.map(x => (x.id === id ? { ...x, isAlive: false } : x));
    dead.push(id);
    news.push(newsItem(t, p, t === kind ? extra : {}));
    if (Array.isArray(lovers) && lovers.includes(id)) {
      const other = lovers.find(l => l !== id);
      if (other) kill(other, "lover");
    }
  };
  ids.forEach(id => kill(id, kind));
  return { players: list, dead, news };
}

function pendingHunters(players, dead, used) {
  const res = [];
  for (const id of dead) {
    const p = players.find(x => x.id === id);
    if (p && p.role === "Jäger" && !used.includes(id) && !res.includes(id) &&
        players.some(x => x.isAlive && inGame(x) && x.id !== id)) res.push(id);
  }
  return res;
}

// ---------- transitions ----------
export function buildStartGame(d, gameId, rnd = Math.random) {
  if (d.gameStarted) return null;
  const narrId = d.mode === "lokal" ? d.confirmedNarratorId : null;
  if (d.mode === "lokal" && !d.players.some(p => p.id === narrId)) return null; // narrator must be present
  const pool = d.players.filter(p => p.id !== narrId);
  if (pool.length < MIN_PLAYERS) return null;
  const roles = shuffle(buildRolePool(pool.length, d.settings, rnd), rnd);
  const players = d.players.map(p => p.id === narrId
    ? { ...p, role: NARRATOR, isAlive: true, left: false }
    : { ...p, role: roles[pool.findIndex(x => x.id === p.id)], isAlive: true, left: false });
  const order = buildNightOrder({ players }, true);
  return {
    gameStarted: true, gameId, phase: "NIGHT", players,
    actionData: defaultActionData(),
    nightActionsOrder: order, currentNightIndex: 0, narratorStep: order[0],
    votes: {}, readyVotes: {}, round: 1, news: [], winner: null, firstNightDone: false,
    stepDuration: dur(d, stepMs(order[0]) + DUR.revealBonus)
  };
}

export function buildRestart(d) {
  return {
    gameStarted: false, phase: "LOBBY", narratorStep: null,
    players: d.players.filter(p => !p.left).map(p => ({ ...p, role: null, isAlive: true, left: false })),
    actionData: defaultActionData(), votes: {}, readyVotes: {}, news: [], winner: null,
    round: 0, stepDuration: 0, nightActionsOrder: [], currentNightIndex: 0
  };
}

export function pickWolfVictim(d, rnd = Math.random) {
  const votes = d.actionData?.werewolfVotes || {};
  const wolves = new Set(alivePlayers(d).filter(p => p.role === "Werwolf").map(p => p.id));
  const targets = new Set(alivePlayers(d).map(p => p.id));
  const counts = {};
  for (const [voter, target] of Object.entries(votes)) {
    if (wolves.has(voter) && targets.has(target)) counts[target] = (counts[target] || 0) + 1;
  }
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter(id => counts[id] === max);
  return top.length ? top[Math.floor(rnd() * top.length)] : null; // ties are random, not click order
}

function nightStart(d, players, news, extra = {}) {
  const order = buildNightOrder({ players }, false);
  return {
    players, news, phase: "NIGHT", currentNightIndex: 0, narratorStep: order[0], nightActionsOrder: order,
    votes: {}, readyVotes: {}, round: (d.round || 1) + 1, stepDuration: dur(d, stepMs(order[0])),
    "actionData.werewolfVotes": {}, "actionData.nightVictim": null, "actionData.seerTarget": null,
    "actionData.girl": null, "actionData.witchDone": false, "actionData.guardDone": false,
    ...extra
  };
}

function dayStart(d) {
  return {
    phase: "DAY", narratorStep: "DAY", votes: {}, readyVotes: {}, firstNightDone: true,
    stepDuration: dur(d, dayMs(d))
  };
}

export function buildNightStep(d, rnd = Math.random) {
  if (d.phase !== "NIGHT") return null;
  const order = d.nightActionsOrder || [];
  const idx = d.currentNightIndex || 0;
  const step = order[idx];
  let victim = d.actionData?.nightVictim || null;
  const upd = {};
  if (step === "WEREWOLF") { victim = pickWolfVictim(d, rnd); upd["actionData.nightVictim"] = victim; }
  if (idx + 1 < order.length) {
    const next = order[idx + 1];
    return { ...upd, currentNightIndex: idx + 1, narratorStep: next, stepDuration: dur(d, stepMs(next)) };
  }
  return buildResolveNight(d, victim);
}

export function buildResolveNight(d, victim) {
  const ad = d.actionData || {};
  const witch = ad.witch || {};
  const lovers = ad.lovers || [];
  let killed = victim && byId(d, victim)?.isAlive ? victim : null;
  if (killed && witch.healTarget === killed) killed = null;
  if (killed && ad.guardTarget === killed) killed = null;
  const elderIds = [...(ad.elderSurvivedIds || [])];
  if (killed && byId(d, killed)?.role === "Älteste" && !elderIds.includes(killed)) { elderIds.push(killed); killed = null; }

  let players = d.players;
  const news = [];
  const dead = [];
  const run = (ids, kind) => {
    const r = applyDeaths(players, ids, lovers, kind);
    players = r.players; news.push(...r.news); dead.push(...r.dead);
  };
  if (killed) run([killed], "killed");
  if (witch.poisonTarget) run([witch.poisonTarget], "killed");
  const girl = ad.girl;
  if (girl?.caught && girl.id) run([girl.id], "girlCaught");

  const common = {
    players, news,
    "actionData.nightVictim": null,
    "actionData.witch": {
      usedHeal: !!(witch.usedHeal || witch.healTarget), usedPoison: !!(witch.usedPoison || witch.poisonTarget),
      healTarget: null, poisonTarget: null
    },
    "actionData.lastGuardTarget": ad.guardTarget || null,
    "actionData.guardTarget": null,
    "actionData.elderSurvivedIds": elderIds,
    "actionData.girl": null
  };
  const hunters = pendingHunters(players, dead, ad.hunterUsedIds || []);
  if (hunters.length) {
    return {
      ...common, phase: "HUNTER", narratorStep: "HUNTER", firstNightDone: true, stepDuration: dur(d, DUR.hunter),
      "actionData.pendingHunterId": hunters[0], "actionData.pendingHunterQueue": hunters.slice(1),
      "actionData.hunterReturn": "DAY"
    };
  }
  return { ...common, ...dayStart(d) };
}

export function buildStartVoting(d) {
  if (d.phase !== "DAY") return null;
  return { phase: "VOTING", narratorStep: "VOTING", votes: {}, readyVotes: {}, stepDuration: dur(d, DUR.vote) };
}

export function voteTally(d) {
  const alive = new Set(alivePlayers(d).map(p => p.id));
  const counts = {};
  for (const [voter, target] of Object.entries(d.votes || {})) {
    if (alive.has(voter) && alive.has(target)) counts[target] = (counts[target] || 0) + 1;
  }
  return counts;
}

export function buildResolveVoting(d) {
  if (d.phase !== "VOTING") return null;
  const counts = voteTally(d);
  let maxId = null, max = 0, tie = false;
  for (const [id, c] of Object.entries(counts)) {
    if (c > max) { max = c; maxId = id; tie = false; }
    else if (c === max) tie = true;
  }
  if (!maxId || tie) return nightStart(d, d.players, [{ t: maxId ? "tie" : "noVotes" }]);

  const ad = d.actionData || {};
  const target = byId(d, maxId);
  const princes = ad.princeSurvivedIds || [];
  if (target.role === "Prinz" && !princes.includes(maxId)) {
    return nightStart(d, d.players, [newsItem("prince", target)], { "actionData.princeSurvivedIds": [...princes, maxId] });
  }
  const r = applyDeaths(d.players, [maxId], ad.lovers || [], "executed");
  const hunters = pendingHunters(r.players, r.dead, ad.hunterUsedIds || []);
  if (hunters.length) {
    return {
      players: r.players, news: r.news, phase: "HUNTER", narratorStep: "HUNTER", votes: {},
      stepDuration: dur(d, DUR.hunter),
      "actionData.pendingHunterId": hunters[0], "actionData.pendingHunterQueue": hunters.slice(1),
      "actionData.hunterReturn": "NIGHT"
    };
  }
  return nightStart(d, r.players, r.news);
}

export function buildHunterShot(d, targetId) {
  if (d.phase !== "HUNTER") return null;
  const ad = d.actionData || {};
  const pid = ad.pendingHunterId;
  if (!pid) return null;
  const used = [...(ad.hunterUsedIds || []), pid];
  let players = d.players;
  const news = [...(d.news || [])];
  let dead = [];
  const target = targetId && byId(d, targetId);
  if (target && target.id !== pid && target.isAlive && inGame(target)) {
    const r = applyDeaths(players, [targetId], ad.lovers || [], "shot", { by: byId(d, pid)?.name || "?" });
    players = r.players; news.push(...r.news); dead = r.dead;
  }
  const queue = [...(ad.pendingHunterQueue || []), ...pendingHunters(players, dead, used)]
    .filter((id, i, a) => a.indexOf(id) === i && !used.includes(id));
  if (queue.length) {
    return {
      players, news, stepDuration: dur(d, DUR.hunter),
      "actionData.pendingHunterId": queue[0], "actionData.pendingHunterQueue": queue.slice(1),
      "actionData.hunterUsedIds": used
    };
  }
  const base = {
    "actionData.pendingHunterId": null, "actionData.pendingHunterQueue": [],
    "actionData.hunterReturn": null, "actionData.hunterUsedIds": used
  };
  if (ad.hunterReturn === "NIGHT") return nightStart(d, players, news, base);
  return { players, news, ...base, ...dayStart(d) };
}

// The generic "move on" used by timeouts and the narrator's "next" button.
export function buildAdvance(d, rnd = Math.random) {
  switch (d.phase) {
    case "NIGHT": return buildNightStep(d, rnd);
    case "DAY": return buildStartVoting(d);
    case "VOTING": return buildResolveVoting(d);
    case "HUNTER": return buildHunterShot(d, null);
    default: return null;
  }
}

export function buildWinCheck(d) {
  if (!d.gameStarted || ["HUNTER", "ENDED", "LOBBY"].includes(d.phase)) return null;
  const win = checkWin(d.players, d.actionData?.lovers);
  return win ? { phase: "ENDED", narratorStep: null, winner: win, stepDuration: 0 } : null;
}

// Applied to every transition: ends the game as soon as a side has won (never mid-hunter-shot,
// because the hunter's bullet can still change the outcome).
export function finalizeUpdate(d, upd) {
  const phase = upd.phase ?? d.phase;
  if (!d.gameStarted && !upd.gameStarted) return upd;
  if (["HUNTER", "ENDED", "LOBBY"].includes(phase)) return upd;
  const players = upd.players ?? d.players;
  const lovers = upd["actionData.lovers"] ?? d.actionData?.lovers;
  const win = checkWin(players, lovers);
  return win ? { ...upd, phase: "ENDED", narratorStep: null, winner: win, stepDuration: 0 } : upd;
}

// Is the current step finished? `elapsed` = ms since this client saw the step begin,
// `isOnline(id)` = presence check. Dead roles get a short fake pause so timing leaks nothing.
export function stepDone(d, elapsed, isOnline = () => true) {
  const ad = d.actionData || {};
  const fake = 3500 + ((d.seq || 0) % 5) * 900;
  const roleStep = (role, flag) => (hasRoleAlive(d, role) ? !!flag : elapsed > fake);
  if (d.phase === "NIGHT") {
    switch (d.nightActionsOrder?.[d.currentNightIndex || 0]) {
      case "AMOR": return roleStep("Amor", ad.amorDone);
      case "BESCHÜTZER": return roleStep("Beschützer", ad.guardDone);
      case "SMALL_GIRL": return roleStep("Kleines Mädchen", ad.girl?.done);
      case "SEER": return roleStep("Seherin", !!ad.seerTarget);
      case "WITCH": {
        const w = ad.witch || {};
        if (w.usedHeal && w.usedPoison) return elapsed > fake;
        return roleStep("Hexe", ad.witchDone);
      }
      case "WEREWOLF": {
        const wolves = alivePlayers(d).filter(p => p.role === "Werwolf");
        if (!wolves.length) return elapsed > fake;
        const votes = ad.werewolfVotes || {};
        const voted = wolves.filter(w => votes[w.id]).length;
        return voted > 0 && wolves.filter(w => isOnline(w.id)).every(w => votes[w.id]);
      }
      default: return true;
    }
  }
  if (d.phase === "DAY") {
    const alive = alivePlayers(d);
    const ready = alive.filter(p => d.readyVotes?.[p.id]).length;
    return alive.length > 0 && ready * 2 > alive.length;
  }
  if (d.phase === "VOTING") {
    const alive = alivePlayers(d);
    const votes = d.votes || {};
    const voted = alive.filter(p => votes[p.id]).length;
    return voted > 0 && alive.filter(p => isOnline(p.id)).every(p => votes[p.id]);
  }
  if (d.phase === "HUNTER") {
    const h = byId(d, ad.pendingHunterId);
    return !h || h.left;
  }
  return false;
}

// Mirrors Firestore's updateDoc semantics for dotted paths (used by tests and optimistic checks).
export function applyUpdate(d, upd) {
  const out = JSON.parse(JSON.stringify(d));
  for (const [k, v] of Object.entries(upd)) {
    const parts = k.split(".");
    let o = out;
    for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] && typeof o[parts[i]] === "object" ? o[parts[i]] : {}; o = o[parts[i]]; }
    o[parts[parts.length - 1]] = v === undefined ? null : JSON.parse(JSON.stringify(v));
  }
  return out;
}
