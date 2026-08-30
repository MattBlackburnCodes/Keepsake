import { getApp, getApps, initializeApp } from "firebase/app";
import { getAnalytics, isSupported } from "firebase/analytics";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyAm9ZtyOo7wYd52gy65795N-7Z9YCXRAXw",
  authDomain: "keepsake-production-775fd.firebaseapp.com",
  projectId: "keepsake-production-775fd",
  storageBucket: "keepsake-production-775fd.firebasestorage.app",
  messagingSenderId: "163458336684",
  appId: "1:163458336684:web:7152b810105c62025c1c09",
  measurementId: "G-TFEQYKZ992",
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const storage = getStorage(firebaseApp);

export async function initializeAnalytics() {
  if (typeof window === "undefined" || !(await isSupported())) return null;
  return getAnalytics(firebaseApp);
}
