import { serve, file, write } from "bun";
import { randomUUID } from "crypto";

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

const DATA_FILE = "counters.json";
const PUBLIC_DIR = "./public";

const PLANET_COLORS = [
  "#E8C5A0",
  "#A8C5DA",
  "#C5A8DA",
  "#A8DAC5",
  "#DAC5A8",
  "#A8B8DA",
  "#DAA8B8",
  "#B8DAA8",
];

async function loadCounters(): Promise<Counter[]> {
  try {
    const f = file(DATA_FILE);
    if (!(await f.exists())) return [];
    const raw = JSON.parse(await f.text()) as Counter[];
    // Migrate existing records that predate orbitsCompleted field
    return raw.map(c => ({
      ...c,
      orbitsCompleted: c.orbitsCompleted ?? 0,
    }));
  } catch {
    return [];
  }
}

async function saveCounters(counters: Counter[]): Promise<void> {
  await write(DATA_FILE, JSON.stringify(counters, null, 2));
}

let counters: Counter[] = await loadCounters();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(msg: string, status: number): Response {
  return json({ error: msg }, status);
}

serve({
  port: 3000,
  async fetch(req) {
    const url    = new URL(req.url);
    const path   = url.pathname;
    const method = req.method;

    // ── Static files ──────────────────────────────────────
    if (!path.startsWith("/api")) {
      const fp = path === "/" ? `${PUBLIC_DIR}/index.html` : `${PUBLIC_DIR}${path}`;
      const f  = file(fp);
      if (!(await f.exists())) return err("Not found", 404);
      return new Response(f);
    }

    // ── GET /api/counters ─────────────────────────────────
    if (method === "GET" && path === "/api/counters") {
      return json(counters);
    }

    // ── POST /api/counters/reset ──────────────────────────
    if (method === "POST" && path === "/api/counters/reset") {
      counters = counters.map((c) => ({ ...c, currentDay: 0, streak: 0 }));
      await saveCounters(counters);
      return json(counters);
    }

    // ── POST /api/counters ────────────────────────────────
    if (method === "POST" && path === "/api/counters") {
      let body: { name?: string };
      try { body = (await req.json()) as { name?: string }; }
      catch { return err("Invalid JSON", 400); }

      const name = (body.name ?? "New Planet").trim();
      if (!name) return err("Name cannot be empty", 400);

      const color = PLANET_COLORS[counters.length % PLANET_COLORS.length];
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
      counters.push(counter);
      await saveCounters(counters);
      return json(counter, 201);
    }

    const idMatch = path.match(/^\/api\/counters\/([^/]+)$/);

    // ── PATCH /api/counters/:id ───────────────────────────
    if (method === "PATCH" && idMatch) {
      const id  = idMatch[1];
      const idx = counters.findIndex((c) => c.id === id);
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

      const c = { ...counters[idx] };

      if (body.name !== undefined) {
        const n = body.name.trim();
        if (!n) return err("Name cannot be empty", 400);
        c.name = n;
      }
      if (body.targetDays !== undefined) {
        c.targetDays = Math.max(1, Math.floor(body.targetDays));
      }
      if (body.streak !== undefined) {
        c.streak = Math.max(0, Math.floor(body.streak));
      }
      if (body.day !== undefined) {
        const nd = Math.max(0, Math.floor(body.day));
        if (nd > c.currentDay) c.streak += nd - c.currentDay;
        c.currentDay = nd;
      }
      if (body.orbitsCompleted !== undefined) {
        c.orbitsCompleted = Math.max(0, Math.floor(body.orbitsCompleted));
      }

      counters[idx] = c;
      await saveCounters(counters);
      return json(c);
    }

    // ── DELETE /api/counters/:id ──────────────────────────
    if (method === "DELETE" && idMatch) {
      const id     = idMatch[1];
      const before = counters.length;
      counters     = counters.filter((c) => c.id !== id);
      if (counters.length === before) return err("Not found", 404);
      await saveCounters(counters);
      return new Response(null, { status: 204 });
    }

    return err("Not found", 404);
  },
});

console.log("Gravity! running at http://localhost:3000");
