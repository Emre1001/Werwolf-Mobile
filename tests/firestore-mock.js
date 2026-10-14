// Browser-side stand-in for firebase-firestore.js. All state lives in the Node test runner (window.__fs).
const subs = new Map();
let sid = 0;
window.__fsPush = (id, payload) => subs.get(id)?.(payload);
const call = (op, ...a) => window.__fs(op, JSON.stringify(a)).then(r => (r ? JSON.parse(r) : r));
export const initializeFirestore = () => ({});
export const getFirestore = () => ({});
export const doc = (db, ...p) => ({ type: "doc", path: p.join("/") });
export const collection = (db, ...p) => ({ type: "col", path: p.join("/") });
export const query = (col, ...c) => ({ ...col, c });
export const where = (f, op, v) => ({ w: [f, op, v] });
export const orderBy = (f) => ({ o: f });
export const limitToLast = (n) => ({ l: n });
export const arrayUnion = (...v) => ({ __op: "arrayUnion", v });
export const deleteField = () => ({ __op: "delete" });
const snapDoc = (path, data) => ({ id: path.split("/").pop(), exists: () => data != null, data: () => (data == null ? undefined : structuredClone(data)), ref: { type: "doc", path }, metadata: { fromCache: false } });
export async function getDoc(ref) { return snapDoc(ref.path, await call("get", ref.path)); }
export async function updateDoc(ref, upd) { const ok = await call("update", ref.path, upd); if (!ok) throw new Error("not-found"); }
export async function deleteDoc(ref) { await call("delete", ref.path); }
export async function addDoc(col, data) { await call("add", col.path, data); }
export async function getDocs(q) { const docs = await call("query", q.path, q.c || []); return { empty: !docs.length, docs: docs.map(([p, d]) => snapDoc(p, d)) }; }
export function onSnapshot(ref, a, b, c) {
  const cb = typeof a === "function" ? a : b;
  const id = ++sid;
  subs.set(id, (payload) => ref.type === "doc" ? cb(snapDoc(ref.path, payload)) : cb({ docs: payload.map(([p, d]) => snapDoc(p, d)) }));
  call("sub", id, ref.type === "doc" ? { doc: ref.path } : { col: ref.path, c: ref.c || [] });
  return () => { subs.delete(id); call("unsub", id); };
}
export async function runTransaction(db, fn) {
  for (let i = 0; i < 8; i++) {
    const reads = {}, writes = [];
    const tx = {
      get: async (ref) => { const [v, d] = await call("getv", ref.path); reads[ref.path] = v; return snapDoc(ref.path, d); },
      update: (ref, u) => writes.push(["update", ref.path, u]),
      set: (ref, d) => writes.push(["set", ref.path, d]),
      delete: (ref) => writes.push(["delete", ref.path])
    };
    const res = await fn(tx);
    if (await call("commit", reads, writes)) return res;
  }
  throw new Error("transaction contention");
}
