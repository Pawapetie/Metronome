// Recordings live in IndexedDB (localStorage is far too small for audio),
// keyed by song id. The files never leave the device. Every call is guarded:
// if storage fails, the recording still works until the app is closed.

const DB_NAME = 'metronome-audio';
const STORE = 'tracks';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

async function run(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export async function putAudio(id, blob) {
  try { await run('readwrite', (s) => s.put(blob, id)); return true; } catch { return false; }
}

export async function getAudio(id) {
  try { return (await run('readonly', (s) => s.get(id))) ?? null; } catch { return null; }
}

export async function deleteAudio(id) {
  try { await run('readwrite', (s) => s.delete(id)); } catch {}
}

export async function copyAudio(fromId, toId) {
  const blob = await getAudio(fromId);
  if (blob) await putAudio(toId, blob);
}
