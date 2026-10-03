# Keepsake end-to-end encryption rollout

The implementation is intentionally disabled unless `NEXT_PUBLIC_E2EE_ENABLED=true` is present at build time. Do not enable it in Production first.

## What is encrypted

- People profiles, notes, inbox items, reminder settings, and theme state
- Media metadata, including names, captions, dates, and person associations
- Photo, video, profile, cover, and voice file bytes

Account email, display name, subscription state, encrypted object paths, ciphertext sizes, and operational timestamps remain visible to the service.

## Cryptography

- A random 256-bit account data key encrypts content with AES-256-GCM.
- A separate random 256-bit recovery secret wraps the account key.
- HKDF-SHA-256 derives the wrapping key. Because the recovery secret is random rather than human-chosen, a slow password KDF is not required.
- Every payload and every 1 MiB media chunk uses a fresh 96-bit IV and authenticated context.
- The account data key is stored as a non-extractable `CryptoKey` in IndexedDB on a trusted browser.
- Firebase receives the wrapped account key and ciphertext, never the recovery secret.

## Preview checklist

1. Export any test memories worth keeping.
2. Add `NEXT_PUBLIC_E2EE_ENABLED=true` to a Vercel Preview environment only and redeploy that preview.
3. Create a dedicated test account and save its recovery key in a password manager.
4. Add profiles, notes, each media type, a cover image, and a profile image.
5. Sign out and back in on the same browser. Confirm everything opens.
6. Clear site storage or use a second browser. Confirm the recovery key unlocks the account.
7. Try a modified and an incorrect recovery key. Both must fail closed.
8. Inspect Firestore and Storage. New content must be ciphertext and encrypted media must use `.e2ee` objects.
9. Test interrupted, offline, and retried uploads, plus the 100 MB video limit on a real mobile device.
10. Delete individual media and then delete the test account. Confirm both encrypted and rollback objects are removed.

## Existing-account migration

The preview migration writes encrypted state to `users/{uid}/app/e2eeState`, leaving the previous `state` document as a rollback checkpoint. Existing media is copied to a `.e2ee` object, downloaded, decrypted, and size/type verified before its metadata switches to the encrypted object. Its old Storage object is retained as `legacyStoragePath` during the preview.

This means the preview migration is recoverable, but it is not yet a completed zero-knowledge migration for an existing account: the legacy plaintext checkpoints still exist. Remove those checkpoints only after preview testing, backups, recovery testing, and a dedicated cleanup release.

## Firestore rules required before preview

The existing owner-and-verified-email rule must also cover both encryption paths:

```rules
match /users/{userId}/crypto/{document=**} {
  allow read, write: if request.auth != null
    && request.auth.uid == userId
    && request.auth.token.email_verified == true;
}

match /users/{userId}/app/{document=**} {
  allow read, write: if request.auth != null
    && request.auth.uid == userId
    && request.auth.token.email_verified == true;
}
```

Keep the existing user-owned media rules. Encrypted files are uploaded as `application/octet-stream`, so any Storage rule that insists on `image/*`, `video/*`, or `audio/*` will reject them. Add a distinct encrypted-object rule rather than weakening the existing plaintext validators:

```rules
match /users/{userId}/{allPaths=**} {
  allow read, delete: if ownsPath(userId)
    && resource.name.matches('.*[.]e2ee$');
  allow create, update: if ownsPath(userId)
    && request.resource.name.matches('.*[.]e2ee$')
    && request.resource.contentType == 'application/octet-stream'
    && request.resource.size <= 110 * 1024 * 1024;
}
```

The 110 MB encrypted limit accounts for AES-GCM tags and the encrypted-container header around a 100 MB video.

