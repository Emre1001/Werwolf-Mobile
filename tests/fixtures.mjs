// Seeded lobby/game states shared by the device matrix and the preview server.
export const ME = "me-0000";
const names = ["Anna", "Ben", "Cem", "Dana", "Emre", "Finn", "Gül", "Hans", "Ida-Marie Langname"];
const roles = ["Werwolf", "Seherin", "Hexe", "Dorfbewohner", "Werwolf", "Jäger", "Amor", "Dorfbewohner", "Prinz"];
const basePlayers = () => names.map((n, i) => ({ id: i === 0 ? ME : "p" + i, name: n, deviceId: "d" + i, isAlive: true, role: null }));
const hb = () => Object.fromEntries(basePlayers().map(p => [p.id, Date.now()]));
const settings = { roles: { Seherin: true, Hexe: true, Amor: true, "Jäger": true, "Kleines Mädchen": false, "Beschützer": true, Prinz: true, "Älteste": false }, wolves: "auto", dayTime: 120, revealRoles: true };
const common = { code: "WLF7X2", hostId: ME, isPublic: false, mode: "online", settings, kicked: [], volunteerNarratorId: null, confirmedNarratorId: "AUTOMATIC", seq: 5, stepDuration: 0, lastUpdate: Date.now(), heartbeats: hb(), votes: {}, readyVotes: {}, round: 2, gameId: "g1", firstNightDone: true };
const ad = { werewolfVotes: { p4: "p2" }, nightVictim: null, seerTarget: null, seerLog: [], witch: { usedHeal: false, usedPoison: false, healTarget: null, poisonTarget: null }, witchDone: false, girl: null, lovers: [], amorDone: true, guardTarget: null, lastGuardTarget: null, guardDone: false, elderSurvivedIds: [], princeSurvivedIds: [], pendingHunterId: null, pendingHunterQueue: [], hunterReturn: null, hunterUsedIds: [] };
const withRoles = (dead = []) => basePlayers().map((p, i) => ({ ...p, role: roles[i], isAlive: !dead.includes(i) }));
export const STATES = {
  lobby: { ...common, gameStarted: false, phase: "LOBBY", players: basePlayers(), actionData: ad, news: [] },
  night: { ...common, gameStarted: true, phase: "NIGHT", narratorStep: "WEREWOLF", nightActionsOrder: ["WEREWOLF", "SEER", "WITCH"], currentNightIndex: 0, players: withRoles([7]), actionData: ad, news: [{ t: "executed", id: "p7", name: "Hans", role: "Dorfbewohner" }] },
  day: { ...common, gameStarted: true, phase: "DAY", narratorStep: "DAY", players: withRoles([7, 3]), actionData: ad, readyVotes: { p1: true, p2: true },
    news: [{ t: "killed", id: "p3", name: "Dana", role: "Dorfbewohner" }, { t: "lover", id: "p6", name: "Finn", role: "Jäger" }] },
  win: { ...common, gameStarted: true, phase: "ENDED", winner: "VILLAGE", players: withRoles([0, 4, 7]), actionData: { ...ad, lovers: ["p1", "p2"] }, news: [{ t: "executed", id: ME, name: "Anna", role: "Werwolf" }] }
};
