import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
// ↓この行が追加されているか確認！
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyAkjdVyQYZwmQmlPW_ZFPbmUZorkX9Co2E",
  authDomain: "task-ai-2b5ad.firebaseapp.com",
  projectId: "task-ai-2b5ad",
  storageBucket: "task-ai-2b5ad.firebasestorage.app",
  messagingSenderId: "1045148420923",
  appId: "1:1045148420923:web:9772db82c7ae6a0753c51e"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// ↓この2行が一番下に追加されているか確認！
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();