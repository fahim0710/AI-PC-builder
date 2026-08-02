import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

// Firebase web-app identifiers are public by design. Vercel normally injects
// VITE_* values during `vite build`; the checked fallbacks keep authentication
// usable when a deployment is built before those public variables are added.
// Server credentials (Firebase Admin JSON) must never be added here.
const publicValue = (value: string | undefined, fallback: string) =>
  value && !value.startsWith("your_") ? value : fallback;

const app = getApps().length ? getApp() : initializeApp({
  apiKey: publicValue(import.meta.env.VITE_FIREBASE_API_KEY, "AIzaSyAy-35RobZdUc6etPsqAc1WBx8cb9e-xsM"),
  authDomain: publicValue(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN, "nexrig-add4c.firebaseapp.com"),
  projectId: publicValue(import.meta.env.VITE_FIREBASE_PROJECT_ID, "nexrig-add4c"),
  storageBucket: publicValue(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET, "nexrig-add4c.firebasestorage.app"),
  messagingSenderId: publicValue(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID, "887764452411"),
  appId: publicValue(import.meta.env.VITE_FIREBASE_APP_ID, "1:887764452411:web:fce53477b1d1ebd27dc81e"),
  measurementId: publicValue(import.meta.env.VITE_FIREBASE_MEASUREMENT_ID, "G-WD0VDMRLSH"),
});

export const auth = getAuth(app);
