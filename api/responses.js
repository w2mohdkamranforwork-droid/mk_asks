// Vercel serverless function: stores date-invite answers in Upstash Redis.
//
//   POST   /api/responses              -> save / update one answer (public)
//   GET    /api/responses              -> list all answers   (needs x-owner-pin header)
//   DELETE /api/responses?id=<id>      -> delete one answer  (needs x-owner-pin header)
//   DELETE /api/responses?all=1        -> delete everything  (needs x-owner-pin header)
//
// Required environment variables (Vercel → Project → Settings → Environment Variables):
//   KV_REST_API_URL / KV_REST_API_TOKEN        (added automatically when you connect
//   or UPSTASH_REDIS_REST_URL / _TOKEN          an Upstash Redis store to the project)
//   OWNER_PIN                                  (the PIN you type to open the dashboard)

const crypto = require('crypto');

const KEY = 'dateplan:responses';
const MAX_RESPONSES = 500;

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function redis(command) {
    const res = await fetch(REDIS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `Redis error ${res.status}`);
    return data.result;
}

function pinMatches(given) {
    const expected = process.env.OWNER_PIN;
    if (!expected || typeof given !== 'string') return false;
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const isISODate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s);

module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (!REDIS_URL || !REDIS_TOKEN) {
        return res.status(503).json({ error: 'Database not connected. Add an Upstash Redis store to this Vercel project.' });
    }

    try {
        if (req.method === 'POST') {
            let body = req.body;
            if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
            if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid body' });

            const record = {
                id: isId(body.id) ? body.id : crypto.randomUUID(),
                name: cleanText(body.name, 30),
                location: cleanText(body.location, 40),
                food: cleanText(body.food, 60),
                date: isISODate(body.date) ? body.date : '',
                noAttempts: Math.max(0, Math.min(9999, parseInt(body.noAttempts, 10) || 0))
            };
            if (!record.name || !record.location || !record.food || !record.date) {
                return res.status(400).json({ error: 'Missing fields' });
            }

            const existing = await redis(['HGET', KEY, record.id]);
            if (existing) {
                // Same visitor changed their plan: keep the original answer time
                try { record.createdAt = JSON.parse(existing).createdAt; } catch { /* ignore */ }
            } else if ((await redis(['HLEN', KEY])) >= MAX_RESPONSES) {
                return res.status(429).json({ error: 'Too many responses stored' });
            }
            record.createdAt = record.createdAt || new Date().toISOString();
            record.updatedAt = new Date().toISOString();

            await redis(['HSET', KEY, record.id, JSON.stringify(record)]);
            return res.status(200).json({ ok: true, id: record.id });
        }

        // Everything below is owner-only
        if (!process.env.OWNER_PIN) {
            return res.status(503).json({ error: 'OWNER_PIN is not set in Vercel environment variables.' });
        }
        if (!pinMatches(req.headers['x-owner-pin'])) {
            return res.status(401).json({ error: 'Wrong PIN' });
        }

        if (req.method === 'GET') {
            const flat = (await redis(['HGETALL', KEY])) || [];
            const list = [];
            for (let i = 1; i < flat.length; i += 2) {
                try { list.push(JSON.parse(flat[i])); } catch { /* skip bad row */ }
            }
            list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
            return res.status(200).json({ responses: list });
        }

        if (req.method === 'DELETE') {
            const { id, all } = req.query || {};
            if (all === '1') {
                await redis(['DEL', KEY]);
                return res.status(200).json({ ok: true });
            }
            if (!isId(id)) return res.status(400).json({ error: 'Invalid id' });
            await redis(['HDEL', KEY, id]);
            return res.status(200).json({ ok: true });
        }

        res.setHeader('Allow', 'GET, POST, DELETE');
        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Server error' });
    }
};
