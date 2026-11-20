import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CALENDAR_SUMMARY = "TimeFrame Planner";
const CALENDAR_DESCRIPTION = "Managed by the TimeFrame personal planner.";
const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const WEEKDAY_INDEX = Object.fromEntries(WEEKDAY_CODES.map((day, index) => [day, index]));
const GOOGLE_COLORS = { blue: "9", green: "2", yellow: "5", pink: "4", red: "11", orange: "6", purple: "3" };
const APP_COLORS = Object.fromEntries(Object.entries(GOOGLE_COLORS).map(([name, id]) => [id, name]));
const oauthStates = new Map();
const connections = new Map();

function loadLocalEnvironment() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !Object.prototype.hasOwnProperty.call(process.env, match[1])) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

loadLocalEnvironment();

const PORT = Number(process.env.PORT || 4174);
const HOST = process.env.HOST || "0.0.0.0";
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth/google/callback`;

function credentialsConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID
    && process.env.GOOGLE_CLIENT_SECRET
    && process.env.SUPABASE_URL
    && process.env.SUPABASE_ANON_KEY
    && process.env.SUPABASE_SERVICE_ROLE_KEY
    && /^[a-f\d]{64}$/i.test(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || "")
  );
}

function supabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}

function isAllowedOrigin(value) {
  try {
    const url = new URL(value);
    const configuredOrigins = (process.env.APP_ORIGINS || "").split(",").map(origin => origin.trim()).filter(Boolean);
    const host = url.hostname;
    const localHost = host === "localhost" || host === "127.0.0.1" || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)
      || /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host);
    if (configuredOrigins.length) {
      return configuredOrigins.includes(url.origin) && (url.protocol === "https:" || (url.protocol === "http:" && localHost));
    }
    return url.protocol === "http:" && localHost && url.port === "4173";
  } catch {
    return false;
  }
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.headers["access-control-request-private-network"] === "true") {
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

function getBearerToken(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

async function requireUser(req) {
  if (!supabaseConfigured()) throw Object.assign(new Error("Configure Supabase URL and anon key on the server first."), { status: 503 });
  const accessToken = getBearerToken(req);
  if (!accessToken) throw Object.assign(new Error("Sign in before connecting Google Calendar."), { status: 401 });
  const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`
    }
  });
  const user = await response.json().catch(() => ({}));
  if (!response.ok || typeof user.id !== "string") {
    throw Object.assign(new Error("Your planner session is invalid or expired. Sign in again."), { status: 401 });
  }
  return user.id;
}

function serviceHeaders(extra = {}) {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
}

async function supabaseServiceRequest(pathname, options = {}) {
  const base = process.env.SUPABASE_URL.replace(/\/+$/, "");
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: serviceHeaders(options.headers)
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Supabase returned an unreadable Google connection response.");
    }
  }
  if (!response.ok) {
    throw new Error(data?.message || data?.msg || data?.error || `Supabase connection storage failed (${response.status}).`);
  }
  return data;
}

function encryptGoogleToken(value) {
  const key = Buffer.from(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY, "hex");
  if (key.length !== 32) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString("base64")).join(".");
}

function decryptGoogleToken(value) {
  const key = Buffer.from(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || "", "hex");
  if (key.length !== 32) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters.");
  const [ivText, tagText, encryptedText] = String(value || "").split(".");
  if (!ivText || !tagText || !encryptedText) throw new Error("The stored Google connection is invalid.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  const json = Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(json);
}

async function loadGoogleConnection(userId) {
  if (connections.has(userId)) return connections.get(userId);
  const query = new URLSearchParams({ select: "encrypted_refresh_token,calendar_id,time_zone,last_sync_at", user_id: `eq.${userId}` });
  const rows = await supabaseServiceRequest(`/rest/v1/google_connections?${query}`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  const connection = {
    refreshToken: decryptGoogleToken(row.encrypted_refresh_token),
    calendarId: row.calendar_id || null,
    timeZone: row.time_zone || "UTC",
    accessToken: "",
    expiresAt: 0,
    lastSyncAt: row.last_sync_at || null
  };
  connections.set(userId, connection);
  return connection;
}

async function saveGoogleConnection(userId, connection) {
  const query = new URLSearchParams({ on_conflict: "user_id" });
  await supabaseServiceRequest(`/rest/v1/google_connections?${query}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      user_id: userId,
      encrypted_refresh_token: encryptGoogleToken(connection.refreshToken),
      calendar_id: connection.calendarId,
      time_zone: connection.timeZone || "UTC",
      last_sync_at: connection.lastSyncAt
    })
  });
  connections.set(userId, connection);
}

async function deleteGoogleConnection(userId) {
  const query = new URLSearchParams({ user_id: `eq.${userId}` });
  await supabaseServiceRequest(`/rest/v1/google_connections?${query}`, { method: "DELETE" });
  connections.delete(userId);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw Object.assign(new Error("Request body is too large."), { status: 413 });
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

async function refreshAccessToken(userId, connection) {
  if (!connection?.refreshToken) throw new Error("Connect your Google Calendar account again.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: connection.refreshToken,
      grant_type: "refresh_token"
    })
  });
  const data = await response.json();
  if (!response.ok) {
    if (data.error === "invalid_grant") await deleteGoogleConnection(userId);
    throw new Error(data.error_description || data.error || "Could not refresh the Google access token.");
  }
  connection.accessToken = data.access_token;
  connection.expiresAt = Date.now() + data.expires_in * 1000;
}

async function googleRequest(userId, connection, endpoint, options = {}) {
  if (!connection?.refreshToken) throw new Error("Connect your Google Calendar before syncing.");
  if (!connection.accessToken || connection.expiresAt < Date.now() + 30000) await refreshAccessToken(userId, connection);
  const response = await fetch(`https://www.googleapis.com${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `Google Calendar API returned ${response.status}.`;
    throw new Error(message);
  }
  return data;
}

async function ensurePlannerCalendar(userId, connection) {
  if (connection.calendarId) {
    try {
      await googleRequest(userId, connection, `/calendar/v3/calendars/${encodeURIComponent(connection.calendarId)}`);
      return connection.calendarId;
    } catch (error) {
      if (!/404|not found/i.test(error.message)) throw error;
      connection.calendarId = null;
    }
  }

  const created = await googleRequest(userId, connection, "/calendar/v3/calendars", {
    method: "POST",
    body: JSON.stringify({ summary: CALENDAR_SUMMARY, description: CALENDAR_DESCRIPTION, timeZone: connection.timeZone })
  });
  connection.calendarId = created.id;
  await saveGoogleConnection(userId, connection);
  return connection.calendarId;
}

function nextWeekday(day, timeZone) {
  const now = new Date();
  const today = dateParts(now.toISOString(), timeZone);
  const [year, month, date] = today.date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1, date));
  const todayIndex = (target.getUTCDay() + 6) % 7;
  let offset = (day - todayIndex + 7) % 7;
  if (offset === 0 && today.minutes >= 1200) offset = 7;
  target.setUTCDate(target.getUTCDate() + offset);
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(target.getUTCDate()).padStart(2, "0")}`;
}

function eventBody(item, timeZone) {
  const date = item.frequency === "once" ? item.date : nextWeekday(item.day, timeZone);
  const formatDateTime = minutes => `${date}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`;
  const body = {
    summary: item.title,
    description: item.instructor || "",
    location: item.location || "",
    colorId: GOOGLE_COLORS[item.color] || GOOGLE_COLORS.blue,
    start: { dateTime: formatDateTime(item.start), timeZone },
    end: { dateTime: formatDateTime(item.end), timeZone },
    extendedProperties: { private: { timeframeId: item.id, timeframeColor: item.color || "blue" } }
  };
  if (item.frequency !== "once") body.recurrence = [`RRULE:FREQ=WEEKLY;BYDAY=${WEEKDAY_CODES[item.day]}`];
  return body;
}

function signature(item) {
  return JSON.stringify({
    title: item.title || "",
    instructor: item.instructor || "",
    location: item.location || "",
    color: item.color || "blue",
    frequency: item.frequency === "once" ? "once" : "weekly",
    date: item.frequency === "once" ? item.date : "",
    day: Number(item.day),
    start: Number(item.start),
    end: Number(item.end)
  });
}

function dateParts(dateTime, timeZone) {
  const date = new Date(dateTime);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).map(part => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function parseGoogleEvent(remote) {
  if (!remote.start?.dateTime || !remote.end?.dateTime || remote.status === "cancelled") return null;
  const zone = remote.start.timeZone || remote.end.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const start = dateParts(remote.start.dateTime, zone);
  const end = dateParts(remote.end.dateTime, zone);
  const rules = remote.recurrence || [];
  const weeklyRule = rules.find(rule => /^RRULE:FREQ=WEEKLY(?:;|$)/i.test(rule));
  if (rules.length && !weeklyRule) return null;
  const recurrenceDay = weeklyRule?.match(/(?:^|;)BYDAY=([A-Z,]+)/i)?.[1]?.split(",")[0];
  const localStartDate = new Date(`${start.date}T12:00:00`);
  const event = {
    id: remote.extendedProperties?.private?.timeframeId || `google-${remote.id}`,
    googleEventId: remote.id,
    title: remote.summary || "Untitled event",
    instructor: remote.description || "",
    location: remote.location || "",
    color: APP_COLORS[remote.colorId] || remote.extendedProperties?.private?.timeframeColor || "blue",
    frequency: weeklyRule ? "weekly" : "once",
    date: weeklyRule ? "" : start.date,
    day: recurrenceDay && WEEKDAY_INDEX[recurrenceDay] !== undefined ? WEEKDAY_INDEX[recurrenceDay] : (localStartDate.getDay() + 6) % 7,
    start: start.minutes,
    end: end.minutes
  };
  event.googleSnapshot = signature(event);
  return event;
}

async function listPlannerEvents(userId, connection, id) {
  const items = [];
  let pageToken;
  do {
    const query = new URLSearchParams({ maxResults: "2500", singleEvents: "false", showDeleted: "false" });
    if (pageToken) query.set("pageToken", pageToken);
    const page = await googleRequest(userId, connection, `/calendar/v3/calendars/${encodeURIComponent(id)}/events?${query}`);
    items.push(...(page.items || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

async function deleteGoogleEvent(userId, connection, id, eventId) {
  try {
    await googleRequest(userId, connection, `/calendar/v3/calendars/${encodeURIComponent(id)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
  } catch (error) {
    if (!/404|410|not found/i.test(error.message)) throw error;
  }
}

async function syncEvents(userId, connection, input) {
  if (!Array.isArray(input.events) || input.events.length > 500) throw new Error("The planner must provide a valid event list.");
  for (const item of input.events) {
    if (!item || typeof item.id !== "string" || typeof item.title !== "string"
      || !Number.isInteger(item.day) || item.day < 0 || item.day > 6
      || !Number.isInteger(item.start) || !Number.isInteger(item.end)
      || item.start < 420 || item.end > 1200 || item.end <= item.start) {
      throw new Error("The planner contains an invalid event.");
    }
  }
  if (input.timeZone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone });
    } catch {
      throw new Error("The planner time zone is invalid.");
    }
    connection.timeZone = input.timeZone;
  }
  const id = await ensurePlannerCalendar(userId, connection);
  const remoteEvents = await listPlannerEvents(userId, connection, id);
  const localEvents = input.events;
  const localIds = new Set(localEvents.map(item => item.id).filter(Boolean));
  const byPlannerId = new Map();
  const byGoogleId = new Map();
  for (const remote of remoteEvents) {
    byGoogleId.set(remote.id, remote);
    const plannerId = remote.extendedProperties?.private?.timeframeId;
    if (plannerId) byPlannerId.set(plannerId, remote);
  }

  const deletedIds = Array.isArray(input.deletedGoogleEventIds) ? input.deletedGoogleEventIds : [];
  const deletedRemoteIds = new Set(deletedIds);
  for (const remoteId of deletedIds) await deleteGoogleEvent(userId, connection, id, remoteId);
  for (const remote of remoteEvents) {
    const plannerId = remote.extendedProperties?.private?.timeframeId;
    if (plannerId && !localIds.has(plannerId)) await deleteGoogleEvent(userId, connection, id, remote.id);
  }

  const nextEvents = [];
  const handledRemoteIds = new Set();
  for (const local of localEvents) {
    let remote = byPlannerId.get(local.id);
    if (!remote && local.googleEventId) remote = byGoogleId.get(local.googleEventId);
    if (!remote && local.googleEventId) continue;

    if (!remote) {
      const created = await googleRequest(userId, connection, `/calendar/v3/calendars/${encodeURIComponent(id)}/events`, {
        method: "POST",
        body: JSON.stringify(eventBody(local, connection.timeZone))
      });
      const saved = { ...local, googleEventId: created.id, googleSnapshot: signature(local) };
      nextEvents.push(saved);
      handledRemoteIds.add(created.id);
      continue;
    }

    handledRemoteIds.add(remote.id);
    const fromGoogle = parseGoogleEvent(remote);
    const currentSignature = signature(local);
    const remoteSignature = fromGoogle ? signature(fromGoogle) : "";
    const snapshot = local.googleSnapshot || "";
    const localChanged = Boolean(snapshot && currentSignature !== snapshot);
    const remoteChanged = Boolean(snapshot && remoteSignature !== snapshot);
    let resolved = local;

    const remoteTimeValid = fromGoogle && fromGoogle.start >= 420 && fromGoogle.end <= 1200 && fromGoogle.end > fromGoogle.start;
    if (remoteChanged && !localChanged && remoteTimeValid) {
      resolved = { ...local, ...fromGoogle, id: local.id };
    } else if (localChanged || !snapshot || !remote.extendedProperties?.private?.timeframeId || (remoteChanged && !remoteTimeValid)) {
      remote = await googleRequest(userId, connection, `/calendar/v3/calendars/${encodeURIComponent(id)}/events/${encodeURIComponent(remote.id)}`, {
        method: "PATCH",
        body: JSON.stringify(eventBody(local, connection.timeZone))
      });
    }

    const synced = {
      ...resolved,
      googleEventId: remote.id,
      googleSnapshot: signature(resolved)
    };
    nextEvents.push(synced);
  }

  let unsupported = 0;
  for (const remote of remoteEvents) {
    if (handledRemoteIds.has(remote.id) || deletedRemoteIds.has(remote.id) || remote.extendedProperties?.private?.timeframeId) continue;
    const imported = parseGoogleEvent(remote);
    if (!imported || imported.start < 420 || imported.end > 1200 || imported.end <= imported.start) {
      unsupported++;
      continue;
    }
    nextEvents.push(imported);
    handledRemoteIds.add(remote.id);
  }

  connection.lastSyncAt = new Date().toISOString();
  await saveGoogleConnection(userId, connection);
  return {
    events: nextEvents,
    deletedGoogleEventIds: [],
    calendarName: CALENDAR_SUMMARY,
    lastSync: connection.lastSyncAt,
    unsupported
  };
}

function callbackPage(origin, message) {
  const targetOrigin = JSON.stringify(origin).replace(/</g, "\\u003c");
  const payload = JSON.stringify(message).replace(/</g, "\\u003c");
  return `<!doctype html><meta charset="utf-8"><title>TimeFrame Google Calendar</title><p>You can close this window.</p><script>if(window.opener){window.opener.postMessage(${payload},${targetOrigin});}window.close();</script>`;
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    sendJson(res, 403, { error: "This planner origin is not allowed. Add it to APP_ORIGINS on the sync service." });
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/google/status") {
      const userId = await requireUser(req);
      const configured = credentialsConfigured();
      const connection = configured ? await loadGoogleConnection(userId) : null;
      sendJson(res, 200, {
        configured,
        connected: Boolean(connection?.refreshToken),
        calendarName: CALENDAR_SUMMARY,
        lastSync: connection?.lastSyncAt || null
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/google/start") {
      const userId = await requireUser(req);
      if (!credentialsConfigured()) {
        sendJson(res, 503, { error: "Configure Google OAuth, Supabase service access, and GOOGLE_TOKEN_ENCRYPTION_KEY on the sync service first." });
        return;
      }
      const input = await readJson(req);
      const appOrigin = String(input.origin || "");
      if (!isAllowedOrigin(appOrigin)) {
        sendJson(res, 400, { error: "The planner origin is not allowed." });
        return;
      }
      const timeZone = String(input.timeZone || "UTC");
      try {
        new Intl.DateTimeFormat("en-US", { timeZone });
      } catch {
        sendJson(res, 400, { error: "The planner time zone is invalid." });
        return;
      }
      const state = crypto.randomBytes(24).toString("hex");
      for (const [key, pending] of oauthStates) {
        if (pending.expires < Date.now()) oauthStates.delete(key);
      }
      oauthStates.set(state, { origin: appOrigin, userId, timeZone, expires: Date.now() + 10 * 60 * 1000 });
      const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authorize.search = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/calendar.app.created",
        access_type: "offline",
        prompt: "consent",
        state
      }).toString();
      sendJson(res, 200, { authorizationUrl: authorize.toString() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/oauth/google/callback") {
      const state = url.searchParams.get("state") || "";
      const pending = oauthStates.get(state);
      if (!pending || pending.expires < Date.now()) {
        sendHtml(res, 400, "<p>Google sign-in expired. Close this window and try again.</p>");
        return;
      }
      oauthStates.delete(state);
      if (url.searchParams.has("error")) {
        sendHtml(res, 200, callbackPage(pending.origin, { type: "google-calendar-error", error: url.searchParams.get("error") }));
        return;
      }
      try {
        const response = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code: url.searchParams.get("code") || "",
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            grant_type: "authorization_code"
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error_description || data.error || "Google sign-in failed.");
        const previous = await loadGoogleConnection(pending.userId);
        const refreshToken = data.refresh_token || previous?.refreshToken;
        if (!refreshToken) throw new Error("Google did not return offline access. Revoke this app in Google Account permissions and reconnect.");
        const connection = {
          refreshToken,
          calendarId: previous?.calendarId || null,
          timeZone: pending.timeZone,
          accessToken: data.access_token || "",
          expiresAt: Date.now() + Number(data.expires_in || 0) * 1000,
          lastSyncAt: previous?.lastSyncAt || null
        };
        await saveGoogleConnection(pending.userId, connection);
        sendHtml(res, 200, callbackPage(pending.origin, { type: "google-calendar-connected" }));
      } catch (error) {
        sendHtml(res, 200, callbackPage(pending.origin, { type: "google-calendar-error", error: error.message }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/google/disconnect") {
      const userId = await requireUser(req);
      if (!credentialsConfigured()) throw Object.assign(new Error("Google Calendar service is not configured."), { status: 503 });
      const connection = await loadGoogleConnection(userId);
      let revoked = true;
      if (connection?.refreshToken) {
        const response = await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: connection.refreshToken })
        });
        revoked = response.ok;
      }
      await deleteGoogleConnection(userId);
      sendJson(res, 200, { connected: false, revoked });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/google/sync") {
      const userId = await requireUser(req);
      if (!credentialsConfigured()) throw Object.assign(new Error("Google Calendar service is not configured."), { status: 503 });
      const connection = await loadGoogleConnection(userId);
      if (!connection?.refreshToken) throw Object.assign(new Error("Connect your Google Calendar before syncing."), { status: 401 });
      const input = await readJson(req);
      const result = await syncEvents(userId, connection, input);
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    console.error("Planner API request failed:", error);
    if (!res.headersSent) sendJson(res, error.status || 500, { error: error.message || "Planner API request failed." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`TimeFrame API listening on ${HOST}:${PORT}.`);
});
