# Keepsake

Keepsake is a private memory app for saving the stories, details, photos, videos, voice recordings, and important dates connected to the people who matter.

## Stack

- Next.js 16 and React 19
- Firebase Authentication
- Cloud Firestore
- Cloud Storage for Firebase
- Vercel for the web interface

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Production verification

```bash
npm run build
```

## Deploying to Vercel

Import the GitHub repository into Vercel and keep the detected Next.js defaults. After the first deployment, add the Vercel production domain under Firebase Authentication's authorized domains.

Firebase public web configuration is initialized in `app/firebase.ts`. Service-account JSON files are server credentials and must never be committed or uploaded to Vercel.
