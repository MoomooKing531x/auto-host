# Cuetime
Schedules and publishes videos to YouTube (Shorts and videos), TikTok and Instagram Reels, with groups, thumbnails and best-time slots.

## Run locally
    cp .env.example .env   # fill in, including DATABASE_URL
    npm install && node --env-file=.env server.js

## Deploy on Render (free web service + free Postgres)
1. Push this repo to GitHub (never commit .env or database URLs).
2. Create a Postgres database. Copy its **Internal** database URL.
3. Create a Web Service from the repo: build `npm install`, start `node server.js`.
4. Set the env vars from `.env.example`. DATABASE_URL = the internal URL. PUBLIC_URL = your https Render URL.
5. Register the redirect URIs below, then point an uptime monitor at PUBLIC_URL/health.

Tokens, the queue and videos live in Postgres, so restarts no longer lose them. A video is deleted from the database once it has posted to every selected platform. Free Postgres expires after 30 days, so recreate it and reconnect accounts before then.

## Redirect URIs
- Google: PUBLIC_URL/auth/youtube/callback
- TikTok: PUBLIC_URL/auth/tiktok/callback
- Instagram: PUBLIC_URL/auth/instagram/callback
