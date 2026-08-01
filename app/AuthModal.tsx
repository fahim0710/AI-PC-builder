import { type FormEvent, useState } from "react";
import {
  GoogleAuthProvider, createUserWithEmailAndPassword, sendEmailVerification,
  sendPasswordResetEmail, signInWithEmailAndPassword, signInWithPopup, updateProfile,
} from "firebase/auth";
import { auth } from "./firebase";

const friendlyError = (error: unknown) => {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  return ({
    "auth/email-already-in-use": "An account already exists for this email.",
    "auth/invalid-credential": "The email or password is incorrect.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/operation-not-allowed": "This sign-in method is not enabled in Firebase Console.",
    "auth/popup-closed-by-user": "Google sign-in was cancelled.",
    "auth/network-request-failed": "Could not reach Firebase. Check your internet connection.",
    "auth/too-many-requests": "Too many attempts. Please wait and try again.",
    "auth/user-disabled": "This account has been disabled.",
    "auth/weak-password": "Use a password with at least 6 characters.",
  } as Record<string, string>)[code] ?? "Authentication failed. Please try again.";
};

export function AuthModal({ onClose }: { onClose: () => void }) {
  const [signup, setSignup] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      if (signup) {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        if (name.trim()) await updateProfile(credential.user, { displayName: name.trim() });
        await sendEmailVerification(credential.user);
      } else await signInWithEmailAndPassword(auth, email, password);
      onClose();
    } catch (error) { setMessage(friendlyError(error)); }
    finally { setBusy(false); }
  };

  const google = async () => {
    setBusy(true); setMessage("");
    try { await signInWithPopup(auth, new GoogleAuthProvider()); onClose(); }
    catch (error) { setMessage(friendlyError(error)); }
    finally { setBusy(false); }
  };

  const reset = async () => {
    if (!email) return setMessage("Enter your email address first.");
    setBusy(true);
    try { await sendPasswordResetEmail(auth, email); setMessage("Password-reset email sent."); }
    catch (error) { setMessage(friendlyError(error)); }
    finally { setBusy(false); }
  };

  return <div className="modal-backdrop auth-backdrop" onMouseDown={onClose}>
    <section className="auth-modal" role="dialog" aria-modal="true" aria-label={signup ? "Create account" : "Sign in"} onMouseDown={(e) => e.stopPropagation()}>
      <button className="auth-close" aria-label="Close" onClick={onClose}>×</button>
      <div className="step">NEXRIG ACCOUNT</div><h2>{signup ? "Create your account." : "Welcome back."}</h2>
      <p>Save builds, check out securely, and return to your components anywhere.</p>
      <button className="google-auth" type="button" onClick={google} disabled={busy}><b>G</b> Continue with Google</button>
      <div className="auth-divider"><span>or use email</span></div>
      <form onSubmit={submit}>
        {signup && <label>Name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required /></label>}
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={signup ? "new-password" : "current-password"} minLength={6} required /></label>
        {message && <div className="auth-message" role="status">{message}</div>}
        <button className="auth-submit" disabled={busy}>{busy ? "Please wait…" : signup ? "Create account" : "Sign in"}</button>
      </form>
      {!signup && <button className="auth-link" type="button" onClick={reset} disabled={busy}>Forgot password?</button>}
      <div className="auth-switch">{signup ? "Already have an account?" : "New to NexRig?"} <button type="button" onClick={() => { setSignup(!signup); setMessage(""); }}>{signup ? "Sign in" : "Create one"}</button></div>
    </section>
  </div>;
}
