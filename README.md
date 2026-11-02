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

## Memory features

- Open a person's page for **Ask them this** story prompts. Answers save as ordinary notes in their story.
- **On this day** on Home resurfaces notes, dated media, and milestones from the same calendar date in past years. Legacy notes saved only as “Today” are excluded because their original date is unknown.
- Under **Settings → Export to a file**, create a **keepsake book** for one person, with a title, dedication, biography, chronological stories and milestones, and optional photos. Preview it in the app, then print or save as PDF. Audio and video files are excluded.

## Production verification

```bash
npm run build
```

## Deploying to Vercel

Import the GitHub repository into Vercel and keep the detected Next.js defaults. After the first deployment, add the Vercel production domain under Firebase Authentication's authorized domains.

Firebase public web configuration is initialized in `app/firebase.ts`. Service-account JSON files are server credentials and must never be committed or uploaded to Vercel.

## End-to-end encryption preview

The client-side encryption implementation is feature-gated and remains off by default. Read [docs/E2EE-ROLLOUT.md](docs/E2EE-ROLLOUT.md) before enabling `NEXT_PUBLIC_E2EE_ENABLED=true` in any environment.
