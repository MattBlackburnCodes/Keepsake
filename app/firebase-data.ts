import { collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc } from "firebase/firestore";
import { deleteObject, getDownloadURL, ref, uploadBytesResumable } from "firebase/storage";
import { db, storage } from "./firebase";

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
  const snapshot = await getDoc(doc(db, "users", uid, "app", "state"));
  return snapshot.exists() ? snapshot.data() as CloudState : null;
}

export async function saveCloudState(uid: string, state: CloudState) {
  await setDoc(doc(db, "users", uid, "app", "state"), { ...clean(state), updatedAt: serverTimestamp() });
}

function folderFor(type: CloudMediaRecord["type"]) {
  if (type === "photo") return "photos";
  if (type === "video") return "videos";
  if (type === "voice") return "voice";
  return type;
}

function pathFor(uid: string, item: Omit<CloudMediaRecord, "url">) {
  if (item.personId === 0 && item.type === "voice") return `users/${uid}/inbox/voice/${item.id}`;
  return `users/${uid}/people/${item.personId}/${folderFor(item.type)}/${item.id}`;
}

export async function uploadCloudMedia(uid: string, item: Omit<CloudMediaRecord, "url">, file: Blob, onProgress?: (percent: number) => void) {
  const storagePath = pathFor(uid, item);
  const mediaRef = doc(db, "users", uid, "media", item.id);
  const previous = await getDoc(mediaRef);
  const previousPath = previous.exists() ? previous.data().storagePath as string | undefined : undefined;
  const task = uploadBytesResumable(ref(storage, storagePath), file, { contentType: file.type || undefined });
  await new Promise<void>((resolve, reject) => task.on("state_changed", (snapshot) => {
    onProgress?.(snapshot.totalBytes ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100) : 0);
  }, reject, resolve));
  await setDoc(mediaRef, { ...clean(item), storagePath, updatedAt: serverTimestamp() });
  if (previousPath && previousPath !== storagePath) await deleteObject(ref(storage, previousPath)).catch(() => undefined);
  return getDownloadURL(ref(storage, storagePath));
}

export async function loadCloudMedia(uid: string) {
  const snapshot = await getDocs(collection(db, "users", uid, "media"));
  return Promise.all(snapshot.docs.map(async (mediaDoc) => {
    const item = mediaDoc.data() as Omit<CloudMediaRecord, "url"> & { storagePath: string };
    return { ...item, id: mediaDoc.id, url: await getDownloadURL(ref(storage, item.storagePath)) } as CloudMediaRecord;
  }));
}

export async function deleteCloudMedia(uid: string, id: string) {
  const mediaRef = doc(db, "users", uid, "media", id);
  const snapshot = await getDoc(mediaRef);
  if (snapshot.exists()) {
    const storagePath = snapshot.data().storagePath as string | undefined;
    if (storagePath) await deleteObject(ref(storage, storagePath)).catch(() => undefined);
  }
  await deleteDoc(mediaRef);
}

export async function updateCloudMediaMetadata(uid: string, id: string, updates: { name?: string; caption?: string; takenAt?: string }) {
  await setDoc(doc(db, "users", uid, "media", id), { ...clean(updates), updatedAt: serverTimestamp() }, { merge: true });
}

export async function deleteCloudAccountData(uid: string) {
  const media = await getDocs(collection(db, "users", uid, "media"));
  await Promise.all(media.docs.map((entry) => deleteCloudMedia(uid, entry.id)));
  await deleteDoc(doc(db, "users", uid, "app", "state")).catch(() => undefined);
  await deleteDoc(doc(db, "users", uid));
}
