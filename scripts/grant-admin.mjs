import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const PROJECT_ID = "keepsake-production-775fd";
const ADMIN_EMAIL = "mattblk89@gmail.com";

const app = getApps()[0] ?? initializeApp({
  credential: applicationDefault(),
  projectId: PROJECT_ID,
});

try {
  const adminAuth = getAuth(app);
  const user = await adminAuth.getUserByEmail(ADMIN_EMAIL);
  await adminAuth.setCustomUserClaims(user.uid, {
    ...(user.customClaims ?? {}),
    admin: true,
  });
  await adminAuth.revokeRefreshTokens(user.uid);
  console.log(`Admin access granted to ${ADMIN_EMAIL}. Sign out and back in to refresh the account.`);
} catch (error) {
  console.error("Admin assignment failed.");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
