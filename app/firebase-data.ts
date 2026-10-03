import { collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc } from "firebase/firestore";
import { deleteObject, getBlob, getDownloadURL, ref, uploadBytesResumable } from "firebase/storage";
import { db, storage } from "./firebase";
import { decryptMediaBlob, decryptPayload, deleteEncryptionEnvelope, E2EE_ENABLED, encryptMediaBlob, encryptPayload, EncryptedPayload, getSessionKey } from "./e2ee";

export type CloudState = {
  people: unknown[];
  notes: unknown[];
  inbox: unknown[];
  reminders: unknown;
  darkMode: boolean;
};

export type CloudMediaRecord = {
  id: string;
  personId: number;
  type: "photo" | "video" | "voice" | "profile" | "cover";
  name: string;
  size: number;
  duration?: number;
  caption?: string;
  takenAt?: string;
  createdAt?: string;
  url: string;
};

type MediaMetadata = Omit<CloudMediaRecord, "url">;
type EncryptedMediaDocument = { cryptoVersion: 1; storagePath: string; metadata: EncryptedPayload };

function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function ensureUserProfile(uid: string, name: string, email: string) {
  const userRef = doc(db, "users", uid);
  const existing = await getDoc(userRef);
  if (existing.exists()) {
    await setDoc(userRef, { name, email, updatedAt: serverTimestamp() }, { merge: true });
  } else {
    await setDoc(userRef, { name, email, plan: "free", createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  }
}

export async function loadCloudState(uid: string) {
  const encryptedSnapshot = E2EE_ENABLED ? await getDoc(doc(db, "users", uid, "app", "e2eeState")) : null;
  if (encryptedSnapshot?.exists()) {
    const data = encryptedSnapshot.data();
    const key = getSessionKey(uid);
    if (!key) throw new Error("Encrypted Keepsake data cannot be opened without an account key.");
    return decryptPayload<CloudState>(key, data.payload as EncryptedPayload, `keepsake:state:${uid}:v1`);
  }
  const snapshot = await getDoc(doc(db, "users", uid, "app", "state"));
  return snapshot.exists() ? snapshot.data() as CloudState : null;
}

export async function saveCloudState(uid: string, state: CloudState) {
  const stateRef = doc(db, "users", uid, "app", E2EE_ENABLED ? "e2eeState" : "state");
  if (!E2EE_ENABLED) {
    await setDoc(stateRef, { ...clean(state), updatedAt: serverTimestamp() });
    return;
  }
  const key = getSessionKey(uid);
  if (!key) throw new Error("Keepsake is locked.");
  const payload = await encryptPayload(key, clean(state), `keepsake:state:${uid}:v1`);
  await setDoc(stateRef, { cryptoVersion: 1, payload, updatedAt: serverTimestamp() });
  const verification = await getDoc(stateRef);
  await decryptPayload<CloudState>(key, verification.data()?.payload as EncryptedPayload, `keepsake:state:${uid}:v1`);
}

function folderFor(type: CloudMediaRecord["type"]) {
  if (type === "photo") return "photos";
  if (type === "video") return "videos";
  if (type === "voice") return "voice";
  return type;
}

function pathFor(uid: string, item: MediaMetadata) {
  if (item.personId === 0 && item.type === "voice") return `users/${uid}/inbox/voice/${item.id}`;
  return `users/${uid}/people/${item.personId}/${folderFor(item.type)}/${item.id}`;
}

function upload(storagePath: string, blob: Blob, contentType: string | undefined, onProgress?: (percent: number) => void) {
  const task = uploadBytesResumable(ref(storage, storagePath), blob, { contentType });
  return new Promise<void>((resolve, reject) => task.on("state_changed", (snapshot) => {
    onProgress?.(snapshot.totalBytes ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100) : 0);
  }, reject, resolve));
}

export async function uploadCloudMedia(uid: string, item: MediaMetadata, file: Blob, onProgress?: (percent: number) => void) {
  const basePath = pathFor(uid, item);
  const mediaRef = doc(db, "users", uid, "media", item.id);
  const previous = await getDoc(mediaRef);
  const previousPath = previous.exists() ? previous.data().storagePath as string | undefined : undefined;
  if (!E2EE_ENABLED) {
    await upload(basePath, file, file.type || undefined, onProgress);
    await setDoc(mediaRef, { ...clean(item), storagePath: basePath, updatedAt: serverTimestamp() });
    if (previousPath && previousPath !== basePath) await deleteObject(ref(storage, previousPath)).catch(() => undefined);
    return getDownloadURL(ref(storage, basePath));
  }
  const key = getSessionKey(uid);
  if (!key) throw new Error("Keepsake is locked.");
  const storagePath = `${basePath}.e2ee`;
  const encryptedFile = await encryptMediaBlob(key, file, `keepsake:media:${uid}:${item.id}:v1`);
  await upload(storagePath, encryptedFile, "application/octet-stream", onProgress);
  const metadata = await encryptPayload(key, clean(item), `keepsake:media-metadata:${uid}:${item.id}:v1`);
  await setDoc(mediaRef, { cryptoVersion: 1, storagePath, metadata, updatedAt: serverTimestamp() });
  if (previousPath && previousPath !== storagePath && previous.data()?.cryptoVersion === 1) await deleteObject(ref(storage, previousPath)).catch(() => undefined);
  return URL.createObjectURL(file);
}

export async function loadCloudMedia(uid: string) {
  const snapshot = await getDocs(collection(db, "users", uid, "media"));
  const loaded: CloudMediaRecord[] = [];
  // Process sequentially so several large videos never occupy memory together.
  for (const mediaDoc of snapshot.docs) {
    try {
      const data = mediaDoc.data();
      const id = mediaDoc.id;
      if (data.cryptoVersion === 1 && data.metadata) {
        const key = getSessionKey(uid);
        if (!key) throw new Error("Keepsake is locked.");
        const item = await decryptPayload<MediaMetadata>(key, data.metadata as EncryptedPayload, `keepsake:media-metadata:${uid}:${id}:v1`);
        const encryptedBlob = await getBlob(ref(storage, data.storagePath as string));
        const blob = await decryptMediaBlob(key, encryptedBlob, `keepsake:media:${uid}:${id}:v1`);
        loaded.push({ ...item, id, url: URL.createObjectURL(blob) });
        continue;
      }
      const item = data as MediaMetadata & { storagePath: string };
      if (!E2EE_ENABLED) {
        loaded.push({ ...item, id, url: await getDownloadURL(ref(storage, item.storagePath)) });
        continue;
      }

      // Migrate to a separate encrypted object. Verify the uploaded ciphertext
      // by downloading and decrypting it, and retain the original as rollback.
      const key = getSessionKey(uid);
      if (!key) throw new Error("Keepsake is locked.");
      const blob = await getBlob(ref(storage, item.storagePath));
      const storagePath = `${item.storagePath}.e2ee`;
      const encryptedFile = await encryptMediaBlob(key, blob, `keepsake:media:${uid}:${id}:v1`);
      await upload(storagePath, encryptedFile, "application/octet-stream");
      const uploaded = await getBlob(ref(storage, storagePath));
      const verified = await decryptMediaBlob(key, uploaded, `keepsake:media:${uid}:${id}:v1`);
      if (verified.size !== blob.size || verified.type !== blob.type) throw new Error("Encrypted media verification failed.");
      const metadataItem: MediaMetadata = clean({ id, personId: item.personId, type: item.type, name: item.name, size: item.size, duration: item.duration, caption: item.caption, takenAt: item.takenAt, createdAt: item.createdAt });
      const metadata = await encryptPayload(key, metadataItem, `keepsake:media-metadata:${uid}:${id}:v1`);
      await setDoc(doc(db, "users", uid, "media", id), { cryptoVersion: 1, storagePath, legacyStoragePath: item.storagePath, metadata, updatedAt: serverTimestamp() });
      loaded.push({ ...metadataItem, url: URL.createObjectURL(blob) });
    } catch {
      // One corrupt or unavailable file must not hide the rest of the account.
    }
  }
  return loaded;
}

export async function deleteCloudMedia(uid: string, id: string) {
  const mediaRef = doc(db, "users", uid, "media", id);
  const snapshot = await getDoc(mediaRef);
  if (snapshot.exists()) {
    const storagePath = snapshot.data().storagePath as string | undefined;
    const legacyStoragePath = snapshot.data().legacyStoragePath as string | undefined;
    if (storagePath) await deleteObject(ref(storage, storagePath)).catch(() => undefined);
    if (legacyStoragePath && legacyStoragePath !== storagePath) await deleteObject(ref(storage, legacyStoragePath)).catch(() => undefined);
  }
  await deleteDoc(mediaRef);
}

export async function updateCloudMediaMetadata(uid: string, id: string, updates: { name?: string; caption?: string; takenAt?: string }) {
  const mediaRef = doc(db, "users", uid, "media", id);
  if (!E2EE_ENABLED) {
    await setDoc(mediaRef, { ...clean(updates), updatedAt: serverTimestamp() }, { merge: true });
    return;
  }
  const snapshot = await getDoc(mediaRef);
  if (!snapshot.exists()) throw new Error("Media metadata was not found.");
  const data = snapshot.data() as EncryptedMediaDocument;
  const key = getSessionKey(uid);
  if (!key || data.cryptoVersion !== 1) throw new Error("Encrypted media metadata is unavailable.");
  const current = await decryptPayload<MediaMetadata>(key, data.metadata, `keepsake:media-metadata:${uid}:${id}:v1`);
  const metadata = await encryptPayload(key, { ...current, ...clean(updates) }, `keepsake:media-metadata:${uid}:${id}:v1`);
  await setDoc(mediaRef, { metadata, updatedAt: serverTimestamp() }, { merge: true });
}

export async function deleteCloudAccountData(uid: string) {
  const media = await getDocs(collection(db, "users", uid, "media"));
  await Promise.all(media.docs.map((entry) => deleteCloudMedia(uid, entry.id)));
  await deleteDoc(doc(db, "users", uid, "app", "state")).catch(() => undefined);
  await deleteDoc(doc(db, "users", uid, "app", "e2eeState")).catch(() => undefined);
  await deleteEncryptionEnvelope(uid);
  await deleteDoc(doc(db, "users", uid));
}
