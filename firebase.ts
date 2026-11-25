import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyC9UK23f_kIQ2ykda0fO9xRHdF3oQBhVsw',
  authDomain: 'one-on-one-log.firebaseapp.com',
  projectId: 'one-on-one-log',
  storageBucket: 'one-on-one-log.firebasestorage.app',
  messagingSenderId: '587525730948',
  appId: '1:587525730948:web:d792d6690f2ba77a1dc8d1',
  measurementId: 'G-BCE8P0QFMV',
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
