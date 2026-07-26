// Next.js App Router fixture — API route that imports Hono (mainstream
// Hono-in-Next pattern). F1 regression: the fs scan must claim this file
// exclusively — the hono/express per-file detectors must NOT also emit
// routes for it.
import { Hono } from 'hono';

const app = new Hono();

app.get('/internal', (c) => c.json({ ok: true }));

export async function GET(request: Request) {
    return app.fetch(request);
}
