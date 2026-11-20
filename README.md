# TimeFrame Planner

TimeFrame supports local guest use and private planner accounts. Each signed-in user gets separate events, tasks, calendar names, and appearance settings. User data syncs between devices through Supabase. Each account can also connect its own Google Calendar through the Node API.

## Configure Supabase

1. Create a Supabase project.
2. In the Supabase SQL Editor, run the contents of `supabase-schema.sql`. The `planner_data` table uses row-level security so authenticated users can only read and change their own planner. Google OAuth tokens are encrypted by the Node API and stored in a separate table that is inaccessible to browser users.
3. In **Authentication → Providers**, enable Email. Configure the confirmation and password policies you want.
4. In **Authentication → URL Configuration**, add the deployed planner URL to the allowed redirect URLs.
5. In `supabase-config.js`, set the project URL and the public anon key. The anon key is intended for browser use; the SQL row-level policies protect account data.

## Deploy the online API

Google Calendar connections need a persistent Node.js service reachable over HTTPS by the planner and by Google OAuth. Deploy `server.js` as a persistent Node service (Node 20 or newer), then set these server environment variables from `.env.example`:

- `SUPABASE_URL` and `SUPABASE_ANON_KEY` for session validation.
- `SUPABASE_SERVICE_ROLE_KEY` for server-only access to encrypted Google connection records. Never put this key in `supabase-config.js` or browser code.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for a Google OAuth Web application.
- `GOOGLE_TOKEN_ENCRYPTION_KEY`, a unique 32-byte key encoded as 64 hexadecimal characters. For example, generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
- `GOOGLE_REDIRECT_URI`, set to `https://YOUR-API-HOST/oauth/google/callback`.
- `APP_ORIGINS`, a comma-separated list of exact planner origins allowed to call the API.
- `PORT`, if required by the hosting provider. The service listens on `0.0.0.0`.

In Google Cloud Console, enable the Google Calendar API, configure the OAuth consent screen, and add the API callback URL above as an authorized redirect URI. Add users as test users while the consent screen is in testing mode.

Set `googleApiUrl` in `supabase-config.js` to the deployed API's HTTPS origin. Deploy the planner files to a static host with HTTPS and add that exact origin to `APP_ORIGINS`. The current `localhost:4173` preview is local and is not reachable outside this computer/network.

## Use accounts

Open Settings and create an account or sign in. The first sign-in can start with a clean planner or copy the current guest planner if the account has no saved planner. Changes save locally and sync to that account; the app checks for updates from other devices every 30 seconds. If two devices edit at once, the last saved planner state wins. Once accounts are used on a device, signing out locks the planner until another account signs in, so the previous account's data is not shown to the next person.

After signing in, use **Settings → Google Calendar → Connect Google Calendar** to connect that user's Google account. Every planner account has its own authorization, encrypted refresh token, and separately created **TimeFrame Planner** calendar. Tokens are encrypted with the server key and never exposed to browser code. Reconnect if the encryption key is changed.

Google sync supports weekly recurring events and one-off timed events between 7:00 AM and 8:00 PM. Unsupported recurrence patterns, all-day events, and out-of-range events are skipped. If both sides change an event between syncs, the planner's version takes precedence.

## Local development

Run the planner's existing static preview on port `4173` and the API with:

```powershell
node server.js
```

For local development, the API defaults to `http://localhost:4174`; register `http://localhost:4174/oauth/google/callback` in Google Cloud and include `http://localhost:4173` in `APP_ORIGINS`. Supabase accounts require the project settings above. Do not commit `.env` or share server secrets.
