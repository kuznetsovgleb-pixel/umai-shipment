import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDfXQIGBg1hoNsX-KDweL1e1jmt0acRTQU",
  authDomain: "umai-tms.firebaseapp.com",
  projectId: "umai-tms",
  storageBucket: "umai-tms.firebasestorage.app",
  messagingSenderId: "312449134496",
  appId: "1:312449134496:web:ae0c7bffb1adae2e497ec5",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
