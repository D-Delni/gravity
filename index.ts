import { serve, file, write } from "bun";
import { randomUUID } from "crypto";

// ── Types ──────────────────────────────────────────────────

interface Counter {
  id: string;
  name: string;
  currentDay: number;
  targetDays: number;
  streak: number;
  color: string;
  orbitsCompleted: number;
  createdAt: string;
}

// The store is a map of userId → Counter[].
// This is what gets written to counters.json.
type Store = Record<string, Counter[]>;

// ── Config ─────────────────────────────────────────────────

const DATA_FILE  = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/counters.json`
  : "counters.json";

const PUBLIC_DIR = "./public";

const PLANET_COLORS = [
  "#E8C5A0", "#A8C5DA", "#C5A8DA", "#A8DAC5",
  "#DAC5A8", "#A8B8DA", "#DAA8B8", "#B8DAA8",
];

// ── Persistence ────────────────────────────────────────────

function migrateCounter(c: Counter): Counter {
  return { ...c, orbitsCompleted: c.orbitsCompleted ?? 0 };
}

async function loadStore(): Promise<Store> {
  try {
    const f = file(DATA_FILE);
    if (!(await f.exists())) return {};

    const raw = JSON.parse(await f.text());

    // Migration: if the file is a flat array (pre-sessions format),
    // wrap it under the key "default" so no data is lost.
    if (Array.isArray(raw)) {
      const migrated: Store = {
        default: (raw as Counter[]).map(migrateCounter),
      };
      await saveStore(migrated);
      console.log("Migrated flat counters.json → multi-user store");
      return migrated;
    }

    // Normal load: migrate each user's counters individually
    const store = raw as Store;
    for (const uid of Object.keys(store)) {
      store[uid] = store[uid].map(migrateCounter);
    }
    return store;
  } catch {
    return {};
  }
}

async function saveStore(store: Store): Promise<void> {
  await write(DATA_FILE, JSON.stringify(store, null, 2));
}

// ── In-memory store (single source of truth) ───────────────

let store: Store = await loadStore();

// Returns a user's counter list, creating it if it doesn't exist yet.
// Does NOT write to disk — callers are responsible for saving.
function getUserCounters(userId: string): Counter[] {
  if (!store[userId]) store[userId] = [];
  return store[userId];
}

// ── Response helpers ───────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(msg: string, status: number): Response {
  return json({ error: msg }, status);
}

// ── Server ─────────────────────────────────────────────────

serve({
  port: parseInt(process.env.PORT ?? "3000"),

  async fetch(req) {
    const url    = new URL(req.url);
    const path   = url.pathname;
    const method = req.method;

    // ── Static files ────────────────────────────────────────
    if (!path.startsWith("/api")) {
      const fp = path === "/" ? `${PUBLIC_DIR}/index.html` : `${PUBLIC_DIR}${path}`;
      const f  = file(fp);
      if (!(await f.exists())) return err("Not found", 404);
      return new Response(f);
    }

    // ── Require X-User-ID on all API routes ─────────────────
    const userId = req.headers.get("X-User-ID")?.trim();
    if (!userId) return err("Missing X-User-ID header", 400);

    // ── GET /api/counters ───────────────────────────────────
    if (method === "GET" && path === "/api/counters") {
      return json(getUserCounters(userId));
    }

    // ── POST /api/counters/reset ────────────────────────────
    if (method === "POST" && path === "/api/counters/reset") {
      store[userId] = getUserCounters(userId).map(
        (c) => ({ ...c, currentDay: 0, streak: 0 })
      );
      await saveStore(store);
      return json(store[userId]);
    }

    // ── POST /api/counters ──────────────────────────────────
    if (method === "POST" && path === "/api/counters") {
      let body: { name?: string };
      try { body = (await req.json()) as { name?: string }; }
      catch { return err("Invalid JSON", 400); }

      const name = (body.name ?? "New Planet").trim();
      if (!name) return err("Name cannot be empty", 400);

      const userCounters = getUserCounters(userId);
      const color = PLANET_COLORS[userCounters.length % PLANET_COLORS.length];

      const counter: Counter = {
        id: randomUUID(),
        name,
        currentDay: 0,
        targetDays: 30,
        streak: 0,
        color,
        orbitsCompleted: 0,
        createdAt: new Date().toISOString(),
      };

      userCounters.push(counter);
      store[userId] = userCounters;
      await saveStore(store);
      return json(counter, 201);
    }

    const idMatch = path.match(/^\/api\/counters\/([^/]+)$/);

    // ── PATCH /api/counters/:id ─────────────────────────────
    if (method === "PATCH" && idMatch) {
      const id           = idMatch[1];
      const userCounters = getUserCounters(userId);
      const idx          = userCounters.findIndex((c) => c.id === id);

      if (idx === -1) return err("Not found", 404);

      let body: {
        day?: number;
        streak?: number;
        targetDays?: number;
        name?: string;
        orbitsCompleted?: number;
      };
      try { body = (await req.json()) as typeof body; }
      catch { return err("Invalid JSON", 400); }

      const c = { ...userCounters[idx] };

      if (body.name !== undefined) {
        const n = body.name.trim();
        if (!n) return err("Name cannot be empty", 400);
        c.name = n;
      }
      if (body.targetDays    !== undefined) c.targetDays    = Math.max(1, Math.floor(body.targetDays));
      if (body.streak        !== undefined) c.streak        = Math.max(0, Math.floor(body.streak));
      if (body.orbitsCompleted !== undefined) c.orbitsCompleted = Math.max(0, Math.floor(body.orbitsCompleted));
      if (body.day !== undefined) {
        const nd = Math.max(0, Math.floor(body.day));
        if (nd > c.currentDay) c.streak += nd - c.currentDay;
        c.currentDay = nd;
      }

      userCounters[idx] = c;
      store[userId]     = userCounters;
      await saveStore(store);
      return json(c);
    }

    // ── DELETE /api/counters/:id ────────────────────────────
    if (method === "DELETE" && idMatch) {
      const id           = idMatch[1];
      const userCounters = getUserCounters(userId);
      const before       = userCounters.length;
      store[userId]      = userCounters.filter((c) => c.id !== id);

      if (store[userId].length === before) return err("Not found", 404);
      await saveStore(store);
      return new Response(null, { status: 204 });
    }

    return err("Not found", 404);
  },
});

console.log(`Gravity! running at http://localhost:${process.env.PORT ?? 3000}`);
