/**
 * Firebase initialization for the DXX Dashboard frontend.
 *
 * ⚠️  REPLACE the config below with your own Firebase project config.
 *     Get it from: Firebase Console → Project Settings → General → Your apps → Web app
 */
const firebaseConfig = {
  apiKey: "YOUR_API_KEY", // Get from Firebase Console → Project Settings → General → Web App
  authDomain: "dxx-dashboard.firebaseapp.com",
  projectId: "dxx-dashboard",
  storageBucket: "dxx-dashboard.appspot.com",
  messagingSenderId: "520475848058",
  appId: "YOUR_APP_ID", // Get from Firebase Console → Project Settings → General → Web App
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Enable offline persistence for instant loads on revisit
db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  if (err.code === "failed-precondition") {
    console.warn("Firestore persistence unavailable — multiple tabs open.");
  } else if (err.code === "unimplemented") {
    console.warn("Firestore persistence not supported in this browser.");
  }
});
