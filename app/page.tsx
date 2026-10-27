"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CustomExport from "./custom-export";
import { openPrintPreview } from "./print-preview";
import { createUserWithEmailAndPassword, deleteUser, EmailAuthProvider, getIdTokenResult, onAuthStateChanged, reauthenticateWithCredential, reload, sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword, signOut as firebaseSignOut, updatePassword, updateProfile } from "firebase/auth";
import { auth, initializeAnalytics } from "./firebase";
import { deleteCloudAccountData, deleteCloudMedia, ensureUserProfile, loadCloudMedia, loadCloudState, saveCloudState, updateCloudMediaMetadata, uploadCloudMedia } from "./firebase-data";
import { buildSandboxPurchaseUrl, loadSubscription } from "./revenuecat";
import { recoveryKeyConfirmationMatches, activateAccountEncryption, E2EE_ENABLED, encryptionEnvelopeStatus, loadDeviceKey, restartPendingEncryption, setupAccountEncryption, unlockWithRecoveryKey } from "./e2ee";

type Screen = "home" | "inbox" | "people" | "profile" | "notes" | "add" | "search" | "alerts" | "settings" | "personForm" | "privacy" | "terms" | "dataDeletion" | "changePassword" | "admin" | "about" | "storage" | "export";
type Favorite = { id: string; label: string; value: string };
type Milestone = { id: string; kind: string; title: string; date: string; details?: string };
type Person = { id: number; name: string; relationship: string; image: string; cover: string; birthday: string; anniversary?: string; color: string; about?: string; favorites?: Favorite[]; milestones?: Milestone[] };
type KeepsakeNote = { id: string; personId: number; title: string; body: string; createdAt: string };
type InboxItem = { id: string; title: string; body: string; createdAt: string; mediaId?: string };
type ReminderSettings = { enabled: boolean; frequency: "daily" | "weekly"; time: string; prompts: boolean };
type Plan = "free" | "pro";
type SubscriptionStatus = "idle" | "loading" | "ready" | "error";
type AuthUser = { uid: string; name: string; email: string; plan?: Plan; admin?: boolean; emailVerified: boolean };
type MediaItem = { id: string; personId: number; type: "photo" | "video" | "voice" | "profile" | "cover"; name: string; size: number; duration?: number; caption?: string; takenAt?: string; createdAt?: string; url: string };

type UploadType = "photo" | "video" | "voice";
type PlanLimits = { people: number; photosPerPerson: number; videosPerPerson: number; voicePerPerson: number; photosTotal: number; videosTotal: number; voiceTotal: number; storageBytes: number };

const MEDIA_FILE_LIMITS = { photoBytes: 10 * 1024 * 1024, videoBytes: 100 * 1024 * 1024, voiceBytes: 25 * 1024 * 1024, videoSeconds: 120, voiceSeconds: 300 };
const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { people: 4, photosPerPerson: 5, videosPerPerson: 2, voicePerPerson: 3, photosTotal: 12, videosTotal: 2, voiceTotal: 6, storageBytes: 250 * 1024 * 1024 },
  pro: { people: Infinity, photosPerPerson: 100, videosPerPerson: 20, voicePerPerson: 50, photosTotal: 1000, videosTotal: 100, voiceTotal: 500, storageBytes: 5 * 1024 * 1024 * 1024 },
};

function getPlan(user?: AuthUser | null): Plan { return user?.plan === "pro" ? "pro" : "free"; }
function getPlanLimits(plan: Plan) { return PLAN_LIMITS[plan]; }
function canCreatePerson(plan: Plan, peopleCount: number) { return peopleCount < getPlanLimits(plan).people; }
function escapeHtml(value: unknown) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character); }
function csvCell(value: unknown) { return `"${String(value ?? "").replace(/"/g, '""')}"`; }
function mediaUsage(media: MediaItem[]) { return media.reduce((total, item) => total + item.size, 0); }
function mediaAllowanceError(plan: Plan, media: MediaItem[], personId: number, type: UploadType, incomingBytes = 0) {
  const limits = getPlanLimits(plan); const singular = type === "voice" ? "voice recording" : type; const plural = type === "voice" ? "voice recordings" : `${type}s`;
  const perPerson = type === "photo" ? limits.photosPerPerson : type === "video" ? limits.videosPerPerson : limits.voicePerPerson;
  const accountTotal = type === "photo" ? limits.photosTotal : type === "video" ? limits.videosTotal : limits.voiceTotal;
  if (personId > 0 && media.filter((item) => item.personId === personId && item.type === type).length >= perPerson) return `${plan === "free" ? "Free" : "Pro"} allows ${perPerson} ${plural} per person.`;
  if (media.filter((item) => item.type === type).length >= accountTotal) return `${plan === "free" ? "Free" : "Pro"} allows ${accountTotal} ${plural} across the account.`;
  if (mediaUsage(media) + incomingBytes > limits.storageBytes) return `This ${singular} would exceed your ${plan === "free" ? "250 MB Free" : "5 GB Pro"} storage allowance.`;
  return null;
}
function formatStorage(bytes: number) { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`; }

const emptyPerson: Person = { id: 0, name: "", relationship: "", birthday: "", anniversary: "", color: "", about: "", favorites: [], milestones: [], image: "", cover: "" };

function openMediaDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("keepsake-media", 1); request.onupgradeneeded = () => request.result.createObjectStore("files", { keyPath: "key" }); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

async function loadLocalMedia(owner: string) {
  const db = await openMediaDatabase();
  return new Promise<MediaItem[]>((resolve, reject) => { const request = db.transaction("files", "readonly").objectStore("files").getAll(); request.onsuccess = () => resolve(request.result.filter((entry) => entry.owner === owner).map((entry) => ({ id: entry.id, personId: entry.personId, type: entry.type, name: entry.name, size: entry.size, duration: entry.duration, caption: entry.caption, takenAt: entry.takenAt, createdAt: entry.createdAt, url: URL.createObjectURL(entry.blob) }))); request.onerror = () => reject(request.error); });
}

function mediaFailureDetail(error: unknown) {
  return typeof error === "object" && error && "code" in error ? ` Firebase reported: ${String(error.code)}.` : "";
}

function withLoadTimeout<T>(operation: Promise<T>, milliseconds = 20000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Keepsake loading timed out.")), milliseconds);
    operation.then((value) => { window.clearTimeout(timer); resolve(value); }, (error) => { window.clearTimeout(timer); reject(error); });
  });
}

async function loadMedia(onError?: (id: string, error: unknown) => void) {
  if (!auth.currentUser) throw new Error("Sign in before loading media.");
  return loadCloudMedia(auth.currentUser.uid, onError) as Promise<MediaItem[]>;
}

async function storeMedia(_owner: string, item: Omit<MediaItem, "url">, blob: File, onProgress?: (percent: number) => void) {
  if (!auth.currentUser) throw new Error("Sign in before uploading media.");
  return uploadCloudMedia(auth.currentUser.uid, item, blob, onProgress);
}

async function removeStoredMedia(_owner: string, id: string) {
  if (!auth.currentUser) throw new Error("Sign in before deleting media.");
  await deleteCloudMedia(auth.currentUser.uid, id);
}

async function optimizeCoverImage(file: File) {
  if (file.size <= 2 * 1024 * 1024) return file;
  return new Promise<File>((resolve) => {
    const image = new Image(); const source = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(source);
      const scale = Math.min(1, 2200 / image.naturalWidth, 1400 / image.naturalHeight);
      const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => resolve(blob && blob.size < file.size ? new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "cover"}.jpg`, { type: "image/jpeg", lastModified: Date.now() }) : file), "image/jpeg", 0.84);
    };
    image.onerror = () => { URL.revokeObjectURL(source); resolve(file); };
    image.src = source;
  });
}

function getVideoDuration(file: File) {
  return new Promise<number>((resolve, reject) => { const video = document.createElement("video"); const url = URL.createObjectURL(file); video.preload = "metadata"; video.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(video.duration); }; video.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Video metadata could not be read.")); }; video.src = url; });
}

function getAudioDuration(file: File) {
  return new Promise<number>((resolve, reject) => { const audio = document.createElement("audio"); const url = URL.createObjectURL(file); audio.preload = "metadata"; audio.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(audio.duration); }; audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Audio metadata could not be read.")); }; audio.src = url; });
}

function displayDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function dateInputValue(value: string) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function calculateAge(value: string) {
  if (!value) return ""; const birth = new Date(`${dateInputValue(value)}T00:00:00`); if (Number.isNaN(birth.getTime())) return ""; const today = new Date(); let age = today.getFullYear() - birth.getFullYear(); if (today < new Date(today.getFullYear(), birth.getMonth(), birth.getDate())) age--; return age >= 0 ? `${age} years old` : "";
}

const navItems = [
  { id: "home" as Screen, label: "Home", icon: "⌂" },
  { id: "inbox" as Screen, label: "Quick Notes", icon: "▤" },
  { id: "add" as Screen, label: "Add", icon: "+" },
  { id: "people" as Screen, label: "People", icon: "♧" },
  { id: "search" as Screen, label: "Search", icon: "⌕" },
];

function getInitials(name: string) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join("") || "♡";
}

function Avatar({ person, size = "md" }: { person: Person; size?: "sm" | "md" | "lg" }) {
  return person.image ? <img className={`avatar avatar-${size}`} src={person.image} alt={`${person.name}'s portrait`} /> : <span className={`avatar avatar-${size} avatar-placeholder`} aria-label={`${person.name} initials`}>{getInitials(person.name)}</span>;
}

function CreatorCredit({ compact = false }: { compact?: boolean }) {
  return <span className={`bw-credit ${compact ? "compact" : ""}`}><span className="bw-mark"><img src="/blackburn-works-mark.png" alt="" /></span><span>Created by <strong>Blackburn Works</strong></span></span>;
}

function BottomNav({ screen, go, alertCount = 0 }: { screen: Screen; go: (screen: Screen) => void; alertCount?: number }) {
  return <nav className="bottom-nav" aria-label="Primary navigation">{navItems.map((item) => <button key={item.id} className={`${item.id === "add" ? "nav-add" : ""} ${screen === item.id ? "active" : ""}`} onClick={() => go(item.id)} aria-label={item.id === "alerts" && alertCount ? `${alertCount} alerts` : item.label}><span>{item.id === "add" ? <b className="nav-plus" aria-hidden="true">+</b> : item.icon}{item.id === "alerts" && alertCount > 0 && <i className="nav-badge" aria-hidden="true">{Math.min(alertCount, 99)}</i>}</span><small>{item.label}</small></button>)}</nav>;
}

function Sidebar({ screen, go, user }: { screen: Screen; go: (screen: Screen) => void; user: AuthUser }) {
  const plan = user.plan ?? "free";
  return <aside className="sidebar"><button className="brand" onClick={() => go("home")}><img src="/keepsake-logo-hd.png" alt="" /><span>Keepsake</span></button><p className="brand-tagline">Remember the people who matter.</p><nav>{navItems.map((item) => <button key={item.id} className={`${screen === item.id ? "active" : ""} ${item.id === "add" ? "sidebar-add" : ""}`} onClick={() => go(item.id)}><span>{item.icon}</span>{item.label}</button>)}</nav><div className="privacy-note"><span>♡</span><div><strong>Your space is private</strong><p>Built for your memories, not an audience.</p></div></div><button className="user-chip" onClick={() => go("settings")}><span className="initial-avatar">{user.name.charAt(0).toUpperCase()}</span><span><strong>{user.name}</strong><small>{plan === "pro" ? "Keepsake Pro" : "Free plan"}</small></span>{plan === "pro" ? <em className="pro-mini-badge">PRO</em> : <b>›</b>}</button><CreatorCredit compact /></aside>;
}

function passwordIssue(value: string) {
  if (value.length < 10) return "Use at least 10 characters.";
  if (!/[A-Z]/.test(value)) return "Add at least one uppercase letter.";
  if (!/[a-z]/.test(value)) return "Add at least one lowercase letter.";
  if (!/\d/.test(value)) return "Add at least one number.";
  if (!/[^A-Za-z0-9]/.test(value)) return "Add at least one special character.";
  if (/(.)\1\1/.test(value)) return "Avoid repeating the same character three times in a row.";
  return "";
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<"welcome" | "signin" | "signup" | "forgot">("welcome");
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const switchMode = (next: typeof mode) => { setMode(next); setError(""); setMessage(""); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError(""); setMessage("");
    if (!email.includes("@")) return setError("Enter a valid email address.");
    const normalizedEmail = email.trim().toLowerCase(); setBusy(true);
    try {
      if (mode === "forgot") {
        await sendPasswordResetEmail(auth, normalizedEmail);
        setMessage("If an account uses that address, a secure reset link is on its way.");
      } else if (mode === "signup") {
        if (!name.trim()) return setError("Tell us your name.");
        const issue = passwordIssue(password); if (issue) return setError(issue);
        const credential = await createUserWithEmailAndPassword(auth, normalizedEmail, password);
        await updateProfile(credential.user, { displayName: name.trim() });
        await sendEmailVerification(credential.user);
        onAuthenticated({ uid: credential.user.uid, name: name.trim(), email: normalizedEmail, plan: "free", emailVerified: false });
      } else {
        const credential = await signInWithEmailAndPassword(auth, normalizedEmail, password);
        const token = await getIdTokenResult(credential.user, true);
        onAuthenticated({ uid: credential.user.uid, name: credential.user.displayName || normalizedEmail.split("@")[0], email: normalizedEmail, plan: "free", admin: token.claims.admin === true, emailVerified: credential.user.emailVerified });
      }
    } catch (reason) {
      const code = typeof reason === "object" && reason && "code" in reason ? String(reason.code) : "";
      if (code.includes("email-already-in-use")) setError("An account with that email already exists.");
      else if (code.includes("invalid-credential")) setError("That email and password don’t match.");
      else if (code.includes("too-many-requests")) setError("Too many attempts. Wait a moment and try again.");
      else setError("We couldn’t connect to your account. Please try again.");
    } finally { setBusy(false); }
  };
  const formTitle = mode === "signup" ? "Create your account" : mode === "forgot" ? "Reset your password" : "Sign in";
  return <main className="auth-shell"><section className="auth-visual"><img src="/keepsake-logo-hd.png" alt="Keepsake" /><div><span>Private by design</span><h1>Remember the people<br />who matter most.</h1><p>A quiet place for their stories, favorite things, and moments you never want to lose.</p></div><footer><CreatorCredit /></footer></section><section className="auth-panel">{mode === "welcome" ? <div className="welcome-card"><span className="auth-kicker">Your memories, kept close</span><h2>Welcome to Keepsake</h2><p>Build a private collection of the details that make your people special.</p><button className="primary-btn auth-action" onClick={() => switchMode("signup")}>Create account</button><button className="secondary-btn auth-action" onClick={() => switchMode("signin")}>Sign in</button><small>Your account and memories are securely connected to Firebase.</small></div> : <div className="auth-form-wrap"><button className="auth-back" onClick={() => switchMode(mode === "forgot" ? "signin" : "welcome")}>← Back</button><span className="auth-kicker">{mode === "signup" ? "Begin your Keepsake" : mode === "forgot" ? "Account recovery" : "Welcome back"}</span><h2>{formTitle}</h2><p>{mode === "signup" ? "A private space for the people you love." : mode === "forgot" ? "We’ll send a secure reset link to your email." : "Your people and memories are waiting."}</p><form onSubmit={submit}>{mode === "signup" && <label><span>Your name</span><input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" placeholder="What should we call you?" /></label>}<label><span>Email</span><input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" placeholder="you@example.com" /></label>{mode !== "forgot" && <label><span>Password</span><input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholder={mode === "signup" ? "10+ characters" : "Your password"} /></label>}{mode === "signup" && <ul className="password-rules"><li className={password.length >= 10 ? "met" : ""}>10 characters</li><li className={/[A-Z]/.test(password) ? "met" : ""}>Uppercase</li><li className={/[a-z]/.test(password) ? "met" : ""}>Lowercase</li><li className={/\d/.test(password) ? "met" : ""}>Number</li><li className={/[^A-Za-z0-9]/.test(password) ? "met" : ""}>Special character</li><li className={password.length > 0 && !/(.)\1\1/.test(password) ? "met" : ""}>No triple repeats</li></ul>}{error && <p className="form-error" role="alert">{error}</p>}{message && <p className="form-success" role="status">{message}</p>}<button className="primary-btn auth-action" disabled={busy}>{busy ? "Just a moment…" : mode === "signup" ? "Create account" : mode === "forgot" ? "Send reset link" : "Sign in"}</button></form>{mode === "signin" && <button className="forgot-password" onClick={() => switchMode("forgot")}>Forgot password?</button>}{mode !== "forgot" && <button className="switch-auth" onClick={() => switchMode(mode === "signup" ? "signin" : "signup")}>{mode === "signup" ? "Already have an account? Sign in" : "New to Keepsake? Create an account"}</button>}</div>}</section></main>;
}

function VerifyEmailScreen({ user, verified, useAnotherAccount }: { user: AuthUser; verified: (user: AuthUser) => void; useAnotherAccount: () => void }) {
  const [message, setMessage] = useState("We sent a verification link to your email."); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [cooldown, setCooldown] = useState(0);
  useEffect(() => { if (!cooldown) return; const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000); return () => window.clearInterval(timer); }, [cooldown]);
  const check = async () => {
    if (!auth.currentUser) return useAnotherAccount(); setBusy(true); setError("");
    try { await reload(auth.currentUser); if (!auth.currentUser.emailVerified) return setError("That address is not verified yet. Open the email link, then try again."); const token = await getIdTokenResult(auth.currentUser, true); verified({ ...user, emailVerified: true, admin: token.claims.admin === true, plan: "free" }); } catch { setError("We couldn’t check your email status. Please try again."); } finally { setBusy(false); }
  };
  const resend = async () => {
    if (!auth.currentUser || cooldown) return; setBusy(true); setError("");
    try { await sendEmailVerification(auth.currentUser); setMessage("A new verification link was sent. Check your inbox and spam folder."); setCooldown(60); } catch { setError("We couldn’t resend the email yet. Wait a moment and try again."); } finally { setBusy(false); }
  };
  return <main className="verify-shell"><section className="verify-card"><img src="/keepsake-logo-hd.png" alt="Keepsake" /><span className="verify-icon">✉</span><p className="auth-kicker">One quick step</p><h1>Check your inbox</h1><p>Verify <strong>{user.email}</strong> before opening your private Keepsake.</p><div className="verify-message" role="status">{message}</div>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-btn auth-action" disabled={busy} onClick={check}>{busy ? "Checking…" : "I’ve verified my email"}</button><button className="secondary-btn auth-action" disabled={busy || cooldown > 0} onClick={resend}>{cooldown ? `Resend available in ${cooldown}s` : "Resend verification email"}</button><button className="switch-auth" onClick={useAnotherAccount}>Use another account</button><small>You may safely close this page after opening the verification link. Return here and select “I’ve verified my email.”</small></section></main>;
}

function Header({ title, eyebrow, action }: { title: string; eyebrow?: string; action?: React.ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1></div>{action}</header>;
}

function SectionTitle({ children, onSeeAll }: { children: React.ReactNode; onSeeAll?: () => void }) {
  return <div className="section-title"><h2>{children}</h2>{onSeeAll && <button onClick={onSeeAll}>See all <span>→</span></button>}</div>;
}

function StoryNote({ note, personName, updateNote, removeNote }: { note: KeepsakeNote; personName: string; updateNote: (id: string, title: string, body: string) => void; removeNote: (id: string) => void }) {
  const [editing, setEditing] = useState(false); const [title, setTitle] = useState(note.title); const [body, setBody] = useState(note.body);
  const save = (event: React.FormEvent) => { event.preventDefault(); if (!title.trim() || !body.trim()) return; updateNote(note.id, title.trim(), body.trim()); setEditing(false); };
  return <article>{editing ? <form className="story-note-edit" onSubmit={save}><label><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label><span>Note</span><textarea value={body} onChange={(event) => setBody(event.target.value)} /></label><div><button type="button" className="secondary-btn" onClick={() => { setTitle(note.title); setBody(note.body); setEditing(false); }}>Cancel</button><button className="primary-btn">Save changes</button></div></form> : <><div className="story-date"><span>♥</span><small>{note.createdAt}</small></div><div><h3>{note.title}</h3><p>{note.body}</p><small>Saved in {personName}’s Keepsake</small></div><div className="note-actions"><button onClick={() => setEditing(true)}>Edit</button><button className="delete-note" onClick={() => removeNote(note.id)} aria-label={`Delete ${note.title}`}>×</button></div></>}</article>;
}

function FavoritesSection({ person, updatePersonDetails }: { person: Person; updatePersonDetails: (updates: Partial<Person>) => void }) {
  const favorites = person.favorites ?? []; const [label, setLabel] = useState(""); const [value, setValue] = useState(""); const [editingId, setEditingId] = useState("");
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (!label.trim() || !value.trim()) return; const next = editingId ? favorites.map((item) => item.id === editingId ? { ...item, label: label.trim(), value: value.trim() } : item) : [...favorites, { id: crypto.randomUUID(), label: label.trim(), value: value.trim() }]; updatePersonDetails({ favorites: next }); setLabel(""); setValue(""); setEditingId(""); };
  return <section className="favorites-section"><SectionTitle>Favorites & helpful details</SectionTitle>{favorites.length > 0 && <div className="favorites-grid">{favorites.map((item) => <article key={item.id}><div><small>{item.label}</small><strong>{item.value}</strong></div><button onClick={() => { setEditingId(item.id); setLabel(item.label); setValue(item.value); }}>Edit</button><button aria-label={`Delete ${item.label}`} onClick={() => updatePersonDetails({ favorites: favorites.filter((favorite) => favorite.id !== item.id) })}>×</button></article>)}</div>}<form className="favorite-form" onSubmit={submit}><label><span>Detail</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Favorite food, Gift idea, Clothing size…" /></label><label><span>Value</span><input value={value} onChange={(event) => setValue(event.target.value)} placeholder="What should you remember?" /></label><button className="secondary-btn">{editingId ? "Save favorite" : "＋ Add detail"}</button>{editingId && <button type="button" className="text-button" onClick={() => { setEditingId(""); setLabel(""); setValue(""); }}>Cancel</button>}</form></section>;
}

function MediaCard({ item, updateMedia, deleteMediaItem }: { item: MediaItem; updateMedia: (id: string, updates: { name?: string; caption?: string; takenAt?: string }) => void; deleteMediaItem: (id: string) => void }) {
  const [editing, setEditing] = useState(false); const [open, setOpen] = useState(false); const [name, setName] = useState(item.name); const [caption, setCaption] = useState(item.caption ?? ""); const [takenAt, setTakenAt] = useState(item.takenAt ?? item.createdAt?.slice(0, 10) ?? "");
  const visual = item.type === "photo" ? <img src={item.url} alt={item.caption || item.name} loading="lazy" /> : item.type === "video" ? <video src={item.url} controls preload="metadata" /> : <div className="audio-memory"><span>♬</span><audio src={item.url} controls preload="metadata" /></div>;
  return <><article><button className="media-preview" onClick={() => setOpen(true)} aria-label={`Open ${item.caption || item.name}`}>{visual}</button><span><strong>{item.caption || item.name}</strong><small>{takenAt ? displayDate(takenAt) : item.duration ? `${Math.ceil(item.duration)} seconds` : `${Math.max(1, Math.ceil(item.size / 1024 / 1024))} MB`}</small>{editing && <div className="media-editor"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="File name" /><input value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="Caption" /><input type="date" value={takenAt} onChange={(event) => setTakenAt(event.target.value)} /></div>}</span><div className="media-actions"><button onClick={() => { if (editing) updateMedia(item.id, { name: name.trim() || item.name, caption: caption.trim(), takenAt }); setEditing(!editing); }}>{editing ? "Save" : "Edit"}</button><button onClick={() => deleteMediaItem(item.id)} aria-label={`Delete ${item.name}`}>×</button></div></article>{open && <div className="media-lightbox" role="dialog" aria-modal="true" aria-label={item.caption || item.name} onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}><button onClick={() => setOpen(false)} aria-label="Close media viewer">×</button><div>{item.type === "photo" ? <img src={item.url} alt={item.caption || item.name} /> : item.type === "video" ? <video src={item.url} controls autoPlay /> : <audio src={item.url} controls autoPlay />}<h2>{item.caption || item.name}</h2>{takenAt && <p>{displayDate(takenAt)}</p>}</div></div>}</>;
}

function OnboardingCard({ user, people, notes, media, reminders, go }: { user: AuthUser; people: Person[]; notes: KeepsakeNote[]; media: MediaItem[]; reminders: ReminderSettings; go: (screen: Screen) => void }) {
  const storageKey = `keepsake-onboarding-dismissed:${user.uid}`; const [dismissed, setDismissed] = useState(false);
  useEffect(() => setDismissed(localStorage.getItem(storageKey) === "true"), [storageKey]);
  const first = people[0]; const steps = [
    { label: "Add your first person", done: people.length > 0, action: () => go("personForm") },
    { label: "Add their portrait", done: Boolean(first?.image), action: () => first && go("people") },
    { label: "Save an important detail", done: Boolean(first?.favorites?.length || first?.birthday), action: () => first && go("people") },
    { label: "Add a memory", done: notes.length > 0 || media.some((item) => !["profile", "cover"].includes(item.type)), action: () => go(people.length ? "people" : "personForm") },
    { label: "Enable reminders", done: reminders.enabled, action: () => go("settings") },
  ];
  const complete = steps.filter((step) => step.done).length; if (dismissed || complete === steps.length) return null;
  return <section className="onboarding-card"><div><p className="eyebrow">Getting started</p><h2>Make Keepsake yours</h2><p>{complete} of {steps.length} steps complete</p></div><div className="onboarding-progress"><span style={{ width: `${complete / steps.length * 100}%` }} /></div><div className="onboarding-steps">{steps.map((step) => <button key={step.label} className={step.done ? "done" : ""} onClick={step.action} disabled={step.done}><span>{step.done ? "✓" : "○"}</span>{step.label}</button>)}</div><button className="onboarding-dismiss" onClick={() => { localStorage.setItem(storageKey, "true"); setDismissed(true); }}>Hide checklist</button></section>;
}

function MilestonesSection({ person, updatePersonDetails }: { person: Person; updatePersonDetails: (updates: Partial<Person>) => void }) {
  const milestones = person.milestones ?? []; const [adding, setAdding] = useState(false); const [kind, setKind] = useState("Milestone"); const [title, setTitle] = useState(""); const [date, setDate] = useState(""); const [details, setDetails] = useState("");
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (!title.trim() || !date) return; updatePersonDetails({ milestones: [...milestones, { id: crypto.randomUUID(), kind, title: title.trim(), date, details: details.trim() }].sort((a, b) => b.date.localeCompare(a.date)) }); setTitle(""); setDate(""); setDetails(""); setAdding(false); };
  return <section className="milestones-section"><div className="section-title"><h2>Dates & milestones</h2><button className="inline-edit-details" onClick={() => setAdding((value) => !value)}>{adding ? "Cancel" : "＋ Add date"}</button></div>{adding && <form className="milestone-form" onSubmit={submit}><label><span>Type</span><select value={kind} onChange={(event) => setKind(event.target.value)}>{["Milestone", "Graduation", "Wedding", "First day of school", "New job", "Achievement", "Tradition", "Memorial date", "Custom"].map((option) => <option key={option}>{option}</option>)}</select></label><label><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What happened?" /></label><label><span>Date</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><label className="milestone-details"><span>Details</span><input value={details} onChange={(event) => setDetails(event.target.value)} placeholder="Optional context" /></label><button className="primary-btn">Save milestone</button></form>}{milestones.length ? <div className="milestone-list">{milestones.map((item) => <article key={item.id}><span>▦</span><div><small>{item.kind} · {displayDate(item.date)}</small><strong>{item.title}</strong>{item.details && <p>{item.details}</p>}</div><button onClick={() => updatePersonDetails({ milestones: milestones.filter((milestone) => milestone.id !== item.id) })} aria-label={`Delete ${item.title}`}>×</button></article>)}</div> : <p className="milestone-empty">Add the days and achievements you want to remember.</p>}</section>;
}

const CAPTURE_PROMPTS = ["What made you smile today?", "Did someone say something worth remembering?", "What is one detail you learned about someone you love?", "What ordinary moment would you miss someday?"];

function QuickCapture({ open, close, saveText, saveVoice }: { open: boolean; close: () => void; saveText: (title: string, body: string) => void; saveVoice: (file: File) => Promise<string | null> }) {
  const [title, setTitle] = useState(""); const [body, setBody] = useState(""); const [recording, setRecording] = useState(false); const [message, setMessage] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null); const chunksRef = useRef<Blob[]>([]);
  useEffect(() => { if (!open && recording) recorderRef.current?.stop(); }, [open, recording]);
  if (!open) return null;
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (!title.trim() && !body.trim()) return; saveText(title.trim() || "A thought to remember", body.trim()); setTitle(""); setBody(""); setMessage(""); close(); };
  const toggleRecording = async () => { if (recording) { recorderRef.current?.stop(); return; } try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); chunksRef.current = []; const recorder = new MediaRecorder(stream); recorderRef.current = recorder; recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); }; recorder.onstop = async () => { stream.getTracks().forEach((track) => track.stop()); setRecording(false); const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" }); const file = new File([blob], `Inbox voice note ${Date.now()}.webm`, { type: blob.type }); const error = await saveVoice(file); setMessage(error ?? "Voice note saved to your Inbox."); }; recorder.start(); setRecording(true); setMessage("Recording… tap again when you’re finished."); } catch { setMessage("Microphone access wasn’t available."); } };
  return <div className="capture-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="quick-capture" role="dialog" aria-modal="true" aria-labelledby="capture-title"><button className="capture-close" onClick={close} aria-label="Close quick capture">×</button><p className="eyebrow">Capture now · organize later</p><h2 id="capture-title">Save a thought</h2><p>{CAPTURE_PROMPTS[new Date().getDate() % CAPTURE_PROMPTS.length]}</p><form onSubmit={submit}><label><span>Short title</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What happened?" /></label><label><span>Your note</span><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Write it before the moment slips away…" /></label><div className="capture-actions"><button type="button" className={`voice-capture ${recording ? "recording" : ""}`} onClick={toggleRecording}><span>●</span>{recording ? "Stop recording" : "Record instead"}</button><button className="primary-btn">Save to Inbox</button></div>{message && <small className="capture-message" role="status">{message}</small>}</form></section></div>;
}

function Inbox({ items, people, media, assign, remove, edit, openCapture }: { items: InboxItem[]; people: Person[]; media: MediaItem[]; assign: (item: InboxItem, personId: number) => void; remove: (id: string) => void; edit: (id: string, title: string, body: string) => void; openCapture: () => void }) {
  return <div className="page inbox-page"><Header eyebrow="Capture now · organize later" title="Quick Notes" action={<button className="primary-btn compact" onClick={openCapture}>＋ Save a thought</button>} /><p className="page-intro">Unsorted thoughts and voice notes can stay here until you know where they belong.</p>{items.length ? <div className="inbox-list">{items.map((item) => { const audio = item.mediaId ? media.find((entry) => entry.id === item.mediaId) : undefined; return <InboxCard key={item.id} item={item} audio={audio} people={people} assign={assign} remove={remove} edit={edit} />; })}</div> : <div className="people-empty inbox-empty"><span>▤</span><h2>Nothing waiting to be organized.</h2><p>Save any passing thought here. You can connect it to someone later.</p><button className="primary-btn" onClick={openCapture}>＋ Save your first thought</button></div>}</div>;
}

function InboxCard({ item, audio, people, assign, remove, edit }: { item: InboxItem; audio?: MediaItem; people: Person[]; assign: (item: InboxItem, personId: number) => void; remove: (id: string) => void; edit: (id: string, title: string, body: string) => void }) {
  const [editing, setEditing] = useState(false); const [title, setTitle] = useState(item.title); const [body, setBody] = useState(item.body); const [personId, setPersonId] = useState("");
  return <article className="inbox-card"><div className="inbox-card-head"><span>{audio ? "♬" : "▤"}</span><div><small>{item.createdAt}</small>{editing ? <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Note title" /> : <h2>{item.title}</h2>}</div></div>{editing ? <textarea value={body} onChange={(event) => setBody(event.target.value)} aria-label="Note text" /> : item.body && <p>{item.body}</p>}{audio && <audio src={audio.url} controls preload="metadata" />}<div className="inbox-card-actions"><label><span>Connect to</span><select value={personId} onChange={(event) => setPersonId(event.target.value)}><option value="">Choose a person…</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><button className="secondary-btn" disabled={!personId} onClick={() => assign(item, Number(personId))}>Add to their story</button><button className="text-button" onClick={() => { if (editing) edit(item.id, title.trim() || item.title, body.trim()); setEditing(!editing); }}>{editing ? "Save" : "Edit"}</button><button className="text-button destructive" onClick={() => remove(item.id)}>Delete</button></div></article>;
}

function upcomingEvents(people: Person[], limit?: number) {
  const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const events = people.flatMap((person) => [...[["Birthday", person.birthday], ["Anniversary", person.anniversary ?? ""]].filter(([, date]) => date).map(([kind, date]) => { const parsed = new Date(`${dateInputValue(date)}T00:00:00`); const next = new Date(now.getFullYear(), parsed.getMonth(), parsed.getDate()); if (next < today) next.setFullYear(now.getFullYear() + 1); return { person, kind, date: next, days: Math.ceil((next.getTime() - today.getTime()) / 86400000) }; }), ...(person.milestones ?? []).map((milestone) => { const date = new Date(`${milestone.date}T00:00:00`); return { person, kind: milestone.title, date, days: Math.ceil((date.getTime() - today.getTime()) / 86400000) }; }).filter((event) => event.days >= 0)]).sort((a, b) => a.days - b.days);
  return typeof limit === "number" ? events.slice(0, limit) : events;
}

function Alerts({ people, inbox, reminders, go, select }: { people: Person[]; inbox: InboxItem[]; reminders: ReminderSettings; go: (screen: Screen) => void; select: (person: Person) => void }) {
  const upcoming = upcomingEvents(people).filter((event) => event.days <= 30);
  return <div className="page alerts-page"><Header eyebrow="Updates & reminders" title="Alerts" /><div className="alerts-list">{reminders.prompts && <article className="alert-card prompt-alert"><span>✦</span><div><strong>A gentle prompt</strong><p>{CAPTURE_PROMPTS[new Date().getDate() % CAPTURE_PROMPTS.length]}</p></div></article>}{inbox.length > 0 && <button className="alert-card" onClick={() => go("inbox")}><span className="alert-count">{inbox.length}</span><div><strong>{inbox.length === 1 ? "Quick Note is" : "Quick Notes are"} waiting</strong><p>Organize {inbox.length === 1 ? "it" : "them"} whenever you’re ready.</p></div><b>›</b></button>}{upcoming.map((event) => <button className="alert-card" key={`${event.person.id}-${event.kind}`} onClick={() => select(event.person)}><span>{event.kind === "Birthday" ? "♨" : "♥"}</span><div><strong>{event.person.name}’s {event.kind.toLowerCase()}</strong><p>{event.days === 0 ? "Today" : event.days === 1 ? "Tomorrow" : `In ${event.days} days`}</p></div><b>›</b></button>)}{!inbox.length && !upcoming.length && !reminders.prompts && <div className="people-empty"><span>✓</span><h2>You’re all caught up.</h2><p>New reminders and Quick Notes will appear here.</p></div>}</div></div>;
}

function Home({ go, select, user, people, notes, media, inbox, openCapture, reminders }: { go: (s: Screen) => void; select: (p: Person) => void; user: AuthUser; people: Person[]; notes: KeepsakeNote[]; media: MediaItem[]; inbox: InboxItem[]; openCapture: () => void; reminders: ReminderSettings }) {
  const now = new Date(); const greeting = now.getHours() < 12 ? "Good morning" : now.getHours() < 18 ? "Good afternoon" : "Good evening"; const todayLabel = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(now);
  const [showNotifications, setShowNotifications] = useState(false);
  const upcoming = upcomingEvents(people, 3);
  const recentNotes = notes.slice(0, 3);
  const homeAlertCount = inbox.length + upcoming.filter((event) => event.days <= 30).length;
  return <div className="page home-page"><Header eyebrow={todayLabel} title={`${greeting}, ${user.name} 👋`} action={<div className="home-header-actions"><div className="notification-wrap"><button className="icon-btn" aria-label={homeAlertCount ? `Notifications, ${homeAlertCount} new` : "Notifications"} aria-expanded={showNotifications} aria-describedby="notifications-tooltip" onClick={() => setShowNotifications((value) => !value)}>🔔{homeAlertCount > 0 && <i className="header-alert-badge" aria-hidden="true">{Math.min(homeAlertCount, 99)}</i>}<span className="button-tooltip" id="notifications-tooltip" role="tooltip">Notifications</span></button>{showNotifications && <div className="notification-panel"><strong>Gentle reminders</strong>{reminders.prompts && <p>“{CAPTURE_PROMPTS[now.getDate() % CAPTURE_PROMPTS.length]}”</p>}{inbox.length > 0 && <button onClick={() => go("inbox")}><span>{inbox.length}</span> {inbox.length === 1 ? "thought is" : "thoughts are"} waiting in Quick Notes</button>}{upcoming.slice(0, 2).map((event) => <button key={`${event.person.id}-${event.kind}`} onClick={() => select(event.person)}>{event.person.name}’s {event.kind.toLowerCase()} is {event.days === 0 ? "today" : event.days === 1 ? "tomorrow" : `in ${event.days} days`}</button>)}{!inbox.length && !upcoming.length && <small>You’re all caught up.</small>}</div>}</div><button className="icon-btn" aria-label="Settings" onClick={() => go("settings")}>⚙<span className="button-tooltip" role="tooltip">Settings</span></button></div>} />
    <OnboardingCard user={user} people={people} notes={notes} media={media} reminders={reminders} go={go} />
    <section className="hero-card"><div><span className="hero-kicker">Your private place to remember</span><h2>{people.length ? "Capture the things you never want to forget." : "Begin with someone who matters."}</h2><p>{people.length ? "A laugh, a favorite thing, or the story behind a photo—it all belongs here." : "Create their page, then fill it with the little details and moments that make them special."}</p><div className="hero-actions"><button className="primary-btn" onClick={openCapture}><span>＋</span>Save a thought</button><button className="secondary-btn" onClick={() => go(people.length ? "add" : "personForm")}>{people.length ? "Add media" : "Add your first person"}</button></div></div><div className="hero-photo empty-hero"><img src="/keepsake-logo-hd.png" alt="Keepsake" /></div></section>
    {inbox.length > 0 && <button className="inbox-banner" onClick={() => go("inbox")}><span>▤</span><div><strong>{inbox.length} {inbox.length === 1 ? "thought" : "thoughts"} waiting in Quick Notes</strong><small>Organize them whenever you’re ready.</small></div><b>View notes →</b></button>}
    <div className="dashboard-grid"><section><SectionTitle>Coming up</SectionTitle>{upcoming.length ? <div className="upcoming-list">{upcoming.map((event) => <article key={`${event.person.id}-${event.kind}`}><span className="event-icon coral">{event.kind === "Birthday" ? "♨" : "♥"}</span><div><strong>{event.person.name}’s {event.kind.toLowerCase()}</strong><p>{displayDate(event.date.toISOString().slice(0, 10))}</p></div><span className="date-pill">{event.days === 0 ? "Today" : event.days === 1 ? "Tomorrow" : `${event.days} days`}</span></article>)}</div> : <div className="dashboard-empty"><span>▦</span><strong>No important dates yet</strong><p>Birthdays and special dates will appear here.</p></div>}</section>
      <section><SectionTitle>Recent memories</SectionTitle>{recentNotes.length || media.some((item) => item.type !== "profile" && item.type !== "cover") ? <div className="memory-list">{recentNotes.map((note) => { const person = people.find((item) => item.id === note.personId); return <button key={note.id} onClick={() => person && select(person)}><span className="memory-type yellow">▤</span><span><strong>{note.title}</strong><small>{person?.name ?? "Keepsake"} · Note</small></span><b>›</b></button>; })}{media.filter((item) => item.type !== "profile" && item.type !== "cover").slice(-Math.max(0, 3 - recentNotes.length)).reverse().map((item) => { const person = people.find((entry) => entry.id === item.personId); return <button key={item.id} onClick={() => person && select(person)}><span className={`memory-type ${item.type === "photo" ? "green" : item.type === "video" ? "purple" : "pink"}`}>{item.type === "photo" ? "▣" : item.type === "video" ? "▰" : "♬"}</span><span><strong>{item.caption || item.name}</strong><small>{person?.name ?? "Keepsake"} · {item.type}</small></span><b>›</b></button>; })}</div> : <div className="dashboard-empty"><span>♡</span><strong>No memories yet</strong><p>Your newest notes and moments will appear here.</p></div>}</section></div>
    <section><SectionTitle onSeeAll={() => go("people")}>Your people</SectionTitle><div className="people-strip">{people.map((p) => <button key={p.id} onClick={() => select(p)}><Avatar person={p} /><strong>{p.name}</strong><small>{p.relationship}</small></button>)}<button className="add-person-small" onClick={() => go("personForm")}><span>＋</span><strong>Add person</strong><small>Someone special</small></button></div></section>
  </div>;
}

function People({ select, go, people, plan }: { select: (p: Person) => void; go: (s: Screen) => void; people: Person[]; plan: Plan }) {
  const limits = getPlanLimits(plan); const canAdd = canCreatePerson(plan, people.length);
  return <div className="page"><Header eyebrow="Your circle" title="People" action={<button className="primary-btn compact" onClick={() => go(canAdd ? "personForm" : "settings")}><span>{canAdd ? "＋" : "✦"}</span>{canAdd ? "Add person" : "View Pro"}</button>} /><div className="people-plan-summary"><p className="page-intro">The people who matter most, all in one place.</p><span className={canAdd ? "" : "at-limit"}>{plan === "pro" ? `${people.length} people · Unlimited with Pro` : `${people.length} of ${limits.people} Free people used`}</span></div>{!canAdd && <div className="plan-limit-notice"><span>✦</span><div><strong>Your four Free people are safe.</strong><p>You can keep viewing and editing everyone. Upgrade to Pro to add unlimited people, or remove a profile to free a place.</p></div><button className="secondary-btn" onClick={() => go("settings")}>See Pro</button></div>}{people.length ? <div className="people-grid">{people.map((p) => <button className="person-card" key={p.id} onClick={() => select(p)}><div className="person-image-wrap">{p.image ? <img src={p.image} alt={p.name} /> : <span className="person-placeholder">{getInitials(p.name)}</span>}<span className="relationship-badge">{p.relationship}</span></div><div><h2>{p.name}</h2><p>{p.relationship}{calculateAge(p.birthday) ? ` · ${calculateAge(p.birthday)}` : ""}</p><small>{p.birthday ? `Birthday · ${displayDate(p.birthday)}` : "No birthday added"}</small></div><b>→</b></button>)}</div> : <div className="people-empty"><span>♡</span><h2>The people who matter most, all in one place.</h2><p>Add your first person to begin preserving their favorite things, important dates, and everyday moments.</p><button className="primary-btn" onClick={() => go("personForm")}>＋ Add your first person</button></div>}{people.length > 0 && <button className={`wide-add ${canAdd ? "" : "limit-reached"}`} onClick={() => go(canAdd ? "personForm" : "settings")}><span>{canAdd ? "＋" : "✦"}</span><span><strong>{canAdd ? "Add someone special" : "Free limit reached"}</strong><small>{canAdd ? "Create a new Keepsake page" : "Pro includes unlimited people"}</small></span><b>→</b></button>}</div>;
}

function Profile({ person, go, media, notes, addNote, updateNote, removeNote, updateProfilePhoto, updateCoverPhoto, updatePersonDetails, deletePerson, deleteMediaItem, updateMediaDetails }: { person: Person; go: (s: Screen) => void; media: MediaItem[]; notes: KeepsakeNote[]; addNote: (title: string, body: string) => void; updateNote: (id: string, title: string, body: string) => void; removeNote: (id: string) => void; updateProfilePhoto: (file: File) => Promise<string | null>; updateCoverPhoto: (file: File, onProgress?: (percent: number) => void) => Promise<string | null>; updatePersonDetails: (updates: Partial<Person>) => void; deletePerson: () => void; deleteMediaItem: (id: string) => void; updateMediaDetails: (id: string, updates: { name?: string; caption?: string; takenAt?: string }) => void }) {
  const facts = [["Birthday", displayDate(person.birthday), "♨"], ["Age", calculateAge(person.birthday), "✦"], ["Relationship", person.relationship, "♡"], ["Anniversary", displayDate(person.anniversary ?? ""), "♥"], ["Favorite color", person.color, "●"]].filter(([, value]) => value);
  const personMedia = media.filter((item) => item.personId === person.id && item.type !== "profile" && item.type !== "cover"); const photos = personMedia.filter((item) => item.type === "photo"); const videos = personMedia.filter((item) => item.type === "video"); const voices = personMedia.filter((item) => item.type === "voice");
  const personNotes = notes.filter((note) => note.personId === person.id); const [composing, setComposing] = useState(false); const [noteTitle, setNoteTitle] = useState(""); const [noteBody, setNoteBody] = useState("");
  const [photoMessage, setPhotoMessage] = useState(""); const [photoBusy, setPhotoBusy] = useState(false); const [coverBusy, setCoverBusy] = useState(false); const [coverProgress, setCoverProgress] = useState(0);
  const [editingDetails, setEditingDetails] = useState(false); const [editBirthday, setEditBirthday] = useState(dateInputValue(person.birthday)); const [editAnniversary, setEditAnniversary] = useState(dateInputValue(person.anniversary ?? "")); const [editRelationship, setEditRelationship] = useState(person.relationship); const [editColor, setEditColor] = useState(person.color);
  const saveStoryNote = (event: React.FormEvent) => { event.preventDefault(); if (!noteTitle.trim() || !noteBody.trim()) return; addNote(noteTitle.trim(), noteBody.trim()); setNoteTitle(""); setNoteBody(""); setComposing(false); };
  const chooseProfilePhoto = () => { const input = document.createElement("input"); input.type = "file"; input.accept = "image/jpeg,image/png,image/webp,image/heic"; input.onchange = async () => { const file = input.files?.[0]; if (!file) return; setPhotoBusy(true); const error = await updateProfilePhoto(file); setPhotoBusy(false); setPhotoMessage(error ?? "Profile picture updated."); }; input.click(); };
  const chooseCoverPhoto = () => { if (coverBusy) return; const input = document.createElement("input"); input.type = "file"; input.accept = "image/jpeg,image/png,image/webp,image/heic"; input.onchange = async () => { const file = input.files?.[0]; if (!file) return; setCoverBusy(true); setCoverProgress(0); setPhotoMessage("Preparing cover photo…"); const error = await updateCoverPhoto(file, setCoverProgress); setCoverBusy(false); setPhotoMessage(error ?? "Cover photo updated."); }; input.click(); };
  const saveDetails = (event: React.FormEvent) => { event.preventDefault(); updatePersonDetails({ birthday: editBirthday, anniversary: editAnniversary, relationship: editRelationship.trim() || "Someone special", color: editColor.trim() }); setEditingDetails(false); };
  return <div className="page profile-page"><div className="profile-top-actions"><button className="back-btn" onClick={() => go("people")}>← <span>People</span></button><button className="delete-person-btn" onClick={deletePerson}>Delete person</button></div><section className="profile-hero"><img className="cover" src={person.cover || "/keepsake-logo-hd.png"} alt={`${person.name}'s cover`} /><div className="profile-shade" /><div className="profile-identity"><button className="profile-avatar-upload" onClick={chooseProfilePhoto} disabled={photoBusy} aria-label={`Upload a profile picture for ${person.name}`}><Avatar person={person} size="lg" /><span className="profile-photo-edit">{photoBusy ? "…" : "✎"}</span></button><div><p>{person.relationship}</p><h1>{person.name}<span>♥</span></h1><small>{photoMessage || "Click the portrait to add or change their photo."}</small></div></div><div className="profile-hero-actions"><button onClick={chooseCoverPhoto} disabled={coverBusy} aria-label={coverBusy ? `Uploading cover photo, ${coverProgress}%` : "Choose cover photo"}>▣ <span>{coverBusy ? `${coverProgress}%` : "Cover photo"}</span></button><button onClick={() => go("personForm")}>✎ <span>Edit profile</span></button></div>{coverBusy && <div className="cover-upload-progress" role="status"><i style={{ width: `${coverProgress}%` }} /></div>}</section>
    <div className="details-section"><div className="section-title"><h2>At a glance</h2><button className="inline-edit-details" onClick={() => setEditingDetails((value) => !value)}>{editingDetails ? "Cancel" : "✎ Edit details"}</button></div>{editingDetails ? <form className="inline-details-form" onSubmit={saveDetails}><label><span>Birthday</span><input type="date" value={editBirthday} onChange={(event) => setEditBirthday(event.target.value)} /></label><label><span>Anniversary or special date</span><input type="date" value={editAnniversary} onChange={(event) => setEditAnniversary(event.target.value)} /></label><label><span>Relationship</span><input value={editRelationship} onChange={(event) => setEditRelationship(event.target.value)} placeholder="How you know them" /></label><label><span>Favorite color</span><input value={editColor} onChange={(event) => setEditColor(event.target.value)} placeholder="Optional" /></label><div><button type="button" className="secondary-btn" onClick={() => setEditingDetails(false)}>Cancel</button><button className="primary-btn">Save details</button></div></form> : <div className="facts-grid">{facts.map(([label, value, icon]) => <button className="editable-fact" key={label} onClick={() => setEditingDetails(true)}><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div><b>✎</b></button>)}</div>}</div>
    {person.about && <section className="about-person"><SectionTitle>About {person.name}</SectionTitle><p>{person.about}</p></section>}<FavoritesSection person={person} updatePersonDetails={updatePersonDetails} /><MilestonesSection person={person} updatePersonDetails={updatePersonDetails} /><section><SectionTitle onSeeAll={() => go("add")}>Memories</SectionTitle><div className="memory-category-grid media-only"><button onClick={() => go("add")}><span className="green">▣</span><strong>Photos</strong><small>{photos.length ? `${photos.length} saved` : "No photos yet"}</small></button><button onClick={() => go("add")}><span className="purple">▰</span><strong>Videos</strong><small>{videos.length ? `${videos.length} saved` : "No videos yet"}</small></button><button onClick={() => go("add")}><span className="pink">♬</span><strong>Voice</strong><small>{voices.length ? `${voices.length} saved` : "No recordings yet"}</small></button></div>{personMedia.length > 0 && <div className="media-gallery">{personMedia.map((item) => <MediaCard key={item.id} item={item} updateMedia={updateMediaDetails} deleteMediaItem={deleteMediaItem} />)}</div>}</section>
    <section className="story-section"><div className="section-title"><div><p className="eyebrow">Notes & moments</p><h2>Their story</h2></div><button className="story-add" onClick={() => setComposing((value) => !value)}>{composing ? "Cancel" : "＋ Add a note"}</button></div>{composing && <form className="note-composer story-composer" onSubmit={saveStoryNote}><label><span>Title</span><input autoFocus value={noteTitle} onChange={(event) => setNoteTitle(event.target.value)} placeholder="What happened?" /></label><label><span>Note</span><textarea value={noteBody} onChange={(event) => setNoteBody(event.target.value)} placeholder={`Write something about ${person.name}…`} /></label><div><button type="button" className="secondary-btn" onClick={() => setComposing(false)}>Cancel</button><button className="primary-btn">Save to their story</button></div></form>}{personNotes.length ? <div className="story-notes">{personNotes.map((note) => <StoryNote key={note.id} note={note} personName={person.name} updateNote={updateNote} removeNote={removeNote} />)}</div> : <div className="story-empty"><span>✦</span><strong>Start {person.name}’s story.</strong><p>Notes and milestones will form a timeline here.</p><button className="primary-btn" onClick={() => setComposing(true)}>＋ Add the first note</button></div>}</section>
  </div>;
}

function AddMemory({ person, people, selectPerson, go, media, uploadMedia, plan }: { person: Person; people: Person[]; selectPerson: (person: Person) => void; go: (s: Screen) => void; media: MediaItem[]; uploadMedia: (file: File, type: UploadType, onProgress?: (percent: number) => void) => Promise<string | null>; plan: Plan }) {
  const actions = [["Photo", "Choose one or more photos from your library", "▣", "green"], ["Voice recording", "Keep their voice close", "♬", "pink"], ["Note", "A story or little detail", "▤", "yellow"], ["Video", "A moment in motion", "▰", "purple"], ["Favorite", "Something they love", "★", "orange"], ["Special date", "A day worth remembering", "▦", "blue"]];
  const [uploading, setUploading] = useState(false); const [progress, setProgress] = useState(0); const [message, setMessage] = useState(""); const [retry, setRetry] = useState<{ files: File[]; type: UploadType } | null>(null);
  const [recording, setRecording] = useState(false); const recorderRef = useRef<MediaRecorder | null>(null); const chunksRef = useRef<Blob[]>([]);
  const limits = getPlanLimits(plan);
  const photos = media.filter((item) => item.personId === person.id && item.type === "photo").length; const videos = media.filter((item) => item.personId === person.id && item.type === "video").length; const voices = media.filter((item) => item.personId === person.id && item.type === "voice").length;
  const uploadLock = useRef(false);
  const runUploads = async (files: File[], type: UploadType) => {
    if (!files.length || uploadLock.current) return;
    uploadLock.current = true;
    setUploading(true); setProgress(0); setMessage(""); setRetry(null);
    const countedMedia = [...media];
    const failed: File[] = [];
    let saved = 0;
    let firstError = "";
    try {
      for (const [index, file] of files.entries()) {
        setMessage(`Uploading ${type === "photo" ? "photo" : "file"} ${index + 1} of ${files.length}: ${file.name}`);
        let error = mediaAllowanceError(plan, countedMedia, person.id, type, file.size);
        if (!error) {
          try {
            error = await uploadMedia(file, type, (percent) => setProgress(Math.round((index * 100 + percent) / files.length)));
          } catch {
            error = "Check your connection and try again.";
          }
        }
        if (error) { failed.push(file); firstError ||= error; }
        else {
          saved++;
          countedMedia.push({ id: `batch-${index}`, personId: person.id, type, size: file.size, name: file.name, url: "" });
        }
        setProgress(Math.round(((index + 1) / files.length) * 100));
      }
      const label = type === "photo" ? (saved === 1 ? "photo" : "photos") : type === "video" ? (saved === 1 ? "video" : "videos") : (saved === 1 ? "voice recording" : "voice recordings");
      setMessage(`${saved} ${label} saved to ${person.name}’s Keepsake.${failed.length ? ` ${failed.length} could not be saved. ${firstError}` : ""}`);
      setRetry(failed.length ? { files: failed, type } : null);
    } finally {
      uploadLock.current = false;
      setUploading(false);
    }
  };
  const runUpload = (file: File, type: UploadType) => runUploads([file], type);
  const choose = (type: UploadType) => {
    if (uploadLock.current) return;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = type === "photo";
    input.accept = type === "photo" ? "image/jpeg,image/png,image/webp,image/heic" : type === "video" ? "video/mp4,video/webm,video/quicktime" : "audio/mpeg,audio/mp4,audio/wav,audio/webm,audio/ogg,audio/x-m4a";
    input.onchange = async () => { await runUploads(Array.from(input.files ?? []), type); };
    input.click();
  };
  const toggleRecording = async () => { if (recording) { recorderRef.current?.stop(); return; } try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); chunksRef.current = []; const recorder = new MediaRecorder(stream); recorderRef.current = recorder; recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); }; recorder.onstop = async () => { stream.getTracks().forEach((track) => track.stop()); setRecording(false); const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" }); const file = new File([blob], `Voice recording ${new Date().toLocaleDateString()}.webm`, { type: blob.type }); await runUpload(file, "voice"); }; recorder.start(); setRecording(true); setMessage("Recording… select Stop recording when you’re finished."); } catch { setMessage("Microphone access wasn’t available. You can upload an audio file instead."); } };
  return <div className="page add-page"><button className="close-btn" onClick={() => go("home")}>×</button><div className="add-heading"><p>Save something special</p><h1>What do you want to remember?</h1><label className="memory-person-select"><span>We’ll add it to</span><span className="memory-person-control"><Avatar person={person} size="sm" /><select disabled={uploading || recording} value={person.id} onChange={(event) => { const nextPerson = people.find((entry) => entry.id === Number(event.target.value)); if (nextPerson) selectPerson(nextPerson); }} aria-label="Choose whose Keepsake receives this memory">{people.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} — {entry.relationship}</option>)}</select></span></label></div><div className="media-allowance"><span><strong>{photos} / {limits.photosPerPerson}</strong> photos</span><span><strong>{videos} / {limits.videosPerPerson}</strong> videos</span><span><strong>{voices} / {limits.voicePerPerson}</strong> voice</span><small>{plan === "pro" ? "Pro" : "Free"} account · {formatStorage(mediaUsage(media))} of {formatStorage(limits.storageBytes)} used. Videos can be up to 2 minutes; voice recordings up to 5 minutes. <button className="text-button" disabled={uploading || recording} onClick={() => choose("voice")}>Upload an audio file</button></small></div>{message && <p className={`upload-message ${message.includes("saved") ? "success" : ""}`} role="status">{message}{retry && <button className="text-button" disabled={uploading} onClick={() => runUploads(retry.files, retry.type)}>Try again</button>}</p>}{uploading && <div className="upload-progress" role="status"><span><i style={{ width: `${progress}%` }} /></span><strong>{progress}% uploaded</strong></div>}<div className="action-grid">{actions.map(([title, desc, icon, color]) => { const type = title === "Photo" ? "photo" : title === "Video" ? "video" : title === "Voice recording" ? "voice" : null; const disabled = uploading || recording || Boolean(type && mediaAllowanceError(plan, media, person.id, type)); return <button key={title} disabled={disabled && !(title === "Voice recording" && recording)} className={title === "Voice recording" && recording ? "recording-action" : ""} onClick={() => title === "Photo" ? choose("photo") : title === "Video" ? choose("video") : title === "Voice recording" ? toggleRecording() : go(title === "Note" ? "notes" : "profile")}><span className={color}>{icon}</span><div><strong>{title === "Voice recording" && recording ? "Stop recording" : title}</strong><small>{uploading ? "Upload in progress…" : recording && title !== "Voice recording" ? "Recording in progress…" : disabled && type && !recording ? "Plan limit reached" : title === "Voice recording" && recording ? "Recording now…" : desc}</small></div><b>→</b></button>; })}</div></div>;
}

function Notes({ person, go, notes, addNote, updateNote, removeNote }: { person: Person; go: (s: Screen) => void; notes: KeepsakeNote[]; addNote: (title: string, body: string) => void; updateNote: (id: string, title: string, body: string) => void; removeNote: (id: string) => void }) {
  const [composing, setComposing] = useState(true);
  const [title, setTitle] = useState(""); const [body, setBody] = useState("");
  const personNotes = notes.filter((note) => note.personId === person.id);
  const save = (event: React.FormEvent) => { event.preventDefault(); if (!title.trim() || !body.trim()) return; addNote(title.trim(), body.trim()); setTitle(""); setBody(""); setComposing(false); };
  return <div className="page">
    <button className="back-btn" onClick={() => go("profile")}>← <span>{person.name}</span></button>
    <Header eyebrow={`${person.name}’s memories`} title="Notes" action={<button className="primary-btn compact" onClick={() => setComposing(true)}>＋ New note</button>} />
    {composing && <form className="note-composer" onSubmit={save}>
      <div><span className="tag orange-text">A new memory</span><h2>What do you want to remember?</h2></div>
      <label><span>Title</span><input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Give this note a title" /></label>
      <label><span>Note</span><textarea required value={body} onChange={(event) => setBody(event.target.value)} placeholder={`Write something about ${person.name}…`} /></label>
      <div><button type="button" className="secondary-btn" onClick={() => setComposing(false)}>Cancel</button><button className="primary-btn" type="submit">Save note</button></div>
    </form>}
    <section className="story-section"><div className="story-notes">{personNotes.map((note) => <StoryNote key={note.id} note={note} personName={person.name} updateNote={updateNote} removeNote={removeNote} />)}</div>
      {!personNotes.length && !composing && <div className="story-empty"><strong>Start {person.name}’s story.</strong><p>Add a little detail, a funny quote, or a moment you want to keep.</p><button className="primary-btn" onClick={() => setComposing(true)}>Add the first note</button></div>}
    </section>
  </div>;
}

function Search({ select, people, notes, media }: { select: (p: Person) => void; people: Person[]; notes: KeepsakeNote[]; media: MediaItem[] }) {
  const [query, setQuery] = useState(""); const results = useMemo(() => { const term = query.trim().toLowerCase(); if (!term) return []; return people.flatMap((person) => { const matches: { key: string; person: Person; title: string; context: string }[] = []; if (`${person.name} ${person.relationship} ${person.color} ${person.about} ${person.birthday} ${person.anniversary}`.toLowerCase().includes(term)) matches.push({ key: `person-${person.id}`, person, title: person.name, context: `${person.relationship} · Person details` }); (person.favorites ?? []).filter((favorite) => `${favorite.label} ${favorite.value}`.toLowerCase().includes(term)).forEach((favorite) => matches.push({ key: favorite.id, person, title: favorite.value, context: `${person.name} · ${favorite.label}` })); (person.milestones ?? []).filter((milestone) => `${milestone.kind} ${milestone.title} ${milestone.date} ${milestone.details ?? ""}`.toLowerCase().includes(term)).forEach((milestone) => matches.push({ key: milestone.id, person, title: milestone.title, context: `${person.name} · ${milestone.kind}` })); notes.filter((note) => note.personId === person.id && `${note.title} ${note.body}`.toLowerCase().includes(term)).forEach((note) => matches.push({ key: note.id, person, title: note.title, context: `${person.name} · Note` })); media.filter((item) => item.personId === person.id && `${item.name} ${item.caption ?? ""} ${item.takenAt ?? ""}`.toLowerCase().includes(term)).forEach((item) => matches.push({ key: item.id, person, title: item.caption || item.name, context: `${person.name} · ${item.type}` })); return matches; }); }, [query, people, notes, media]);
  return <div className="page search-page"><Header eyebrow="Find anything" title="Search your Keepsake" /><label className="search-box"><span>⌕</span><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search people, memories, favorites…" /><kbd>⌘ K</kbd></label>{query ? <section><SectionTitle>{results.length ? `${results.length} result${results.length === 1 ? "" : "s"}` : "No matches yet"}</SectionTitle><div className="search-results">{results.map((result) => <button key={result.key} onClick={() => select(result.person)}><Avatar person={result.person} /><span><strong>{result.title}</strong><small>{result.context}</small></span><b>→</b></button>)}{!results.length && <div className="empty-state"><span>⌕</span><h2>Nothing found for “{query}”</h2><p>Try a person’s name, a favorite, a date, or words from a note.</p></div>}</div></section> : <div className="search-start"><div><span>♡</span><h2>{people.length ? "Search the details that matter" : "Your Keepsake is ready to grow"}</h2><p>{people.length ? "Find a favorite food, an old note, a special date, or someone you love." : "Once you add people and memories, you’ll be able to find them here."}</p></div></div>}</div>;
}

function Settings({ openStorage, user, signOut, deleteAccount, darkMode, setDarkMode, reminders, setReminders, peopleCount, media, subscriptionStatus, startCheckout, refreshSubscription, manageSubscription }: { openStorage: () => void; user: AuthUser; signOut: () => void; deleteAccount: () => void; darkMode: boolean; setDarkMode: (value: boolean) => void; reminders: ReminderSettings; setReminders: (value: ReminderSettings) => void; peopleCount: number; media: MediaItem[]; subscriptionStatus: SubscriptionStatus; startCheckout: () => void; refreshSubscription: () => void; manageSubscription: () => void }) {
  const plan = user.plan ?? "free";
  const limits = getPlanLimits(plan); const usedStorage = mediaUsage(media);
  const membershipStatus = subscriptionStatus === "loading" ? "Checking subscription…" : subscriptionStatus === "error" ? "Couldn’t verify subscription · Try again" : plan === "pro" ? "Verified subscription · Unlimited people unlocked" : `${peopleCount} of 4 people used`;
  const groups = [{ title: "Membership", rows: [[plan === "pro" ? "✦" : "♡", plan === "pro" ? "Keepsake Pro" : "Keepsake Free", membershipStatus], ["★", "$39.99 per year", "Best value · about $3.33 per month"], ["◷", "$4.99 per month", "Flexible monthly billing"], ["✓", "What Pro unlocks", "Unlimited people, 5 GB media, cloud sync, advanced reminders, family sharing"], ["↻", "Restore purchases", "Refresh your purchases from RevenueCat"], ...(plan === "pro" ? [["⚙", "Manage or cancel subscription", "Open the secure subscription portal"]] : [])] }, { title: "Account", rows: [["♙", "Profile & account", `${user.name} · ${user.email}`], ["♢", "Storage usage", `${formatFileSize(usedStorage)} of ${formatStorage(limits.storageBytes)} used`], ...(E2EE_ENABLED ? [["◇", "Encryption preview", "On · recovery and migration testing required"]] : [])] }, { title: "Support", rows: [["?", "Help & support", "Contact@Blackburn.Works"], ["ⓘ", "About Keepsake", "Created by Blackburn Works"]] }];
  const enableBrowserNotifications = async () => { if (!("Notification" in window)) return; const permission = await Notification.requestPermission(); if (permission === "granted") { setReminders({ ...reminders, enabled: true }); new Notification("Keepsake reminders are ready", { body: "We’ll give you gentle prompts while Keepsake is open." }); } };
  return <div className="page settings-page"><Header eyebrow="Your space" title="Settings" /><section className="account-card"><span className="initial-avatar large">{user.name.charAt(0).toUpperCase()}</span><div><h2>{user.name}</h2><p>{user.email}</p></div><button className="signout-btn" onClick={signOut}>Sign out</button></section><section className={`plan-status-card ${plan}`}><span>{plan === "pro" ? "PRO" : "FREE"}</span><div><strong>{plan === "pro" ? "You’re subscribed to Keepsake Pro" : "You’re using Keepsake Free"}</strong><p>{subscriptionStatus === "loading" ? "Checking your subscription…" : plan === "pro" ? "Unlimited people and 5 GB of memory storage are unlocked." : `Your plan includes up to 4 people. You’re currently using ${peopleCount}.`}</p></div><button onClick={plan === "pro" ? manageSubscription : startCheckout}>{plan === "pro" ? "Manage or cancel" : "Upgrade to Pro"}</button></section><section><SectionTitle>Appearance</SectionTitle><div className="appearance-card"><span className="appearance-icon">☾</span><div><strong>Dark mode</strong><small>Use a calmer, low-light color palette</small></div><button className={`theme-switch ${darkMode ? "on" : ""}`} role="switch" aria-checked={darkMode} onClick={() => setDarkMode(!darkMode)}><span /></button></div></section><section className="reminder-settings"><SectionTitle>Capture reminders</SectionTitle><div className="reminder-card"><div className="reminder-row"><span className="appearance-icon">♧</span><div><strong>Gentle prompts</strong><small>Occasional questions help you notice memories worth saving.</small></div><button className={`theme-switch ${reminders.prompts ? "on" : ""}`} role="switch" aria-checked={reminders.prompts} onClick={() => setReminders({ ...reminders, prompts: !reminders.prompts })}><span /></button></div><div className="reminder-options"><label><span>Frequency</span><select value={reminders.frequency} onChange={(event) => setReminders({ ...reminders, frequency: event.target.value as "daily" | "weekly" })}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label><label><span>Preferred time</span><input type="time" value={reminders.time} onChange={(event) => setReminders({ ...reminders, time: event.target.value })} /></label><button className="secondary-btn" onClick={enableBrowserNotifications}>{reminders.enabled ? "Browser reminders enabled" : "Enable browser reminders"}</button></div><p>Browser reminders can appear while Keepsake is running. Closed-app reminders will come with the later installed-app notification service.</p></div></section><section><SectionTitle>Ways to capture</SectionTitle><div className="integration-grid"><article><span>▣</span><strong>Home-screen shortcut</strong><small>Install Keepsake for faster access</small><b>Available as a web app</b></article><article><span>↗</span><strong>Share to Keepsake</strong><small>Send text and links from another app into Quick Notes</small><b>Available when installed</b></article><article><span>◎</span><strong>Siri & Google Assistant</strong><small>Intentional voice shortcuts—never always listening</small><b>Later native phase</b></article></div></section><div className="settings-grid">{groups.map((group) => <section key={group.title}><SectionTitle>{group.title}</SectionTitle><div className="settings-group">{group.rows.map(([icon, title, subtitle]) => <button key={title} onClick={() => { if (title === "Keepsake Free" || title.includes("$")) startCheckout(); if (title === "Restore purchases" || (title === "Keepsake Pro" && subscriptionStatus === "error")) refreshSubscription(); if (title === "Manage or cancel subscription") manageSubscription(); if (title === "Help & support") window.location.href = "mailto:Contact@Blackburn.Works?subject=Keepsake%20Support"; if (title === "About Keepsake") window.location.hash = "/about"; if (title === "Storage usage") openStorage(); }}><span>{icon}</span><div><strong>{title}</strong><small>{subtitle}</small></div><b>›</b></button>)}</div></section>)}</div><section className="danger-zone"><SectionTitle>Account actions</SectionTitle><button onClick={deleteAccount}><span>Delete local account</span><small>Remove this account and all of its local Keepsake data</small></button></section><div className="settings-footer"><img src="/keepsake-logo-hd.png" alt="Keepsake" /><p><strong>Keepsake</strong><CreatorCredit compact /></p><span>Version 0.3</span></div></div>;
}

const STORAGE_TYPES: { type: MediaItem["type"]; label: string }[] = [
  { type: "photo", label: "Photos" }, { type: "video", label: "Videos" },
  { type: "voice", label: "Voice recordings" }, { type: "profile", label: "Profile pictures" },
  { type: "cover", label: "Cover photos" },
];
function formatFileSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
function StorageManager({ media, people, plan, go, deleteFile }: {
  media: MediaItem[]; people: Person[]; plan: Plan; go: (screen: Screen) => void;
  deleteFile: (id: string) => Promise<string | null>;
}) {
  const [type, setType] = useState("all");
  const [personId, setPersonId] = useState("all");
  const [sort, setSort] = useState("largest");
  const [preview, setPreview] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const deleteLock = useRef(false);
  const used = mediaUsage(media);
  const limit = getPlanLimits(plan).storageBytes;
  const files = media.filter((item) => (type === "all" || item.type === type) && (personId === "all" || String(item.personId) === personId))
    .sort((a, b) => sort === "smallest" ? a.size - b.size : sort === "newest" ? (b.createdAt ?? "").localeCompare(a.createdAt ?? "") : b.size - a.size);
  const remove = async (item: MediaItem) => {
    if (deleteLock.current || !window.confirm(`Permanently delete “${item.caption || item.name}” from Keepsake and free ${formatFileSize(item.size)}? This cannot be undone. The original in your device library is kept.`)) return;
    deleteLock.current = true; setDeleting(item.id); setMessage(""); setError(false);
    try {
      const failure = await deleteFile(item.id);
      setError(Boolean(failure));
      setMessage(failure || `Deleted “${item.caption || item.name}”. ${formatFileSize(item.size)} freed.`);
      if (!failure) setPreview(null);
    } catch { setError(true); setMessage("The file could not be deleted. Check your connection and try again."); }
    finally { deleteLock.current = false; setDeleting(null); }
  };
  return <div className="page storage-page">
    <button className="back-btn" onClick={() => go("settings")}>← <span>Settings</span></button>
    <Header eyebrow="Make room for more memories" title="Storage usage" />
    <section className="storage-summary">
      <strong>{formatFileSize(used)} <span>of {formatStorage(limit)} used</span></strong>
      <progress value={Math.min(used, limit)} max={limit} aria-label="Account media storage used" />
      <p>{media.length} saved files · {formatFileSize(Math.max(0, limit - used))} available</p>
      <small>Your plan counts uploaded photos, videos, recordings, profile pictures, and covers. Notes and person details are not included in this media total.</small>
    </section>
    <div className="storage-breakdown">{STORAGE_TYPES.map((group) => {
      const items = media.filter((item) => item.type === group.type);
      return <button key={group.type} aria-pressed={type === group.type} onClick={() => setType(type === group.type ? "all" : group.type)}><strong>{group.label}</strong><span>{formatFileSize(mediaUsage(items))}</span><small>{items.length} files</small></button>;
    })}</div>
    <section aria-label="Manage stored files">
      <div className="storage-filters">
        <label>File type<select value={type} onChange={(event) => setType(event.target.value)}><option value="all">All types</option>{STORAGE_TYPES.map((group) => <option key={group.type} value={group.type}>{group.label}</option>)}</select></label>
        <label>Person<select value={personId} onChange={(event) => setPersonId(event.target.value)}><option value="all">Everyone</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}<option value="0">Quick Notes</option>{[...new Set(media.filter((item) => item.personId !== 0 && !people.some((person) => person.id === item.personId)).map((item) => item.personId))].map((id) => <option key={id} value={id}>Unassigned ({id})</option>)}</select></label>
        <label>Sort by<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="largest">Largest first</option><option value="smallest">Smallest first</option><option value="newest">Newest first</option></select></label>
      </div>
      <p className="storage-caption">{files.length} files · {formatFileSize(mediaUsage(files))} shown. Deleting a file removes it from Keepsake on all devices. Your device library is kept.</p>
      {message && <p className={error ? "form-error" : "upload-message success"} role={error ? "alert" : "status"}>{message}</p>}
      <div className="storage-files">{files.map((item) => <article key={item.id} className="storage-file">
        <div className="storage-file-row">
          <button className="storage-thumbnail" onClick={() => setPreview(preview === item.id ? null : item.id)} aria-expanded={preview === item.id} aria-label={`Preview ${item.caption || item.name}`}>{["photo", "profile", "cover"].includes(item.type) ? <img src={item.url} alt="" loading="lazy" /> : <span>{item.type === "video" ? "▶" : "♫"}</span>}</button>
          <div className="storage-file-info"><strong>{item.caption || item.name}</strong><small>{people.find((person) => person.id === item.personId)?.name ?? (item.personId === 0 ? "Quick Notes" : "Unassigned")} · {STORAGE_TYPES.find((group) => group.type === item.type)?.label}</small><span>{formatFileSize(item.size)}</span></div>
          <button className="storage-delete" disabled={deleting !== null} onClick={() => remove(item)} aria-label={`Delete ${item.caption || item.name}`}>{deleting === item.id ? "Deleting…" : "Delete"}</button>
        </div>
        {/* Uploaded memories do not include caption tracks. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        {preview === item.id && <div className="storage-preview">{item.type === "video" ? <video src={item.url} controls preload="metadata" /> : item.type === "voice" ? <audio src={item.url} controls preload="metadata" /> : <img src={item.url} alt={item.caption || item.name} />}<button className="text-button" onClick={() => setPreview(null)}>Close preview</button></div>}
      </article>)}</div>
      {!files.length && <div className="empty-state"><h2>{media.length ? "No files match these filters" : "No stored media yet"}</h2><p>{media.length ? "Choose another person or file type to see more files." : "Your uploaded memories will appear here."}</p></div>}
    </section>
  </div>;
}
function SettingsLinks({ go, admin }: { go: (screen: Screen) => void; admin?: boolean }) {
  return <div className="page settings-extra-page"><section><SectionTitle>Your data</SectionTitle><div className="settings-group"><button onClick={() => go("export")}><span>↗</span><div><strong>Export to a file</strong><small>Choose people and details, print stories, or download a backup</small></div><b>›</b></button></div></section><section><SectionTitle>Security</SectionTitle><div className="settings-group"><button onClick={() => go("changePassword")}><span>⌘</span><div><strong>Change password</strong><small>Confirm your current password and choose a stronger one</small></div><b>›</b></button>{admin && <button onClick={() => go("admin")}><span>⚙</span><div><strong>Admin console</strong><small>Admin access verified</small></div><b>›</b></button>}</div></section><section><SectionTitle>Privacy & legal</SectionTitle><div className="settings-group"><button onClick={() => go("privacy")}><span>♢</span><div><strong>Privacy policy</strong><small>How Keepsake protects and processes account data</small></div><b>›</b></button><button onClick={() => go("terms")}><span>§</span><div><strong>Terms of use</strong><small>The rules for using Keepsake</small></div><b>›</b></button><button onClick={() => go("dataDeletion")}><span>⌫</span><div><strong>Account & data deletion</strong><small>What is removed and how deletion works</small></div><b>›</b></button></div></section></div>;
}

function ExportBackup({ go, people, notes, media, exportBackup, printStories }: { go: (screen: Screen) => void; people: Person[]; notes: KeepsakeNote[]; media: MediaItem[]; exportBackup: (format: "json" | "csv" | "both") => void; printStories: () => void }) {
  const [format, setFormat] = useState<"json" | "csv" | "both">("json");
  return <div className="page export-backup export-page"><button className="back-btn" onClick={() => go("settings")}>← <span>Settings</span></button><Header eyebrow="Your memories, your choice" title="Export to a file" /><CustomExport people={people} notes={notes} media={media} /><details className="export-full-backup"><summary>Full backup &amp; story printing</summary><section className="export-card"><SectionTitle>Full export & backup</SectionTitle><p>Download an independent copy of your people, notes, dates, and media details. Uploaded files remain safely stored in Firebase Storage.</p><div className="export-format"><label><span>Download format</span><select value={format} onChange={(event) => setFormat(event.target.value as "json" | "csv" | "both")}><option value="json">JSON — complete app backup</option><option value="csv">CSV — spreadsheet-friendly</option><option value="both">Both JSON and CSV</option></select></label><small>{format === "json" ? "Best for restoring or transferring Keepsake data." : format === "csv" ? "Best for reviewing profiles in Excel or Google Sheets." : "Downloads a complete backup and a spreadsheet copy."}</small></div><div className="export-actions"><button className="primary-btn" onClick={() => exportBackup(format)}>Download {format === "both" ? "both files" : format.toUpperCase()}</button><button className="secondary-btn" onClick={printStories}>Print stories / Save PDF</button></div></section></details></div>;
}

function ChangePasswordPage({ user, go }: { user: AuthUser; go: (screen: Screen) => void }) {
  const [currentPassword, setCurrentPassword] = useState(""); const [newPassword, setNewPassword] = useState(""); const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError(""); setMessage("");
    const issue = passwordIssue(newPassword); if (issue) return setError(issue);
    if (newPassword !== confirmPassword) return setError("The new passwords do not match.");
    if (newPassword === currentPassword) return setError("Choose a password different from your current password.");
    if (!auth.currentUser) return setError("Your session expired. Sign in and try again.");
    setBusy(true);
    try {
      const credential = EmailAuthProvider.credential(user.email, currentPassword);
      await reauthenticateWithCredential(auth.currentUser, credential);
      await updatePassword(auth.currentUser, newPassword);
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); setMessage("Your password was changed successfully.");
    } catch (reason) {
      const code = typeof reason === "object" && reason && "code" in reason ? String(reason.code) : "";
      if (code.includes("invalid-credential") || code.includes("wrong-password")) setError("Your current password is incorrect.");
      else if (code.includes("too-many-requests")) setError("Too many attempts. Wait a moment and try again.");
      else if (code.includes("requires-recent-login")) setError("Sign out and sign back in before changing your password.");
      else setError("We couldn’t change your password. Please try again.");
    } finally { setBusy(false); }
  };
  return <div className="page form-page password-page"><button className="back-btn" onClick={() => go("settings")}>← <span>Settings</span></button><Header eyebrow="Account security" title="Change password" /><form onSubmit={submit}><p className="password-page-intro">Confirm your current password, then choose a new password that you don’t use elsewhere.</p><label><span>Current password</span><input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></label><label><span>New password</span><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" required /></label><ul className="password-rules"><li className={newPassword.length >= 10 ? "met" : ""}>10 characters</li><li className={/[A-Z]/.test(newPassword) ? "met" : ""}>Uppercase</li><li className={/[a-z]/.test(newPassword) ? "met" : ""}>Lowercase</li><li className={/\d/.test(newPassword) ? "met" : ""}>Number</li><li className={/[^A-Za-z0-9]/.test(newPassword) ? "met" : ""}>Special character</li><li className={newPassword.length > 0 && !/(.)\1\1/.test(newPassword) ? "met" : ""}>No triple repeats</li></ul><label><span>Confirm new password</span><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required /></label>{error && <p className="form-error" role="alert">{error}</p>}{message && <p className="form-success" role="status">{message}</p>}<div className="form-actions"><button type="button" className="secondary-btn" onClick={() => go("settings")}>Cancel</button><button className="primary-btn" disabled={busy}>{busy ? "Updating…" : "Update password"}</button></div></form></div>;
}

function LegalPage({ kind, go }: { kind: "privacy" | "terms" | "dataDeletion"; go: (screen: Screen) => void }) {
  const content = kind === "privacy" ? {
  "eyebrow": "Effective October 17, 2026",
  "title": "Privacy Policy",
  "sections": [
    [
      "About Keepsake and this policy",
      "Keepsake, created by Blackburn Works, is a personal memory journal. This policy covers the web app, account access, cloud storage, Quick Capture, exports, subscription services, installed-app sharing, and optional browser reminders. Your memories are not public posts. The current app has no public feed or shared family viewer."
    ],
    [
      "Information you provide",
      "We process your account name, email address, Firebase user ID, email-verification status, and plan or administrator entitlement. Firebase Authentication processes your password and account-recovery requests. Content you choose to save includes people’s names, relationships, birthdays, anniversaries, favorites, profile details, notes, Inbox captures, photos, videos, and voice recordings. Upload records include file names, sizes, types, durations where available, captions, identifiers, and timestamps. Reminder preferences and appearance settings are also saved. Profiles can also contain milestones and timelines; media can include a date taken. Support emails contain whatever information you choose to send to Blackburn Works."
    ],
    [
      "How information is used",
      "Information is used to authenticate you, send verification and password-reset emails, save and display your content, sync records across devices, enforce plan and upload limits, provide optional reminders, and operate and protect the service. Search matches your loaded records in the browser. The current app does not provide AI transcription or AI analysis of your memories. Keepsake does not sell private memory content or use that content for advertising."
    ],
    [
      "Cloud services and access",
      "Firebase Authentication handles sign-in, Cloud Firestore stores account and app records, and Cloud Storage stores uploaded files. The hosting provider also processes requests needed to deliver the web app. These providers may process technical information such as IP addresses, browser information, and operational logs under their applicable terms. Cloud data is organized under your Firebase user ID; owner-only access depends on correctly configured Firebase security rules. Account-specific paths alone do not secure data. We have not established an independent audit of deployed rules."
    ],
    [
      "Administrators and security limits",
      "The Keepsake admin console cannot display or search your people, notes, favorites, photos, videos, or voice recordings. An app administrator role does not provide a private-content viewer. Authorized infrastructure personnel and service providers may technically access unencrypted backend data for operation, security, recovery, support, or legal obligations. Encryption availability and its limits are described below. No online service can guarantee absolute security."
    ],
    [
      "Encryption availability and recovery",
      E2EE_ENABLED ? "This build enables an encryption preview that encrypts memory records, media metadata, and uploaded files on your device before cloud storage. Device keys are stored locally; your recovery key is not sent to Blackburn Works. Account identifiers, email, subscription information, storage paths, object sizes, and timestamps are not all end-to-end encrypted. Migration intentionally retains legacy plaintext rollback records and original files pending testing and cleanup, so this preview does not guarantee that every existing cloud copy is encrypted. Losing every trusted device and your recovery key makes encrypted memories permanently unrecoverable; resetting your password does not recover the key." : "End-to-end encryption is undergoing private testing and is disabled in this build. Memory records and uploaded files are not encrypted on your device before upload by this feature. Access depends on authentication and correctly configured Firebase security rules; authorized infrastructure access remains technically possible."
    ],
    [
      "Analytics, cookies, and browser storage",
      "The app initializes Google Analytics through Firebase on supported browsers, including before sign-in. Analytics may use cookies or similar identifiers to collect usage events, page URLs, browser and device information, and approximate location derived from network information. The app does not explicitly send memory text or uploaded files as analytics events. There is currently no in-app analytics preference control; browser cookie and tracking controls may limit collection. Firebase Authentication uses browser storage to maintain sign-in. Firebase App Check uses reCAPTCHA Enterprise to help distinguish legitimate app requests from abuse, involving technical device and request information. When the encryption preview is disabled, app records and preferences are copied into localStorage. Legacy local records and media may remain after migration. The encryption preview stores a device key and encrypted media cache in IndexedDB. Reminder timing and onboarding preferences also remain locally. Signing out clears the on-screen session but does not erase all stored browser data or trusted-device keys."
    ],
    [
      "Microphone and notification permissions",
      "Recording a voice note requires microphone permission and an intentional recording action. Saved recordings are uploaded to your account. The app does not listen continuously or connect to Siri, Google Assistant, email, or text-message intake. On supported browsers, installing Keepsake enables sharing text and links from another app into Quick Notes; shared input is received in the page URL and processed by the app. Browser reminders require notification permission and run while Keepsake is open; delivery while the app is closed is not currently provided. Notifications may appear on a device screen. Change reminder preferences in Settings and revoke permissions through your browser."
    ],
    [
      "Devices and media links",
      "Protect access to your device, browser profile, signed-in session, and any recovery key. Unencrypted and legacy media may use Firebase download links that can open without sign-in if obtained by someone else. Encrypted media is decrypted on an unlocked device for viewing. Encryption does not protect content already exported, printed, downloaded, displayed on an unlocked device, or retained as a legacy plaintext copy. Signing out does not revoke existing download links or erase files saved elsewhere."
    ],
    [
      "Retention, choices, and deletion",
      "Records are kept to provide your account until you remove them or request account deletion. You can edit or remove content using the available controls. Account deletion attempts to remove app records and registered cloud uploads before deleting the Firebase Authentication account. Failures can leave a partially completed deletion, including remaining files, and may require signing in again and retrying. The app cannot confirm removal from provider logs or backups and does not promise a fixed retention period for those copies. Local records on other devices, legacy media, and copies shared elsewhere are not automatically recalled. Clear this site’s browser data on each device to remove local copies; doing so also signs you out. See Account & Data Deletion before proceeding."
    ],
    [
      "Subscriptions and exports",
      "When configured, RevenueCat receives your Firebase user ID and email to identify your subscription, load entitlements, and provide checkout or management services. The checkout link includes your account identifier and may include your email. RevenueCat and checkout providers process purchase and billing information under their own terms; Keepsake’s app code does not collect payment-card fields. JSON and CSV exports contain readable personal information and media metadata but omit live media download URLs and do not include the uploaded media files. Printing stories creates readable copies. Protect these files independently, including when the encryption preview is enabled."
    ],
    [
      "Information about other people",
      "Only store information and recordings you are entitled to keep, and obtain consent where required, especially for recordings and sensitive information. Avoid including information you do not need. Depending on applicable law, you may have rights to access, correct, delete, or restrict processing of personal information and to complain to a relevant privacy authority. These rights are not limited by this policy."
    ],
    [
      "Providers, questions, and updates",
      "Contact Blackburn Works at Contact@Blackburn.Works for privacy questions or rights requests. Firebase describes its processing at https://firebase.google.com/support/privacy; Google Analytics at https://policies.google.com/technologies/partner-sites; and RevenueCat at https://www.revenuecat.com/privacy/. Providers may process information outside your country under their applicable terms and safeguards. This policy may change as the service changes; the effective date identifies this version."
    ]
  ]
} : kind === "terms" ? {
  "eyebrow": "Effective October 17, 2026",
  "title": "Terms of Use",
  "sections": [
    [
      "Agreement and current service",
      "These Terms of Use govern your use of Keepsake, created by Blackburn Works. By using the service, you agree to these terms. Keepsake provides people profiles, favorites, notes, milestones, timelines, media, Quick Notes, search, cloud storage, JSON/CSV exports, story printing, supported installed-app sharing, and optional browser reminders. You must be legally able to enter this agreement or have any authorization required by applicable law."
    ],
    [
      "Accounts and responsibility",
      "An email/password account and verified email are required to access saved memories. Provide accurate account information, secure your credentials and recovery email, and protect your devices and media download links. You are responsible for activity you authorize through your account. Do not share an account containing private memories or attempt to access another person’s records."
    ],
    [
      "Your content and permissions",
      "Your content remains yours. You grant Keepsake and its service providers the limited permission needed to store, process, transmit, back up, and display it while providing and protecting the service. This does not transfer ownership or authorize selling your private memory content, using it for advertising, or publishing it as a public feed. You are responsible for having the rights and permissions required to store information, photos, videos, or recordings of others, including legally required recording consent."
    ],
    [
      "Acceptable use",
      "Do not upload unlawful or malicious material, infringe privacy or intellectual-property rights, misuse private media links, bypass access controls or plan limits, or interfere with the service. An administrator role does not authorize browsing users’ private memories. Keepsake does not provide a shared memory viewer or a content browser in its admin console."
    ],
    [
      "Privacy and technical limits",
      "The Privacy Policy explains Firebase services, cloud records and uploads, Analytics, App Check, RevenueCat, browser storage, and permissions. Encryption is a configurable preview, not a blanket guarantee for every build or every stored copy. When enabled, you must protect your recovery key; losing every trusted device and that key makes encrypted content unrecoverable. Password reset cannot recover the encryption key. Legacy plaintext rollback copies and operational account information may remain accessible to authorized infrastructure personnel. Protect devices, exports, and media links. Signing out does not erase all locally saved records or device keys."
    ],
    [
      "Plans and upload limits",
      "The current Free plan allows four people and 250 MB of media; Pro entitlements allow unlimited people and 5 GB of media, subject to additional account and per-person media limits shown in the app. Individual photos are limited to 10 MB, videos to 100 MB and two minutes, and voice recordings to 25 MB and five minutes. Profile and cover photos count toward storage. Cloud saving currently operates for both Free and Pro accounts. Uploads remain subject to supported formats, available storage, and successful network processing."
    ],
    [
      "Subscriptions and feature availability",
      "When configured, Upgrade opens a RevenueCat checkout link and Restore purchases refreshes subscription information. Review the checkout to determine whether it is a sandbox test or a live purchase and to confirm the actual price, currency, billing interval, renewal conditions, and applicable taxes before completing a transaction. Settings lists monthly and annual options, but the checkout controls the offer you select. Use Manage or cancel to open the provider’s subscription portal when available; refund and cancellation requests follow the terms shown at purchase and applicable law. Deleting your Keepsake account does not itself cancel provider billing. Contact Contact@Blackburn.Works if checkout or subscription management is unavailable. Family sharing, Siri/Google Assistant shortcuts, and closed-app reminders are not currently provided."
    ],
    [
      "Saving, reminders, and independent copies",
      "Saving and synchronization require successful cloud operations and may fail or be delayed. Check save status and keep independent copies of irreplaceable material. JSON/CSV exports include records and media metadata, not uploaded media binaries or live download URLs; save original media separately. Exported files and printed stories are readable even when account encryption is enabled. The app is not a guaranteed backup or archival service. Browser reminders need permission and an open app and may be delayed or blocked. Do not rely on reminders for critical deadlines."
    ],
    [
      "Deletion and ending use",
      "You may stop using Keepsake and use Settings to request account deletion. The Privacy Policy and Account & Data Deletion page describe the sequence and limitations. Deletion can partially complete before a later step fails; signing in again and retrying may be necessary. Local device keys, browser copies, provider-retained records, and files shared elsewhere are not automatically erased. Export records and separately save original media before deleting. Deletion is intended to be permanent. Manage or cancel any subscription separately through the subscription provider; account deletion does not call the provider’s cancellation service."
    ],
    [
      "Availability, changes, and liability",
      "Features and limits may change, and uninterrupted, error-free operation or recovery of lost material is not guaranteed. To the extent permitted by applicable law, Keepsake and Blackburn Works are not responsible for indirect or consequential losses. Nothing in these terms excludes liability or consumer rights that cannot legally be excluded. Updated terms will identify their effective date."
    ],
    [
      "Questions",
      "Contact Blackburn Works at Contact@Blackburn.Works for service, billing, or terms questions."
    ]
  ]
} : {
  "eyebrow": "Effective October 17, 2026",
  "title": "Account & Data Deletion",
  "sections": [
    [
      "Delete individual information",
      "Use the relevant screen to remove people, notes, favorites, media, or Inbox items. Record changes must successfully sync to the cloud. Media deletion attempts to remove the Storage object and its metadata, but a failed file removal can leave a stored file even after its metadata is removed."
    ],
    [
      "Delete your account",
      "In Settings, use the account deletion action, currently labeled “Delete local account,” and confirm. Despite that label, the action attempts to delete registered cloud media, the app-state record, and your account profile before requesting deletion of your Firebase Authentication account. The deletion sequence also attempts to remove the encryption key on this device and the cloud encryption envelope. After authentication deletion succeeds, it removes the main local record and preference keys in this browser."
    ],
    [
      "Partial deletion and recent sign-in",
      "Firebase may require a recent sign-in to delete the authentication account. Earlier data-removal steps may already have completed when this or another step fails. Sign out, sign back in, and retry if necessary. The app does not verify that every cloud file was removed and cannot restore data already deleted."
    ],
    [
      "Local copies and provider retention",
      "Signing out does not erase all browser records or device encryption keys. Account deletion does not clear every legacy IndexedDB file, cached record, device key, reminder marker, or copy on other devices. Clear this site’s browser data separately on each device to remove local copies. Before clearing device keys, preserve your recovery key if you still need access to encrypted data. Provider logs, backups, orphaned uploads, and files downloaded or shared elsewhere may remain; the app does not promise a fixed removal deadline for them. RevenueCat purchase records are handled separately under its retention terms."
    ],
    [
      "Before deleting",
      "Export JSON or CSV records and separately save original media you want to keep. Exports omit uploaded media files and live download URLs. Printed stories and exports are readable files you must protect independently. Cancel any subscription through Manage or cancel before deleting your account; the account deletion action does not cancel billing. Account deletion is intended to be permanent and cannot be undone through the app. Contact Contact@Blackburn.Works if you need help with an incomplete deletion."
    ]
  ]
};
  return <div className="page legal-page"><button className="back-btn" onClick={() => go("settings")}>← <span>Settings</span></button><Header eyebrow={content.eyebrow} title={content.title} /><p className="legal-intro">Plain-language information for the Keepsake preview. This page should be reviewed by qualified legal counsel before a commercial launch.</p><div className="legal-sections">{content.sections.map(([title, body]) => <section key={title}><h2>{title}</h2><p>{body}</p></section>)}</div><CreatorCredit /></div>;
}

function AdminPage({ user, go }: { user: AuthUser; go: (screen: Screen) => void }) {
  if (!user.admin) return <div className="page legal-page"><button className="back-btn" onClick={() => go("settings")}>← <span>Settings</span></button><Header eyebrow="Restricted" title="Admin access required" /><p className="legal-intro">This surface requires a verified Firebase admin claim.</p></div>;
  return <div className="page admin-page"><button className="back-btn" onClick={() => go("settings")}>← <span>Settings</span></button><Header eyebrow="Blackburn Works" title="Admin console" /><div className="admin-privacy-banner"><span>◇</span><div><strong>Private content is intentionally unavailable.</strong><p>This console cannot display people, notes, favorites, photos, videos, or voice recordings.</p></div></div><div className="admin-grid"><article><small>Administrator</small><strong>{user.email}</strong><p>Access verified through a Firebase custom claim.</p></article><article><small>Content access</small><strong>Blocked by design</strong><p>Only operational and non-content controls belong here.</p></article><article><small>Authentication</small><strong>Firebase active</strong><p>Email/password recovery and protected sessions.</p></article><article><small>Data services</small><strong>Firestore + Storage</strong><p>User-owned paths with published security rules.</p></article></div><section className="admin-boundaries"><h2>Admin boundaries</h2><ul><li>Review service health and configuration.</li><li>Manage verified entitlements through trusted backend tools.</li><li>Respond to account-level support without opening private memories.</li><li>Never place service-account keys or admin secrets in this web app.</li></ul></section></div>;
}

function AboutPage({ go }: { go: (screen: Screen) => void }) {
  return <div className="page about-page"><button className="back-btn" onClick={() => go("settings")}>← <span>Settings</span></button><Header eyebrow="Created by Blackburn Works" title="About Keepsake" /><section className="about-keepsake-card"><img src="/keepsake-logo-hd.png" alt="Keepsake" /><div><p>Keepsake is a private place to preserve the stories, details, voices, and moments that make the people in your life special.</p><p>It is designed for remembering—not performing. Your people and memories stay connected to your account, with no public feed and no audience to manage.</p><div className="about-version"><span>Current version</span><strong>0.3</strong></div><a href="mailto:Contact@Blackburn.Works?subject=Keepsake%20Support">Contact@Blackburn.Works</a></div></section><CreatorCredit /></div>;
}

function SyncStatus({ status }: { status: "loading" | "saving" | "saved" | "error" }) {
  if (status === "saved") return null;
  return <div className={`sync-status ${status}`} role="status" aria-live="polite">{status === "error" && <span aria-hidden="true">!</span>}{status === "loading" ? "Loading your Keepsake…" : status === "saving" ? "Saving…" : "Couldn’t save — retrying"}</div>;
}

function EncryptionGate({ user, ready }: { user: AuthUser; ready: () => void }) {
  const [phase, setPhase] = useState<"checking" | "setup" | "confirm" | "unlock">("checking");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [enteredKey, setEnteredKey] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pendingKeyName = `keepsake-pending-recovery:${user.uid}`;
  useEffect(() => {
    let active = true;
    const inspect = async () => {
      if (!E2EE_ENABLED) { ready(); return; }
      const [deviceKey, envelope] = await Promise.all([loadDeviceKey(user.uid), encryptionEnvelopeStatus(user.uid)]);
      if (!active) return;
      const pending = localStorage.getItem(pendingKeyName) ?? "";
      if (deviceKey && pending) { setRecoveryKey(pending); setPhase("confirm"); }
      else if (deviceKey && envelope === "active") ready();
      else {
        if (envelope === "pending") setError("The previous setup was not confirmed. Create a fresh recovery key to continue.");
        setPhase(envelope === "active" ? "unlock" : "setup");
      }
    };
    inspect().catch(() => { if (active) { setError("Keepsake couldn’t check this device’s encryption key."); setPhase("unlock"); } });
    return () => { active = false; };
  // The parent callback intentionally becomes the terminal state for this gate.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.uid]);
  const begin = async () => {
    setBusy(true); setError("");
    try {
      if (await encryptionEnvelopeStatus(user.uid) === "pending") await restartPendingEncryption(user.uid);
      const key = await setupAccountEncryption(user.uid);
      localStorage.setItem(pendingKeyName, key);
      setRecoveryKey(key); setPhase("confirm");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Encryption setup failed."); }
    finally { setBusy(false); }
  };
  const copyKey = async () => { await navigator.clipboard.writeText(recoveryKey); };
  const downloadKey = () => {
    const contents = `Keepsake recovery key\n\n${recoveryKey}\n\nAccount: ${user.email}\nCreated: ${new Date().toISOString()}\n\nKeep this private. Blackburn Works cannot recover it for you.`;
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([contents], { type: "text/plain" })); link.download = "keepsake-recovery-key.txt"; link.click(); window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  const finishSetup = async () => {
    if (!confirmed || !recoveryKeyConfirmationMatches(recoveryKey, enteredKey)) return setError("Save the key, check the confirmation box, and enter its final group.");
    setBusy(true); setError("");
    try { await activateAccountEncryption(user.uid); localStorage.removeItem(pendingKeyName); setRecoveryKey(""); ready(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Encryption setup could not be confirmed."); }
    finally { setBusy(false); }
  };
  const unlock = async () => {
    setBusy(true); setError("");
    try { await unlockWithRecoveryKey(user.uid, enteredKey); setEnteredKey(""); ready(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Keepsake could not be unlocked."); }
    finally { setBusy(false); }
  };
  return <div className="encryption-gate"><section><img src="/keepsake-logo-hd.png" alt="Keepsake" /><span className="encryption-lock" aria-hidden="true">◇</span>{phase === "checking" && <><h1>Opening your private Keepsake…</h1><p>Checking this device for your encryption key.</p></>}{phase === "setup" && <><h1>Protect your memories</h1><p>Keepsake will encrypt profiles, notes, photos, videos, and recordings on this device before sending them to Firebase. Blackburn Works will not hold the key that opens them.</p><div className="encryption-warning"><strong>Recovery is your responsibility.</strong><span>If you lose every trusted device and your recovery key, nobody—including Blackburn Works—can restore the encrypted memories.</span></div><button className="primary-btn" onClick={begin} disabled={busy}>{busy ? "Preparing encryption…" : "Create my recovery key"}</button></>}{phase === "confirm" && <><h1>Save your recovery key</h1><p>This is the only copy Keepsake will show. Put it in a password manager or download it and store it somewhere private.</p><code className="recovery-key">{recoveryKey}</code><div className="recovery-actions"><button className="secondary-btn" onClick={copyKey}>Copy key</button><button className="secondary-btn" onClick={downloadKey}>Download</button></div><label className="recovery-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I saved this key somewhere safe.</label><label className="recovery-final"><span>Enter the final four characters exactly as shown (case-sensitive)</span><input value={enteredKey} onChange={(event) => setEnteredKey(event.target.value)} maxLength={4} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label><button className="primary-btn" onClick={finishSetup}>Encrypt my Keepsake</button></>}{phase === "unlock" && <><h1>Unlock your Keepsake</h1><p>This device does not have the key for your encrypted memories. Enter the recovery key you saved during setup.</p><label className="recovery-final full"><span>Recovery key</span><textarea value={enteredKey} onChange={(event) => setEnteredKey(event.target.value)} placeholder="Paste your recovery key exactly as saved" autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label><button className="primary-btn" onClick={unlock} disabled={busy || !enteredKey.trim()}>{busy ? "Unlocking…" : "Unlock Keepsake"}</button><small>There is no password-reset shortcut for this key because Blackburn Works never receives it.</small></>}{error && <p className="form-error" role="alert">{error}</p>}</section></div>;
}

function PersonForm({ person, go, savePerson, existingPeople, canAdd }: { person: Person | null; go: (s: Screen) => void; savePerson: (person: Person, profilePhoto?: File) => void; existingPeople: Person[]; canAdd: boolean }) {
  const [name, setName] = useState(person?.name ?? ""); const [relationship, setRelationship] = useState(person?.relationship ?? ""); const [birthday, setBirthday] = useState(dateInputValue(person?.birthday ?? "")); const [anniversary, setAnniversary] = useState(dateInputValue(person?.anniversary ?? "")); const [color, setColor] = useState(person?.color ?? ""); const [about, setAbout] = useState(person?.about ?? "");
  const [profilePhoto, setProfilePhoto] = useState<File>(); const [preview, setPreview] = useState(person?.image ?? ""); const [photoError, setPhotoError] = useState(""); const [duplicateConfirmed, setDuplicateConfirmed] = useState(false); const [formMessage, setFormMessage] = useState("");
  const normalizedName = name.trim().toLocaleLowerCase().replace(/\s+/g, " "); const duplicate = normalizedName ? existingPeople.find((entry) => entry.id !== person?.id && entry.name.trim().toLocaleLowerCase().replace(/\s+/g, " ") === normalizedName) : undefined;
  useEffect(() => () => { if (profilePhoto && preview) URL.revokeObjectURL(preview); }, [profilePhoto, preview]);
  const choosePhoto = (file?: File) => { if (!file) return; if (!file.type.startsWith("image/")) return setPhotoError("Choose an image file."); if (file.size > MEDIA_FILE_LIMITS.photoBytes) return setPhotoError("Profile photos must be 10 MB or smaller."); if (profilePhoto && preview) URL.revokeObjectURL(preview); setProfilePhoto(file); setPreview(URL.createObjectURL(file)); setPhotoError(""); };
  const submit = (event: React.FormEvent) => { event.preventDefault(); setFormMessage(""); if (!name.trim()) return; if (!person && !canAdd) return setFormMessage("Your Free plan includes four people. Upgrade to Pro or remove a profile before adding another."); if (duplicate && !duplicateConfirmed) return setFormMessage(`A profile named ${duplicate.name} already exists. Confirm this is a different person to continue.`); savePerson({ ...(person ?? emptyPerson), id: person?.id || Date.now(), name: name.trim(), relationship: relationship.trim() || "Someone special", birthday: birthday.trim(), anniversary: anniversary.trim(), color: color.trim(), about: about.trim(), favorites: person?.favorites ?? [], image: person?.image ?? "", cover: person?.cover ?? "" }, profilePhoto); };
  return <div className="page form-page"><button className="back-btn" onClick={() => go("people")}>← <span>Cancel</span></button><Header eyebrow={person ? "Keep their page up to date" : "Someone special"} title={person ? `Edit ${person.name}` : "Add a person"} />{!person && !canAdd && <div className="plan-limit-notice"><span>✦</span><div><strong>Your Free plan includes four people.</strong><p>Everyone already saved remains available. Pro allows unlimited people.</p></div><button className="secondary-btn" onClick={() => go("settings")}>See Pro</button></div>}<form onSubmit={submit}><section className="photo-editor"><label className="profile-photo-picker">{preview ? <img src={preview} alt="Profile preview" /> : <span>{getInitials(name)}</span>}<input type="file" accept="image/jpeg,image/png,image/webp,image/heic" onChange={(event) => choosePhoto(event.target.files?.[0])} /><b>✎</b></label><span><strong>Profile photo</strong><small>Choose a clear photo that feels like them.</small>{photoError && <em>{photoError}</em>}</span></section><div className="form-grid"><label><span>Name</span><input required value={name} onChange={(e) => { setName(e.target.value); setDuplicateConfirmed(false); setFormMessage(""); }} placeholder="Their name" /></label><label><span>Relationship</span><input value={relationship} onChange={(e) => setRelationship(e.target.value)} placeholder="How you know them" /></label><label><span>Birthday</span><input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} /></label><label><span>Favorite color</span><input value={color} onChange={(e) => setColor(e.target.value)} placeholder="Optional" /></label><label><span>Anniversary or special date</span><input type="date" value={anniversary} onChange={(e) => setAnniversary(e.target.value)} /></label></div>{duplicate && <label className="duplicate-warning"><input type="checkbox" checked={duplicateConfirmed} onChange={(event) => { setDuplicateConfirmed(event.target.checked); setFormMessage(""); }} /><span><strong>“{duplicate.name}” already has a profile.</strong> Check this only if you are adding a different person with the same name.</span></label>}<label><span>A little about them</span><textarea value={about} onChange={(e) => setAbout(e.target.value)} placeholder="A few words you never want to forget…" /></label>{formMessage && <p className="form-error" role="alert">{formMessage}</p>}<div className="form-actions"><button type="button" className="secondary-btn" onClick={() => go("people")}>Cancel</button><button className="primary-btn" disabled={!person && (!canAdd || Boolean(duplicate && !duplicateConfirmed))}>Save person</button></div></form></div>;
}

export default function KeepsakeApp() {
  const [screen, setScreen] = useState<Screen>("home"); const [selected, setSelected] = useState<Person | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null); const [authReady, setAuthReady] = useState(false);
  const [notes, setNotes] = useState<KeepsakeNote[]>([]); const [inbox, setInbox] = useState<InboxItem[]>([]); const [people, setPeople] = useState<Person[]>([]); const [media, setMedia] = useState<MediaItem[]>([]); const [dataOwner, setDataOwner] = useState("");
  const [darkMode, setDarkMode] = useState(false); const [captureOpen, setCaptureOpen] = useState(false); const [reminders, setReminders] = useState<ReminderSettings>({ enabled: false, frequency: "weekly", time: "19:00", prompts: true });
  const [syncStatus, setSyncStatus] = useState<"loading" | "saving" | "saved" | "error">("loading");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [mediaLoadError, setMediaLoadError] = useState("");
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus>("idle");
  const [managementUrl, setManagementUrl] = useState<string | null>(null);
  const [encryptionReady, setEncryptionReady] = useState(!E2EE_ENABLED);
  const [undoNotice, setUndoNotice] = useState<{ message: string; restore: () => void } | null>(null);
  const undoTimer = useRef<number | null>(null);
  const deferredDelete = useRef<(() => void) | null>(null);
  const plan = getPlan(user); const canAddPerson = canCreatePerson(plan, people.length);
  const alertCount = inbox.length + upcomingEvents(people).filter((event) => event.days <= 30).length;
  const offerUndo = (message: string, restore: () => void, finalize?: () => void) => { if (undoTimer.current) window.clearTimeout(undoTimer.current); deferredDelete.current?.(); deferredDelete.current = finalize ?? null; setUndoNotice({ message, restore: () => { if (undoTimer.current) window.clearTimeout(undoTimer.current); deferredDelete.current = null; restore(); setUndoNotice(null); } }); undoTimer.current = window.setTimeout(() => { deferredDelete.current?.(); deferredDelete.current = null; setUndoNotice(null); }, 8000); };
  const exportBackup = (format: "json" | "csv" | "both") => {
    if (!user) return;
    const date = new Date().toISOString().slice(0, 10);
    const exportedPeople = people.map(({ image: _image, cover: _cover, ...person }) => ({
      ...person,
      profileMediaId: media.find((item) => item.personId === person.id && item.type === "profile")?.id ?? "",
      coverMediaId: media.find((item) => item.personId === person.id && item.type === "cover")?.id ?? "",
    }));
    const exportedMedia = media.map(({ url: _url, ...item }) => item);
    const backup = { format: "Keepsake backup", version: 2, exportedAt: new Date().toISOString(), security: "Live media download URLs are intentionally excluded.", account: { name: user.name, email: user.email }, people: exportedPeople, notes, inbox, reminders, media: exportedMedia };
    const download = (contents: string, mime: string, filename: string) => { const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([contents], { type: mime })); link.download = filename; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(link.href), 1000); };
    if (format === "json" || format === "both") download(JSON.stringify(backup, null, 2), "application/json", `keepsake-backup-${date}.json`);
    if (format === "csv" || format === "both") {
      const headers = ["person_name", "relationship", "birthday", "anniversary", "favorite_color", "about", "record_type", "title", "value_or_body", "date", "media_type", "file_name", "profile_media_id", "cover_media_id", "media_id"];
      const rows: unknown[][] = [];
      people.forEach((person) => {
        const base = [person.name, person.relationship, person.birthday, person.anniversary, person.color, person.about];
        const profileMediaId = media.find((item) => item.personId === person.id && item.type === "profile")?.id ?? "";
        const coverMediaId = media.find((item) => item.personId === person.id && item.type === "cover")?.id ?? "";
        const mediaReferences = [profileMediaId, coverMediaId];
        rows.push([...base, "profile", person.name, person.about, "", "", "", ...mediaReferences, ""]);
        (person.favorites ?? []).forEach((item) => rows.push([...base, "favorite", item.label, item.value, "", "", "", ...mediaReferences, ""]));
        (person.milestones ?? []).forEach((item) => rows.push([...base, "milestone", item.title, item.details, item.date, "", "", ...mediaReferences, ""]));
        notes.filter((note) => note.personId === person.id).forEach((note) => rows.push([...base, "note", note.title, note.body, note.createdAt, "", "", ...mediaReferences, ""]));
        media.filter((item) => item.personId === person.id).forEach((item) => rows.push([...base, "media", item.caption, "", item.takenAt ?? item.createdAt, item.type, item.name, ...mediaReferences, item.id]));
      });
      const csv = "\uFEFF" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
      window.setTimeout(() => download(csv, "text/csv;charset=utf-8", `keepsake-profiles-${date}.csv`), format === "both" ? 250 : 0);
    }
  };
  const printStories = () => { const stories = people.map((person) => `<section><h2>${escapeHtml(person.name)}</h2><p><strong>${escapeHtml(person.relationship)}</strong></p><p>${escapeHtml(person.about)}</p>${(person.milestones ?? []).map((item) => `<h3>${escapeHtml(item.title)} · ${escapeHtml(item.date)}</h3><p>${escapeHtml(item.details)}</p>`).join("")}${notes.filter((note) => note.personId === person.id).map((note) => `<h3>${escapeHtml(note.title)}</h3><p>${escapeHtml(note.body)}</p>`).join("")}</section>`).join(""); const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keepsake stories</title><style>body{font-family:Georgia,serif;max-width:760px;margin:40px auto;line-height:1.55;color:#241c17}section{break-after:page;border-bottom:1px solid #ddd;padding-bottom:28px}h1,h2{color:#57372c}@media(max-width:800px){body{margin:20px}}</style></head><body><h1>Keepsake stories</h1>${stories || "<p>No stories have been added yet.</p>"}</body></html>`; if (!openPrintPreview(html, true)) window.alert("Allow pop-ups to print or save your stories as a PDF."); };
  useEffect(() => {
    initializeAnalytics().catch(() => undefined);
    return onAuthStateChanged(auth, (firebaseUser) => {
      if (!firebaseUser?.email) { setUser(null); setAuthReady(true); return; }
      getIdTokenResult(firebaseUser, true).then((token) => setUser({
        uid: firebaseUser.uid,
        name: firebaseUser.displayName || firebaseUser.email!.split("@")[0],
        email: firebaseUser.email!,
        plan: "free",
        admin: token.claims.admin === true,
        emailVerified: firebaseUser.emailVerified,
      })).finally(() => setAuthReady(true));
    });
  }, []);
  const refreshSubscription = async () => {
    if (!user?.emailVerified) return;
    setSubscriptionStatus("loading");
    try {
      const subscription = await loadSubscription(user.uid, user.email);
      setManagementUrl(subscription.managementUrl);
      setUser((current) => current ? { ...current, plan: subscription.isPro ? "pro" : "free" } : current);
      setSubscriptionStatus("ready");
    } catch {
      setSubscriptionStatus("error");
    }
  };
  const startCheckout = () => {
    if (!user) return;
    try {
      const checkout = window.open(buildSandboxPurchaseUrl(user.uid, user.email), "_blank", "noopener,noreferrer");
      if (!checkout) window.alert("Allow pop-ups to open the secure Keepsake checkout.");
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : "The Keepsake checkout is unavailable.");
    }
  };
  const manageSubscription = () => {
    if (managementUrl) window.open(managementUrl, "_blank", "noopener,noreferrer");
    else refreshSubscription();
  };
  useEffect(() => {
    if (!user?.emailVerified) return;
    refreshSubscription();
    // Firebase UID is the stable RevenueCat App User ID; refresh when accounts change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, user?.emailVerified]);
  useEffect(() => {
    if (!user?.emailVerified) return;
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") refreshSubscription(); };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => { window.removeEventListener("focus", refreshWhenVisible); document.removeEventListener("visibilitychange", refreshWhenVisible); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, user?.emailVerified]);
  useEffect(() => {
    if (!user || !user.emailVerified || !encryptionReady) return;
    const previousMedia = dataOwner === user.uid ? media : [];
    setDataOwner("");
    setSyncStatus("loading");
    let cancelled = false;
    const load = async () => {
      // Profile maintenance must not block reading memories when writes are offline.
      ensureUserProfile(user.uid, user.name, user.email).catch(() => undefined);
      const localPeople: Person[] = JSON.parse(localStorage.getItem(`keepsake-people:${user.email}`) ?? "[]");
      const localNotes: KeepsakeNote[] = JSON.parse(localStorage.getItem(`keepsake-notes:${user.email}`) ?? "[]");
      const localInbox: InboxItem[] = JSON.parse(localStorage.getItem(`keepsake-inbox:${user.email}`) ?? "[]");
      const localReminders: ReminderSettings = JSON.parse(localStorage.getItem(`keepsake-reminders:${user.email}`) ?? JSON.stringify({ enabled: false, frequency: "weekly", time: "19:00", prompts: true }));
      const localDarkMode = localStorage.getItem(`keepsake-theme:${user.email}`) === "dark";
      const cloud = await withLoadTimeout(loadCloudState(user.uid));
      if (cancelled) return;
      const nextPeople = (cloud?.people ?? localPeople) as Person[];
      const nextNotes = (cloud?.notes ?? localNotes) as KeepsakeNote[];
      const nextInbox = (cloud?.inbox ?? localInbox) as InboxItem[];
      const nextReminders = (cloud?.reminders ?? localReminders) as ReminderSettings;
      const nextDarkMode = cloud?.darkMode ?? localDarkMode;
      // Open the account after its structured data loads; media can take much longer.
      setPeople(nextPeople.map((person) => ({ ...person, image: previousMedia.find((item) => item.personId === person.id && item.type === "profile")?.url ?? "", cover: previousMedia.find((item) => item.personId === person.id && item.type === "cover")?.url ?? "" })));
      setMedia(previousMedia);
      setNotes(nextNotes); setInbox(nextInbox); setReminders(nextReminders); setDarkMode(nextDarkMode);
      setDataOwner(user.uid);
      setSyncStatus("saved");
      const failedIds = new Set<string>();
      const errorCodes = new Set<string>();
      let cloudMedia: MediaItem[];
      try { cloudMedia = await withLoadTimeout(loadMedia((id, error) => { failedIds.add(id); const code = typeof error === "object" && error && "code" in error ? String(error.code) : "download-or-decryption-failed"; errorCodes.add(code); }), 60000); }
      catch { if (!cancelled) setMediaLoadError("Your profiles and notes are ready, but media could not be loaded. Check your connection and retry."); return; }
      if (!cloudMedia.length && !failedIds.size) {
        const legacyMedia = await loadLocalMedia(user.email).catch(() => []);
        cloudMedia = await Promise.all(legacyMedia.map(async ({ url, ...item }) => {
          const blob = await fetch(url).then((response) => response.blob());
          const cloudUrl = await uploadCloudMedia(user.uid, item, blob);
          URL.revokeObjectURL(url);
          return { ...item, url: cloudUrl };
        }));
      }
      if (cancelled) return;
      // A photo uploaded while background loading runs wins over the older snapshot.
      const baseline = new Map(previousMedia.map((item) => [item.id, item]));
      setMedia((current) => {
        const changed = current.filter((item) => baseline.get(item.id) !== item);
        const changedIds = new Set(changed.map((item) => item.id));
        return [...cloudMedia.filter((item) => !changedIds.has(item.id)), ...current.filter((item) => failedIds.has(item.id) && !changedIds.has(item.id) && !cloudMedia.some((loaded) => loaded.id === item.id)), ...changed];
      });
      setMediaLoadError(failedIds.size ? `Some media could not be downloaded from Firebase (${[...errorCodes].join(", ")}). Device copies are shown when available. Your uploaded files have not been deleted. Check your connection and retry.` : "");
    };
    load().catch(() => { if (!cancelled) setSyncStatus("error"); });
    return () => { cancelled = true; };
    // Subscription refreshes replace user; only account/unlock changes need hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, user?.emailVerified, encryptionReady, loadAttempt]);
  useEffect(() => {
    if (!user || dataOwner !== user.uid) return;
    setPeople((current) => current.map((person) => ({ ...person,
      image: media.find((item) => item.personId === person.id && item.type === "profile")?.url ?? person.image,
      cover: media.find((item) => item.personId === person.id && item.type === "cover")?.url ?? person.cover,
    })));
  }, [media, dataOwner, user?.uid]);
  useEffect(() => {
    if (!authReady || !user || !user.emailVerified || !encryptionReady || dataOwner !== user.uid) return;
    if (!E2EE_ENABLED) {
      localStorage.setItem(`keepsake-people:${user.email}`, JSON.stringify(people));
      localStorage.setItem(`keepsake-notes:${user.email}`, JSON.stringify(notes));
      localStorage.setItem(`keepsake-inbox:${user.email}`, JSON.stringify(inbox));
      localStorage.setItem(`keepsake-reminders:${user.email}`, JSON.stringify(reminders));
      localStorage.setItem(`keepsake-theme:${user.email}`, darkMode ? "dark" : "light");
    }
    setSyncStatus("saving");
    const timer = window.setTimeout(() => saveCloudState(user.uid, { people, notes, inbox, reminders, darkMode }).then(() => setSyncStatus("saved")).catch(() => setSyncStatus("error")), 400);
    return () => window.clearTimeout(timer);
  }, [people, notes, inbox, reminders, darkMode, authReady, user, dataOwner, encryptionReady]);
  useEffect(() => {
    if (!user?.emailVerified || dataOwner !== user.uid) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("share-target") !== "1") return;
    const sharedTitle = params.get("title")?.trim() ?? "";
    const sharedText = params.get("text")?.trim() ?? "";
    const sharedUrl = params.get("url")?.trim() ?? "";
    const body = [sharedText, sharedUrl && !sharedText.includes(sharedUrl) ? sharedUrl : ""].filter(Boolean).join("\n\n");
    if (sharedTitle || body) setInbox((current) => [{ id: crypto.randomUUID(), title: sharedTitle || "Shared with Keepsake", body, createdAt: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date()) }, ...current]);
    window.history.replaceState(null, "", `${window.location.pathname}#/inbox`);
    setScreen("inbox");
  }, [user, dataOwner]);
  useEffect(() => { document.documentElement.dataset.theme = darkMode ? "dark" : "light"; }, [darkMode]);
  useEffect(() => { if (!user || !reminders.enabled || !reminders.prompts || !("Notification" in window) || Notification.permission !== "granted") return; const check = () => { const now = new Date(); const [hour, minute] = reminders.time.split(":").map(Number); if (now.getHours() < hour || (now.getHours() === hour && now.getMinutes() < minute)) return; const key = `keepsake-last-reminder:${user.email}`; const last = localStorage.getItem(key); const elapsed = last ? now.getTime() - new Date(last).getTime() : Infinity; const interval = reminders.frequency === "daily" ? 86400000 : 604800000; if (elapsed >= interval) { new Notification("A small moment may be worth keeping", { body: CAPTURE_PROMPTS[now.getDate() % CAPTURE_PROMPTS.length] }); localStorage.setItem(key, now.toISOString()); } }; check(); const timer = window.setInterval(check, 60000); return () => window.clearInterval(timer); }, [user, reminders]);
  useEffect(() => { if (!user) return; const applyRoute = () => { const hash = window.location.hash.replace(/^#\/?/, ""); const personMatch = hash.match(/^people\/(\d+)(\/notes)?$/); if (personMatch) { const person = people.find((item) => item.id === Number(personMatch[1])); if (person) { setSelected(person); setScreen(personMatch[2] ? "notes" : "profile"); } else { setSelected(null); setScreen("people"); } return; } const routes: Record<string, Screen> = { home: "home", inbox: "inbox", people: "people", notes: "notes", add: "add", search: "search", alerts: "alerts", settings: "settings", export: "export", storage: "storage", privacy: "privacy", terms: "terms", "data-deletion": "dataDeletion", "change-password": "changePassword", admin: "admin", about: "about", "people/new": "personForm" }; setScreen(routes[hash] ?? "home"); }; applyRoute(); window.addEventListener("hashchange", applyRoute); return () => window.removeEventListener("hashchange", applyRoute); }, [user, people]);
  const go = (next: Screen) => { const creatingPerson = next === "personForm" && screen !== "profile"; const target = creatingPerson && !canAddPerson ? "settings" : (next === "add" || next === "notes") && !selected ? "people" : next; if (target === "personForm" && screen !== "profile") setSelected(null); setScreen(target); const specialRoutes: Partial<Record<Screen, string>> = { dataDeletion: "data-deletion", changePassword: "change-password" }; const route = (target === "profile" || target === "notes") && selected ? `people/${selected.id}${target === "notes" ? "/notes" : ""}` : target === "personForm" ? "people/new" : specialRoutes[target] ?? target; if (window.location.hash !== `#/${route}`) window.location.hash = `/${route}`; window.scrollTo({ top: 0, behavior: "smooth" }); };
  const select = (person: Person) => { setSelected(person); setScreen("profile"); window.location.hash = `/people/${person.id}`; window.scrollTo({ top: 0, behavior: "smooth" }); };
  const addNote = (title: string, body: string) => { if (selected) setNotes((current) => [{ id: crypto.randomUUID(), personId: selected.id, title, body, createdAt: "Today" }, ...current]); };
  const saveInboxText = (title: string, body: string) => setInbox((current) => [{ id: crypto.randomUUID(), title, body, createdAt: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date()) }, ...current]);
  const saveInboxVoice = async (file: File) => { if (!user) return "Sign in before recording."; const allowanceError = mediaAllowanceError(plan, media, 0, "voice", file.size); if (allowanceError) return allowanceError; if (file.size > MEDIA_FILE_LIMITS.voiceBytes) return "Voice recordings must be 25 MB or smaller."; let duration: number | undefined; try { duration = await getAudioDuration(file); } catch { return "We couldn’t read that recording."; } if (duration > MEDIA_FILE_LIMITS.voiceSeconds) return "Voice recordings must be 5 minutes or shorter."; const id = crypto.randomUUID(); const mediaItem = { id, personId: 0, type: "voice" as const, name: file.name, size: file.size, duration, createdAt: new Date().toISOString() }; try { await storeMedia(user.email, mediaItem, file); setMedia((current) => [...current, { ...mediaItem, url: URL.createObjectURL(file) }]); setInbox((current) => [{ id: crypto.randomUUID(), title: "Voice note", body: "Recorded from Quick Capture", createdAt: "Today", mediaId: id }, ...current]); return null; } catch { return "This browser couldn’t save the recording."; } };
  const editInbox = (id: string, title: string, body: string) => setInbox((current) => current.map((item) => item.id === id ? { ...item, title, body } : item));
  const removeInbox = async (id: string) => { const item = inbox.find((entry) => entry.id === id); if (!item) return; const audio = item.mediaId ? media.find((entry) => entry.id === item.mediaId) : undefined; setInbox((current) => current.filter((entry) => entry.id !== id)); if (audio) setMedia((current) => current.filter((entry) => entry.id !== audio.id)); offerUndo("Inbox item deleted", () => { setInbox((current) => [item, ...current]); if (audio) setMedia((current) => [...current, audio]); }, audio && user ? () => { removeStoredMedia(user.email, audio.id).catch(() => undefined); URL.revokeObjectURL(audio.url); } : undefined); };
  const assignInbox = async (item: InboxItem, personId: number) => { const audio = item.mediaId ? media.find((entry) => entry.id === item.mediaId) : undefined; if (audio) { const allowanceError = mediaAllowanceError(plan, media.filter((entry) => entry.id !== audio.id), personId, "voice", audio.size); if (allowanceError) { window.alert(allowanceError); return; } } setNotes((current) => [{ id: crypto.randomUUID(), personId, title: item.title, body: item.body, createdAt: item.createdAt }, ...current]); if (audio && user) { const updated = { ...audio, personId }; setMedia((current) => current.map((entry) => entry.id === audio.id ? updated : entry)); try { const blob = await fetch(audio.url).then((response) => response.blob()); await storeMedia(user.email, { id: updated.id, personId, type: updated.type, name: updated.name, size: updated.size, duration: updated.duration, caption: updated.caption, createdAt: updated.createdAt }, new File([blob], updated.name, { type: blob.type })); } catch { /* Keep the locally assigned entry available for this session. */ } } setInbox((current) => current.filter((entry) => entry.id !== item.id)); };
  const updateNote = (id: string, title: string, body: string) => setNotes((current) => current.map((note) => note.id === id ? { ...note, title, body } : note));
  const removeNote = (id: string) => { const note = notes.find((entry) => entry.id === id); if (!note) return; setNotes((current) => current.filter((entry) => entry.id !== id)); offerUndo("Note deleted", () => setNotes((current) => [note, ...current])); };
  const savePerson = async (person: Person, profilePhoto?: File) => {
    const exists = people.some((item) => item.id === person.id); if (!exists && !canAddPerson) { go("settings"); return; }
    if (!user || !profilePhoto) { setPeople((current) => current.some((item) => item.id === person.id) ? current.map((item) => item.id === person.id ? person : item) : [...current, person]); select(person); return; }
    if (mediaUsage(media) + profilePhoto.size > getPlanLimits(plan).storageBytes) return;
    const previewUrl = URL.createObjectURL(profilePhoto); const optimisticPerson = { ...person, image: previewUrl }; const mediaItem = { id: `profile-${person.id}`, personId: person.id, type: "profile" as const, name: profilePhoto.name, size: profilePhoto.size };
    setPeople((current) => current.some((item) => item.id === person.id) ? current.map((item) => item.id === person.id ? optimisticPerson : item) : [...current, optimisticPerson]); select(optimisticPerson);
    try { const cloudUrl = await storeMedia(user.email, mediaItem, profilePhoto); URL.revokeObjectURL(previewUrl); const stored = { ...mediaItem, url: cloudUrl }; const savedPerson = { ...person, image: cloudUrl }; setMedia((current) => [...current.filter((item) => !(item.personId === person.id && item.type === "profile")), stored]); setPeople((current) => current.map((item) => item.id === person.id ? savedPerson : item)); setSelected((current) => current?.id === person.id ? savedPerson : current); }
    catch (error) { URL.revokeObjectURL(previewUrl); setPeople((current) => current.map((item) => item.id === person.id ? person : item)); setSelected((current) => current?.id === person.id ? person : current); window.alert("The person was saved, but the profile picture did not upload. Check your connection and try the photo again." + mediaFailureDetail(error)); }
  };
  const updateProfilePhoto = async (file: File) => {
    if (!user || !selected) return "Open a person before choosing a profile picture."; if (!file.type.startsWith("image/")) return "Choose a supported image file."; if (file.size > MEDIA_FILE_LIMITS.photoBytes) return "Profile pictures must be 10 MB or smaller.";
    const person = selected; if (mediaUsage(media.filter((item) => item.id !== `profile-${person.id}`)) + file.size > getPlanLimits(plan).storageBytes) return "This picture would exceed your account storage allowance.";
    const previousImage = person.image; const previewUrl = URL.createObjectURL(file); const optimisticPerson = { ...person, image: previewUrl }; const mediaItem = { id: `profile-${person.id}`, personId: person.id, type: "profile" as const, name: file.name, size: file.size };
    setPeople((current) => current.map((item) => item.id === person.id ? optimisticPerson : item)); setSelected(optimisticPerson);
    try { const cloudUrl = await storeMedia(user.email, mediaItem, file); URL.revokeObjectURL(previewUrl); const stored = { ...mediaItem, url: cloudUrl }; setMedia((current) => [...current.filter((item) => !(item.personId === person.id && item.type === "profile")), stored]); setPeople((current) => current.map((item) => item.id === person.id ? { ...item, image: cloudUrl } : item)); setSelected((current) => current?.id === person.id ? { ...current, image: cloudUrl } : current); return null; }
    catch (error) { URL.revokeObjectURL(previewUrl); setPeople((current) => current.map((item) => item.id === person.id ? { ...item, image: previousImage } : item)); setSelected((current) => current?.id === person.id ? { ...current, image: previousImage } : current); return "The preview appeared, but the profile picture could not be uploaded. Check your connection and try again." + mediaFailureDetail(error); }
  };
  const updateCoverPhoto = async (file: File, onProgress?: (percent: number) => void) => {
    if (!user || !selected) return "Open a person before choosing a cover photo."; if (!file.type.startsWith("image/") || file.size > MEDIA_FILE_LIMITS.photoBytes) return "Choose an image that is 10 MB or smaller.";
    const person = selected; if (mediaUsage(media.filter((item) => item.id !== `cover-${person.id}`)) + file.size > getPlanLimits(plan).storageBytes) return "This image would exceed your account storage allowance.";
    const previousCover = person.cover; const previewUrl = URL.createObjectURL(file); const optimisticPerson = { ...person, cover: previewUrl };
    setPeople((current) => current.map((item) => item.id === person.id ? optimisticPerson : item)); setSelected(optimisticPerson);
    try { const uploadFile = await optimizeCoverImage(file); const mediaItem = { id: `cover-${person.id}`, personId: person.id, type: "cover" as const, name: uploadFile.name, size: uploadFile.size }; const cloudUrl = await storeMedia(user.email, mediaItem, uploadFile, onProgress); URL.revokeObjectURL(previewUrl); const stored = { ...mediaItem, url: cloudUrl }; setMedia((current) => [...current.filter((item) => !(item.personId === person.id && item.type === "cover")), stored]); setPeople((current) => current.map((item) => item.id === person.id ? { ...item, cover: cloudUrl } : item)); setSelected((current) => current?.id === person.id ? { ...current, cover: cloudUrl } : current); return null; }
    catch (error) { URL.revokeObjectURL(previewUrl); setPeople((current) => current.map((item) => item.id === person.id ? { ...item, cover: previousCover } : item)); setSelected((current) => current?.id === person.id ? { ...current, cover: previousCover } : current); return "The preview appeared, but the cover photo could not be uploaded. Check your connection and try again." + mediaFailureDetail(error); }
  };
  const updatePersonDetails = (updates: Partial<Person>) => { if (!selected) return; const updatedPerson = { ...selected, ...updates }; setPeople((current) => current.map((person) => person.id === selected.id ? updatedPerson : person)); setSelected(updatedPerson); };
  const updateMediaDetails = async (id: string, updates: { name?: string; caption?: string; takenAt?: string }) => { if (!user) return; setMedia((current) => current.map((entry) => entry.id === id ? { ...entry, ...updates } : entry)); await updateCloudMediaMetadata(user.uid, id, updates).catch(() => setSyncStatus("error")); };
  const deleteMediaItem = async (id: string) => { if (!user || !window.confirm("Delete this media item? You can undo for a few seconds.")) return; const item = media.find((entry) => entry.id === id); if (!item) return; setMedia((current) => current.filter((entry) => entry.id !== id)); offerUndo("Media deleted", () => setMedia((current) => [...current, item]), () => { removeStoredMedia(user.email, id).catch(() => setSyncStatus("error")); URL.revokeObjectURL(item.url); }); };
  const deletePerson = async () => { if (!user || !selected || !window.confirm(`Delete ${selected.name} and all of their notes and media? You can undo for a few seconds.`)) return; const removedPerson = selected; const relatedMedia = media.filter((item) => item.personId === removedPerson.id); const relatedNotes = notes.filter((note) => note.personId === removedPerson.id); setMedia((current) => current.filter((item) => item.personId !== removedPerson.id)); setNotes((current) => current.filter((note) => note.personId !== removedPerson.id)); setPeople((current) => current.filter((person) => person.id !== removedPerson.id)); setSelected(null); go("people"); offerUndo(`${removedPerson.name} deleted`, () => { setPeople((current) => [...current, removedPerson]); setNotes((current) => [...relatedNotes, ...current]); setMedia((current) => [...current, ...relatedMedia]); select(removedPerson); }, () => { relatedMedia.forEach((item) => { removeStoredMedia(user.email, item.id).catch(() => undefined); URL.revokeObjectURL(item.url); }); }); };
  const deleteStorageFile = async (id: string): Promise<string | null> => {
    if (!user) return "Sign in before deleting a file.";
    const item = media.find((entry) => entry.id === id);
    if (!item) return "This file is no longer available. Refresh the storage page.";
    try { await removeStoredMedia(user.email, id); }
    catch { return "The file could not be deleted. Check your connection and try again."; }
    setMedia((current) => current.filter((entry) => entry.id !== id));
    if (item.type === "profile" || item.type === "cover") {
      const clearImage = (person: Person): Person => person.id !== item.personId ? person : { ...person, [item.type === "profile" ? "image" : "cover"]: "" };
      setPeople((current) => current.map(clearImage));
      setSelected((current) => current ? clearImage(current) : current);
    }
    setInbox((current) => current.map((entry) => entry.mediaId === id ? { ...entry, mediaId: undefined } : entry));
    URL.revokeObjectURL(item.url);
    return null;
  };
  const deleteAccount = async () => { if (!user || !auth.currentUser || !window.confirm("Delete this account and all of its Keepsake data? This cannot be undone.")) return; const email = user.email; try { await deleteCloudAccountData(user.uid); await deleteUser(auth.currentUser); localStorage.removeItem(`keepsake-people:${email}`); localStorage.removeItem(`keepsake-notes:${email}`); localStorage.removeItem(`keepsake-inbox:${email}`); localStorage.removeItem(`keepsake-reminders:${email}`); localStorage.removeItem(`keepsake-theme:${email}`); } catch { window.alert("For security, sign out and sign back in before deleting your account."); } };
  const uploadMedia = async (file: File, type: UploadType, onProgress?: (percent: number) => void) => { if (!user || !selected) return "Choose a person before uploading media."; const allowanceError = mediaAllowanceError(plan, media, selected.id, type, file.size); if (allowanceError) return allowanceError; if (type === "photo" && !file.type.startsWith("image/")) return "Choose a supported image file."; if (type === "video" && !file.type.startsWith("video/")) return "Choose a supported video file."; if (type === "voice" && !file.type.startsWith("audio/")) return "Choose a supported audio file."; if (type === "photo" && file.size > MEDIA_FILE_LIMITS.photoBytes) return "Photos must be 10 MB or smaller."; if (type === "video" && file.size > MEDIA_FILE_LIMITS.videoBytes) return "Videos must be 100 MB or smaller."; if (type === "voice" && file.size > MEDIA_FILE_LIMITS.voiceBytes) return "Voice recordings must be 25 MB or smaller."; let duration: number | undefined; if (type === "video") { try { duration = await getVideoDuration(file); } catch { return "We couldn’t read that video. Try MP4, WebM, or MOV."; } if (duration > MEDIA_FILE_LIMITS.videoSeconds) return "Videos must be 2 minutes or shorter."; } if (type === "voice") { try { duration = await getAudioDuration(file); } catch { return "We couldn’t read that recording. Try MP3, M4A, WAV, WebM, or OGG."; } if (duration > MEDIA_FILE_LIMITS.voiceSeconds) return "Voice recordings must be 5 minutes or shorter."; } const item = { id: crypto.randomUUID(), personId: selected.id, type, name: file.name, size: file.size, duration, takenAt: new Date().toISOString().slice(0, 10), createdAt: new Date().toISOString() }; try { await storeMedia(user.email, item, file, onProgress); setMedia((current) => [...current, { ...item, url: URL.createObjectURL(file) }]); return null; } catch { return "This browser couldn’t save the file. Check your connection and try again."; } };
  const signOut = async () => { media.forEach((item) => URL.revokeObjectURL(item.url)); await firebaseSignOut(auth); document.documentElement.dataset.theme = "light"; setDarkMode(false); setSubscriptionStatus("idle"); setManagementUrl(null); setEncryptionReady(!E2EE_ENABLED); setUser(null); setDataOwner(""); setPeople([]); setNotes([]); setInbox([]); setMedia([]); setSelected(null); setScreen("home"); history.replaceState(null, "", window.location.pathname); };
  const authenticate = (nextUser: AuthUser) => { setUser(nextUser); setScreen("home"); };
  if (!authReady) return <div className="auth-loading"><img src="/keepsake-logo-hd.png" alt="Keepsake" /><span>Opening your Keepsake…</span></div>;
  if (!user) return <AuthScreen onAuthenticated={authenticate} />;
  if (!user.emailVerified) return <VerifyEmailScreen user={user} verified={(verifiedUser) => { setUser(verifiedUser); setScreen("home"); }} useAnotherAccount={signOut} />;
  if (!encryptionReady) return <EncryptionGate user={user} ready={() => setEncryptionReady(true)} />;
  if (dataOwner !== user.uid) return <div className="auth-loading"><img src="/keepsake-logo-hd.png" alt="Keepsake" />{syncStatus === "error" ? <><span role="alert">Your saved memories could not be loaded. Check your connection and try again.</span><button className="primary-btn" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Try again</button><button className="secondary-btn" onClick={signOut}>Sign out</button></> : <span>Loading your saved memories…</span>}</div>;
  const mediaWarning = mediaLoadError ? <div className="plan-limit-notice" role="alert"><div><strong>Some media could not be loaded</strong><p>{mediaLoadError}</p></div><button className="secondary-btn" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Retry media</button></div> : null;
  const shell = (content: React.ReactNode) => <div className="app-shell"><Sidebar screen={screen} go={go} user={user} /><main>{mediaWarning}{content}</main><SyncStatus status={syncStatus} /><BottomNav screen={screen} go={go} alertCount={alertCount} /></div>;
  if (screen === "privacy" || screen === "terms" || screen === "dataDeletion") return shell(<LegalPage kind={screen} go={go} />);
  if (screen === "changePassword") return shell(<ChangePasswordPage user={user} go={go} />);
  if (screen === "admin") return shell(<AdminPage user={user} go={go} />);
  if (screen === "about") return shell(<AboutPage go={go} />);
  if (screen === "storage") return shell(<StorageManager media={media} people={people} plan={plan} go={go} deleteFile={deleteStorageFile} />);
  if (screen === "export") return shell(<ExportBackup go={go} people={people} notes={notes} media={media} exportBackup={exportBackup} printStories={printStories} />);
  if (screen === "settings") return shell(<><Settings openStorage={() => go("storage")} user={user} signOut={signOut} deleteAccount={deleteAccount} darkMode={darkMode} setDarkMode={setDarkMode} reminders={reminders} setReminders={setReminders} peopleCount={people.length} media={media} subscriptionStatus={subscriptionStatus} startCheckout={startCheckout} refreshSubscription={refreshSubscription} manageSubscription={manageSubscription} /><SettingsLinks go={go} admin={user.admin} />{undoNotice && <div className="undo-toast" role="status"><span>{undoNotice.message}</span><button onClick={undoNotice.restore}>Undo</button></div>}</>);
  const render = () => { switch (screen) { case "home": return <Home go={go} select={select} user={user} people={people} notes={notes} media={media} inbox={inbox} openCapture={() => setCaptureOpen(true)} reminders={reminders} />; case "inbox": return <Inbox items={inbox} people={people} media={media} assign={assignInbox} remove={removeInbox} edit={editInbox} openCapture={() => setCaptureOpen(true)} />; case "people": return <People go={go} select={select} people={people} plan={plan} />; case "profile": return selected ? <Profile person={selected} go={go} media={media} notes={notes} addNote={addNote} updateNote={updateNote} removeNote={removeNote} updateProfilePhoto={updateProfilePhoto} updateCoverPhoto={updateCoverPhoto} updatePersonDetails={updatePersonDetails} deletePerson={deletePerson} deleteMediaItem={deleteMediaItem} updateMediaDetails={updateMediaDetails} /> : <People go={go} select={select} people={people} plan={plan} />; case "notes": return selected ? <Notes key={selected.id} person={selected} go={go} notes={notes} addNote={addNote} updateNote={updateNote} removeNote={removeNote} /> : <People go={go} select={select} people={people} plan={plan} />; case "add": return selected ? <AddMemory person={selected} people={people} selectPerson={(person) => setSelected(person)} go={go} media={media} uploadMedia={uploadMedia} plan={plan} /> : <PersonForm person={null} go={go} savePerson={savePerson} existingPeople={people} canAdd={canAddPerson} />; case "search": return <Search select={select} people={people} notes={notes} media={media} />; case "alerts": return <Alerts people={people} inbox={inbox} reminders={reminders} go={go} select={select} />; case "personForm": return <PersonForm person={selected} go={go} savePerson={savePerson} existingPeople={people} canAdd={canAddPerson} />; } };
  return <div className="app-shell"><Sidebar screen={screen} go={go} user={user} /><main>{mediaWarning}{render()}</main><SyncStatus status={syncStatus} />{undoNotice && <div className="undo-toast" role="status"><span>{undoNotice.message}</span><button onClick={undoNotice.restore}>Undo</button></div>}<QuickCapture open={captureOpen} close={() => setCaptureOpen(false)} saveText={saveInboxText} saveVoice={saveInboxVoice} /><BottomNav screen={screen} go={go} alertCount={alertCount} /></div>;
}
