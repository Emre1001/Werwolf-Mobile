// Run: node tests/engine.test.mjs  — pure rule tests + randomized full-game simulation.
import assert from "node:assert/strict";
import * as E from "../engine.js";

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const apply = (d, upd) => {
  if (!upd) return d;
  const f = E.finalizeUpdate(d, upd);
  return { ...E.applyUpdate(d, f), seq: (d.seq || 0) + 1 };
};
const mkLobby = (n, opts = {}) => ({
  id: "ABCDEF", mode: opts.mode || "online", seq: 0, gameStarted: false, phase: "LOBBY",
  settings: opts.settings || E.defaultSettings(), confirmedNarratorId: "narr" in opts ? opts.narr : "AUTOMATIC",
  players: Array.from({ length: n }, (_, i) => ({ id: "p" + i, name: "P" + i, isAlive: true, role: null })),
  actionData: E.defaultActionData()
});
const withRoles = (roles) => {
  const d = mkLobby(roles.length);
  d.gameStarted = true;
  d.players = d.players.map((p, i) => ({ ...p, role: roles[i] }));
  return d;
};

let tests = 0;
const test = (name, fn) => { fn(); tests++; };

test("wolves never win at start (old bug: 2 wolves vs 2 villagers)", () => {
  for (let n = 4; n <= 20; n++) {
    for (const w of ["auto", 1, 2, 3, 4]) {
      const pool = E.buildRolePool(n, { ...E.defaultSettings(), wolves: w }, rnd);
      assert.equal(pool.length, n);
      const wolves = pool.filter(r => r === "Werwolf").length;
      assert.ok(wolves >= 1 && wolves < n - wolves, `n=${n} w=${w} wolves=${wolves}`);
    }
  }
  const s = apply(mkLobby(4), E.buildStartGame(mkLobby(4), "g1", rnd));
  assert.equal(s.phase, "NIGHT");
});

test("seer is dealt first when slots are short", () => {
  const pool = E.buildRolePool(4, E.defaultSettings(), rnd);
  assert.ok(pool.includes("Seherin"));
});

test("local mode needs narrator, narrator gets no role", () => {
  const d = mkLobby(5, { mode: "lokal", narr: null });
  assert.equal(E.buildStartGame(d, "g"), null);
  d.confirmedNarratorId = "p0";
  const s = apply(d, E.buildStartGame(d, "g", rnd));
  assert.equal(s.players[0].role, E.NARRATOR);
  assert.equal(s.stepDuration, 0);
});

test("wolf kill → day with news; guard and witch heal save", () => {
  let d = withRoles(["Werwolf", "Dorfbewohner", "Dorfbewohner", "Dorfbewohner", "Seherin"]);
  d = { ...d, phase: "NIGHT", nightActionsOrder: ["WEREWOLF"], currentNightIndex: 0, round: 1 };
  d.actionData.werewolfVotes = { p0: "p1" };
  const day = apply(d, E.buildAdvance(d, rnd));
  assert.equal(day.phase, "DAY");
  assert.equal(day.players[1].isAlive, false);
  assert.equal(day.news[0].t, "killed");
  const g = structuredClone(d); g.actionData.guardTarget = "p1";
  assert.equal(apply(g, E.buildAdvance(g, rnd)).players[1].isAlive, true);
  const h = structuredClone(d); h.actionData.witch.healTarget = "p1";
  const hd = apply(h, E.buildAdvance(h, rnd));
  assert.equal(hd.players[1].isAlive, true);
  assert.equal(hd.actionData.witch.usedHeal, true);
});

test("elder survives first attack only", () => {
  let d = withRoles(["Werwolf", "Älteste", "Dorfbewohner", "Dorfbewohner", "Dorfbewohner"]);
  d = { ...d, phase: "NIGHT", nightActionsOrder: ["WEREWOLF"], currentNightIndex: 0 };
  d.actionData.werewolfVotes = { p0: "p1" };
  const a = apply(d, E.buildAdvance(d, rnd));
  assert.equal(a.players[1].isAlive, true);
  const b = { ...a, phase: "NIGHT", nightActionsOrder: ["WEREWOLF"], currentNightIndex: 0 };
  b.actionData = { ...b.actionData, werewolfVotes: { p0: "p1" } };
  assert.equal(apply(b, E.buildAdvance(b, rnd)).players[1].isAlive, false);
});

test("lovers die together; mixed lovers win alone", () => {
  let d = withRoles(["Werwolf", "Dorfbewohner", "Dorfbewohner", "Dorfbewohner"]);
  d = { ...d, phase: "VOTING", votes: { p0: "p2", p1: "p2", p3: "p2" } };
  d.actionData.lovers = ["p2", "p3"];
  const r = apply(d, E.buildAdvance(d, rnd));
  assert.equal(r.players[2].isAlive, false);
  assert.equal(r.players[3].isAlive, false);
  assert.equal(r.phase, "ENDED"); // 1 wolf vs 1 villager
  assert.equal(r.winner, "WEREWOLF");
  assert.equal(E.checkWin([{ id: "a", role: "Werwolf", isAlive: true }, { id: "b", role: "Seherin", isAlive: true }], ["a", "b"]), "LOVERS");
});

test("tie and prince → no execution, night starts", () => {
  let d = withRoles(["Werwolf", "Prinz", "Dorfbewohner", "Dorfbewohner", "Dorfbewohner"]);
  d = { ...d, phase: "VOTING", round: 1, votes: { p0: "p2", p2: "p3" } };
  const tie = apply(d, E.buildAdvance(d, rnd));
  assert.equal(tie.phase, "NIGHT"); assert.equal(tie.news[0].t, "tie"); assert.equal(tie.round, 2);
  d.votes = { p0: "p1", p2: "p1", p3: "p1" };
  const pr = apply(d, E.buildAdvance(d, rnd));
  assert.equal(pr.players[1].isAlive, true); assert.equal(pr.news[0].t, "prince");
  const pr2 = apply({ ...pr, phase: "VOTING", votes: d.votes }, E.buildAdvance({ ...pr, phase: "VOTING", votes: d.votes }, rnd));
  assert.equal(pr2.players[1].isAlive, false);
});

test("hunter shot chain and queue; returns to correct phase", () => {
  let d = withRoles(["Werwolf", "Jäger", "Jäger", "Dorfbewohner", "Dorfbewohner", "Werwolf", "Dorfbewohner"]);
  d = { ...d, phase: "VOTING", round: 1, votes: { p0: "p1", p2: "p1", p3: "p1" } };
  let s = apply(d, E.buildAdvance(d, rnd));
  assert.equal(s.phase, "HUNTER"); assert.equal(s.actionData.pendingHunterId, "p1");
  s = apply(s, E.buildHunterShot(s, "p2")); // shoots the other hunter → he gets a shot too
  assert.equal(s.phase, "HUNTER"); assert.equal(s.actionData.pendingHunterId, "p2");
  s = apply(s, E.buildHunterShot(s, "p0"));
  assert.equal(s.phase, "NIGHT");
  assert.deepEqual(s.news.map(n => n.t), ["executed", "shot", "shot"]);
  // timeout = shoots nobody
  let t = apply(d, E.buildAdvance(d, rnd));
  t = apply(t, E.buildAdvance(t, rnd));
  assert.equal(t.phase, "NIGHT");
});

test("seq guard semantics: stale builders on wrong phase return null", () => {
  const d = withRoles(["Werwolf", "Dorfbewohner", "Dorfbewohner", "Dorfbewohner"]);
  assert.equal(E.buildStartVoting({ ...d, phase: "NIGHT" }), null);
  assert.equal(E.buildResolveVoting({ ...d, phase: "DAY" }), null);
  assert.equal(E.buildHunterShot({ ...d, phase: "DAY" }, "p1"), null);
  assert.equal(E.buildStartGame({ ...d, gameStarted: true }, "x"), null);
});

test("stepDone: offline players don't block votes; dead roles fake-pause", () => {
  const d = { ...withRoles(["Werwolf", "Dorfbewohner", "Dorfbewohner", "Dorfbewohner"]), phase: "VOTING", votes: { p0: "p1", p1: "p0", p2: "p0" } };
  assert.equal(E.stepDone(d, 0, () => true), false);
  assert.equal(E.stepDone(d, 0, id => id !== "p3"), true);
  const n = { ...withRoles(["Werwolf", "Dorfbewohner", "Dorfbewohner", "Dorfbewohner"]), phase: "NIGHT", nightActionsOrder: ["WEREWOLF", "SEER"], currentNightIndex: 1, seq: 3 };
  assert.equal(E.stepDone(n, 1000), false);
  assert.equal(E.stepDone(n, 10000), true);
  const day = { ...withRoles(["Werwolf", "Dorfbewohner", "Dorfbewohner", "Dorfbewohner"]), phase: "DAY", readyVotes: { p0: true, p1: true } };
  assert.equal(E.stepDone(day, 0), false);
  day.readyVotes.p2 = true;
  assert.equal(E.stepDone(day, 0), true);
});

test("little girl caught dies at dawn", () => {
  let d = withRoles(["Werwolf", "Kleines Mädchen", "Dorfbewohner", "Dorfbewohner", "Dorfbewohner"]);
  d = { ...d, phase: "NIGHT", nightActionsOrder: ["WEREWOLF", "SMALL_GIRL"], currentNightIndex: 1 };
  d.actionData.girl = { done: true, peeked: true, caught: true, id: "p1", wolves: [] };
  const r = apply(d, E.buildAdvance(d, rnd));
  assert.equal(r.players[1].isAlive, false);
  assert.equal(r.news.find(n => n.id === "p1").t, "girlCaught");
});

test("leaver triggers win check; restart resets cleanly", () => {
  let d = { ...withRoles(["Werwolf", "Dorfbewohner", "Dorfbewohner", "Dorfbewohner"]), phase: "DAY" };
  d.players[0] = { ...d.players[0], isAlive: false, left: true };
  const w = apply(d, E.buildWinCheck(d));
  assert.equal(w.winner, "VILLAGE");
  const r = apply(w, E.buildRestart(w));
  assert.equal(r.gameStarted, false); assert.equal(r.players.length, 3);
  assert.ok(r.players.every(p => p.isAlive && p.role === null));
});

// ---- randomized full games ----
let games = 0, ended = 0;
const winners = {};
for (let g = 0; g < 4000; g++) {
  const n = 4 + Math.floor(rnd() * 13);
  const settings = E.defaultSettings();
  for (const r of E.OPTIONAL_ROLES) settings.roles[r] = rnd() < 0.7;
  settings.wolves = ["auto", 1, 2, 3][Math.floor(rnd() * 4)];
  let d = mkLobby(n, { settings });
  d = apply(d, E.buildStartGame(d, "g" + g, rnd));
  for (let step = 0; step < 500 && d.phase !== "ENDED"; step++) {
    const ad = d.actionData;
    const alive = E.alivePlayers(d);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    // random player actions, sometimes skipped (= timeouts)
    if (d.phase === "NIGHT" && rnd() < 0.85) {
      const st = d.nightActionsOrder[d.currentNightIndex];
      const actor = (role) => alive.find(p => p.role === role);
      if (st === "WEREWOLF") for (const w of alive.filter(p => p.role === "Werwolf")) { const t = pick(alive.filter(p => p.role !== "Werwolf")); if (t) d = E.applyUpdate(d, { [`actionData.werewolfVotes.${w.id}`]: t.id }); }
      if (st === "AMOR" && actor("Amor")) { const a = pick(alive), b = pick(alive.filter(p => p !== a)); if (a && b) d = E.applyUpdate(d, { "actionData.lovers": [a.id, b.id], "actionData.amorDone": true }); }
      if (st === "BESCHÜTZER" && actor("Beschützer")) d = E.applyUpdate(d, { "actionData.guardTarget": pick(alive.filter(p => p.id !== ad.lastGuardTarget))?.id || null, "actionData.guardDone": true });
      if (st === "SEER" && actor("Seherin")) d = E.applyUpdate(d, { "actionData.seerTarget": pick(alive).id });
      if (st === "SMALL_GIRL" && actor("Kleines Mädchen")) d = E.applyUpdate(d, { "actionData.girl": { done: true, peeked: true, caught: rnd() < 0.5, id: actor("Kleines Mädchen").id, wolves: [] } });
      if (st === "WITCH" && actor("Hexe")) d = E.applyUpdate(d, { "actionData.witch.healTarget": !ad.witch.usedHeal && rnd() < 0.3 ? ad.nightVictim : null, "actionData.witch.poisonTarget": !ad.witch.usedPoison && rnd() < 0.3 ? pick(alive).id : null, "actionData.witchDone": true });
    }
    if (d.phase === "VOTING") for (const v of alive) if (rnd() < 0.9) d = E.applyUpdate(d, { [`votes.${v.id}`]: pick(alive.filter(p => p.id !== v.id)).id });
    if (d.phase === "HUNTER" && rnd() < 0.8) { d = apply(d, E.buildHunterShot(d, pick(alive)?.id)); continue; }
    if (rnd() < 0.03) { const p = pick(alive); d = E.applyUpdate(d, { players: d.players.map(x => x.id === p.id ? { ...x, isAlive: false, left: true } : x) }); const w = E.buildWinCheck(d); if (w) { d = apply(d, w); continue; } }
    const before = d.seq;
    d = apply(d, E.buildAdvance(d, rnd));
    assert.ok(d.seq === before + 1, `stuck in ${d.phase}`);
    // invariants
    assert.ok(["NIGHT", "DAY", "VOTING", "HUNTER", "ENDED"].includes(d.phase));
    if (d.phase !== "ENDED" && d.phase !== "HUNTER") assert.equal(E.checkWin(d.players, d.actionData.lovers), null, "game should have ended");
    if (d.phase === "HUNTER") assert.ok(d.actionData.pendingHunterId);
  }
  games++;
  if (d.phase === "ENDED") { ended++; winners[d.winner] = (winners[d.winner] || 0) + 1; }
}
assert.equal(ended, games, "every simulated game must finish");
console.log(`✓ ${tests} rule tests, ${games} random games all finished`, winners);
