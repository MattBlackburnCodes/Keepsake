import { deleteDoc, doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "./firebase";

export const E2EE_ENABLED = process.env.NEXT_PUBLIC_E2EE_ENABLED === "true";
const KEY_DB = "keepsake-encryption";
const KEY_STORE = "account-keys";
const VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type EncryptedPayload = { v: 1; iv: string; ciphertext: string };
type KeyEnvelope = { v: 1; kdf: "HKDF-SHA-256"; salt: string; iv: string; wrappedKey: string; status?: "pending" | "active" };

let sessionKey: CryptoKey | null = null;
let sessionOwner = "";

function bytesToBase64(bytes: Uint8Array) {
  let value = "";
  for (let index = 0; index < bytes.length; index += 0x8000) value += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(value);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array) {
  return Uint8Array.from(bytes).buffer;
}

function recoveryBytesToText(bytes: Uint8Array) {
  const compact = bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const groups = compact.slice(3).match(/.{1,4}/g) ?? [];
  return [compact.slice(0, 3), ...groups].join(" ");
}

function recoveryTextToBytes(value: string) {
  const legacyHex = value.replace(/[\s-]/g, "");
  if (/^[a-fA-F0-9]{64}$/.test(legacyHex)) {
    return Uint8Array.from(legacyHex.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
  }
  const compact = value.replace(/\s/g, "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(compact)) throw new Error("Enter the complete recovery key.");
  const standardBase64 = compact.replace(/-/g, "+").replace(/_/g, "/") + "=";
  const decoded = base64ToBytes(standardBase64);
  if (decoded.length !== 32) throw new Error("Enter the complete recovery key.");
  return decoded;
}

function openKeyDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(KEY_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(KEY_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function persistKey(uid: string, key: CryptoKey) {
  const database = await openKeyDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database.transaction(KEY_STORE, "readwrite").objectStore(KEY_STORE).put(key, uid);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  database.close();
  sessionOwner = uid;
  sessionKey = key;
}

export async function loadDeviceKey(uid: string) {
  if (!E2EE_ENABLED) return null;
  if (sessionOwner === uid && sessionKey) return sessionKey;
  const database = await openKeyDatabase();
  const key = await new Promise<CryptoKey | null>((resolve, reject) => {
    const request = database.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).get(uid);
    request.onsuccess = () => resolve((request.result as CryptoKey | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  database.close();
  if (key) { sessionOwner = uid; sessionKey = key; }
  return key;
}

export async function forgetDeviceKey(uid: string) {
  sessionKey = null; sessionOwner = "";
  if (!E2EE_ENABLED) return;
  const database = await openKeyDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database.transaction(KEY_STORE, "readwrite").objectStore(KEY_STORE).delete(uid);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  database.close();
}

export function getSessionKey(uid: string) {
  if (!E2EE_ENABLED) return null;
  if (!sessionKey || sessionOwner !== uid) throw new Error("Keepsake is locked. Enter the recovery key to continue.");
  return sessionKey;
}

async function deriveWrappingKey(recoverySecret: Uint8Array, salt: Uint8Array) {
  const material = await crypto.subtle.importKey("raw", asArrayBuffer(recoverySecret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: asArrayBuffer(salt), info: encoder.encode("Keepsake account key v1") }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptionEnvelopeExists(uid: string) {
  if (!E2EE_ENABLED) return false;
  return (await getDoc(doc(db, "users", uid, "crypto", "account"))).exists();
}

export async function encryptionEnvelopeStatus(uid: string): Promise<"none" | "pending" | "active"> {
  if (!E2EE_ENABLED) return "none";
  const snapshot = await getDoc(doc(db, "users", uid, "crypto", "account"));
  if (!snapshot.exists()) return "none";
  return snapshot.data().status === "pending" ? "pending" : "active";
}

// Kept separate so the recovery text exists only long enough to be shown once.
export async function setupAccountEncryption(uid: string) {
  if (!E2EE_ENABLED) throw new Error("End-to-end encryption is not enabled in this build.");
  if (await encryptionEnvelopeExists(uid)) throw new Error("Encryption is already configured for this account.");
  const extractableKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", extractableKey));
  const recoverySecret = crypto.getRandomValues(new Uint8Array(32));
  const recoveryKey = recoveryBytesToText(recoverySecret);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await deriveWrappingKey(recoverySecret, salt);
  const wrappedKey = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`Keepsake key:${uid}:v1`) }, wrappingKey, rawKey));
  await setDoc(doc(db, "users", uid, "crypto", "account"), { v: VERSION, kdf: "HKDF-SHA-256", salt: bytesToBase64(salt), iv: bytesToBase64(iv), wrappedKey: bytesToBase64(wrappedKey), status: "pending", createdAt: serverTimestamp() });
  const deviceKey = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  rawKey.fill(0); recoverySecret.fill(0);
  await persistKey(uid, deviceKey);
  return recoveryKey;
}

export async function activateAccountEncryption(uid: string) {
  const accountRef = doc(db, "users", uid, "crypto", "account");
  const snapshot = await getDoc(accountRef);
  if (!snapshot.exists() || !getSessionKey(uid)) throw new Error("Encryption setup is incomplete.");
  await setDoc(accountRef, { status: "active", activatedAt: serverTimestamp() }, { merge: true });
}

export async function restartPendingEncryption(uid: string) {
  if (await encryptionEnvelopeStatus(uid) !== "pending") throw new Error("An active encrypted account cannot be reset this way.");
  await forgetDeviceKey(uid);
  await deleteDoc(doc(db, "users", uid, "crypto", "account"));
}

export async function unlockWithRecoveryKey(uid: string, recoveryText: string) {
  const snapshot = await getDoc(doc(db, "users", uid, "crypto", "account"));
  if (!snapshot.exists()) throw new Error("No encrypted account key was found.");
  const envelope = snapshot.data() as KeyEnvelope;
  if (envelope.v !== VERSION || envelope.kdf !== "HKDF-SHA-256") throw new Error("This recovery-key version is not supported.");
  const recoverySecret = recoveryTextToBytes(recoveryText);
  try {
    const wrappingKey = await deriveWrappingKey(recoverySecret, base64ToBytes(envelope.salt));
    const rawKey = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(envelope.iv), additionalData: encoder.encode(`Keepsake key:${uid}:v1`) }, wrappingKey, base64ToBytes(envelope.wrappedKey));
    const deviceKey = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    await persistKey(uid, deviceKey);
  } catch {
    throw new Error("That recovery key is not valid for this Keepsake account.");
  } finally {
    recoverySecret.fill(0);
  }
}

export async function encryptPayload(key: CryptoKey, value: unknown, context: string): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, key, plaintext);
  return { v: VERSION, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

export async function decryptPayload<T>(key: CryptoKey, payload: EncryptedPayload, context: string): Promise<T> {
  if (payload.v !== VERSION) throw new Error("Unsupported encrypted data version.");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(payload.iv), additionalData: encoder.encode(context) }, key, base64ToBytes(payload.ciphertext));
  return JSON.parse(decoder.decode(plaintext)) as T;
}

export async function deleteEncryptionEnvelope(uid: string) {
  await forgetDeviceKey(uid);
  await deleteDoc(doc(db, "users", uid, "crypto", "account")).catch(() => undefined);
}

const MEDIA_MAGIC = encoder.encode("KSEP1");
const MEDIA_CHUNK_SIZE = 1024 * 1024;

export async function encryptMediaBlob(key: CryptoKey, blob: Blob, context: string) {
  const chunks: BlobPart[] = [];
  const header: { v: 1; type: string; size: number; chunkSize: number; chunks: { iv: string; length: number }[] } = { v: 1, type: blob.type || "application/octet-stream", size: blob.size, chunkSize: MEDIA_CHUNK_SIZE, chunks: [] };
  for (let offset = 0, index = 0; offset < blob.size; offset += MEDIA_CHUNK_SIZE, index += 1) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = await blob.slice(offset, offset + MEDIA_CHUNK_SIZE).arrayBuffer();
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`${context}:chunk:${index}`) }, key, plaintext);
    header.chunks.push({ iv: bytesToBase64(iv), length: encrypted.byteLength });
    chunks.push(encrypted);
  }
  const encodedHeader = encoder.encode(JSON.stringify(header));
  const headerLength = new Uint8Array(4);
  new DataView(headerLength.buffer).setUint32(0, encodedHeader.byteLength, false);
  return new Blob([MEDIA_MAGIC, headerLength, encodedHeader, ...chunks], { type: "application/octet-stream" });
}

export async function decryptMediaBlob(key: CryptoKey, blob: Blob, context: string) {
  const prefix = new Uint8Array(await blob.slice(0, 9).arrayBuffer());
  if (!MEDIA_MAGIC.every((value, index) => prefix[index] === value)) throw new Error("This is not encrypted Keepsake media.");
  const headerLength = new DataView(prefix.buffer, prefix.byteOffset + 5, 4).getUint32(0, false);
  const header = JSON.parse(decoder.decode(await blob.slice(9, 9 + headerLength).arrayBuffer())) as { v: 1; type: string; size: number; chunks: { iv: string; length: number }[] };
  if (header.v !== VERSION) throw new Error("Unsupported encrypted media version.");
  const parts: BlobPart[] = []; let offset = 9 + headerLength;
  for (let index = 0; index < header.chunks.length; index += 1) {
    const chunk = header.chunks[index];
    const ciphertext = await blob.slice(offset, offset + chunk.length).arrayBuffer();
    parts.push(await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(chunk.iv), additionalData: encoder.encode(`${context}:chunk:${index}`) }, key, ciphertext));
    offset += chunk.length;
  }
  return new Blob(parts, { type: header.type });
}
