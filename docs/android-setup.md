# Android development

Open the android folder in Android Studio and allow Gradle sync to finish. Install the SDK components requested by Studio (compile SDK 36).

The provisional application ID is works.blackburn.keepsake. Confirm it before the first Play upload; update both capacitor.config.ts and Android applicationId/namespace and Java package paths if changing it.

After changing web code, run npm run android:sync from the repository root. This creates a static Next.js export in out and copies assets and plugins to Android. The ordinary npm run build remains the web build. npm run android:open opens Android Studio.

## Status and remaining release work

Capacitor Android and the native RevenueCat plugin are installed and synced. This scaffolding does not yet implement native purchase or restoration. Existing subscription UI still uses the web RevenueCat integration; do not upload this as a finished billing release.

Before store testing: configure Google Play products, Android public RevenueCat SDK key, Firebase UID customer identity, native purchases, restorePurchases, and subscription management. Verify sign-out/account switching. Confirm Firebase authentication, App Check and Storage CORS work from the Capacitor local origin; existing web reCAPTCHA configuration may need a mobile-specific approach. Verify microphone, media, exports and keyboard behavior on device.

Run on an emulator/phone, then generate a signed Android App Bundle for Google Play internal testing. Keep signing keys and service-account credentials out of source control. No store upload or signing key has been created by this setup.
