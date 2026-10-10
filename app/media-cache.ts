import type { EncryptedPayload } from "./e2ee";

export type CachedMedia = { uid: string; id: string; storagePath: string; metadata: EncryptedPayload; blob: Blob };
const DATABASE = "keepsake-encrypted-media";
const STORE = "media";

async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: ["uid", "id"] });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Device media storage is blocked."));
  });
}

async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || request.error);
      tx.onerror = () => reject(tx.error || request.error);
    });
  } finally { db.close(); }
}

// Only ciphertext and encrypted metadata are persisted, never decrypted images.
export async function cacheMedia(item: CachedMedia) {
  await transaction("readwrite", store => store.put(item));
}
export async function cachedMedia(uid: string, id: string) {
  return await transaction("readonly", store => store.get([uid, id])) as CachedMedia | undefined;
}
export async function cachedMediaList(uid: string) {
  return (await transaction("readonly", store => store.getAll()) as CachedMedia[]).filter(item => item.uid === uid);
}
export async function removeCachedMedia(uid: string, id: string) {
  await transaction("readwrite", store => store.delete([uid, id]));
}
