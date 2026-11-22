import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VACANCIES, normalizeVacancyList } from './assets/js/vacancy-logic.js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './assets/js/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const VACANCIES_FILE = path.join(DATA_DIR, 'vacancies.json');

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

async function readVacancyStore() {
  try {
    const raw = await fs.readFile(VACANCIES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const list = normalizeVacancyList(parsed?.vacancies);
    if (list.length) {
      return {
        vacancies: list,
        updatedAt: parsed?.updatedAt || null,
        customized: parsed?.customized === true
      };
    }
  } catch {
    // Initialize default store when file does not exist yet
  }
  const initial = {
    vacancies: normalizeVacancyList(DEFAULT_VACANCIES),
    updatedAt: new Date().toISOString(),
    customized: false
  };
  await writeVacancyStore(initial.vacancies, initial.updatedAt, false);
  return initial;
}

async function writeVacancyStore(vacancies, updatedAt = new Date().toISOString(), customized = true) {
  const clean = normalizeVacancyList(vacancies);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload = { vacancies: clean, updatedAt, customized };
  await fs.writeFile(VACANCIES_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

async function verifyPortalAdminToken(authHeader = '') {
  const match = String(authHeader || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const token = match[1].trim();
  if (!token) return false;

  const baseUrl = String(SUPABASE_URL || '').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/rest/v1/rpc/is_portal_admin`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: '{}'
  });
  if (!response.ok) return false;
  const result = await response.json().catch(() => false);
  return result === true;
}

app.get('/api/vacancies', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    const store = await readVacancyStore();
    res.json(store);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Gagal memuat daftar lowongan.' });
  }
});

app.put('/api/vacancies', async (req, res) => {
  try {
    const authorized = await verifyPortalAdminToken(req.headers.authorization);
    if (!authorized) {
      return res.status(401).json({ error: 'Sesi admin tidak valid.' });
    }
    const incoming = req.body?.vacancies;
    if (!Array.isArray(incoming)) {
      return res.status(400).json({ error: 'Format daftar lowongan tidak valid.' });
    }
    const clean = normalizeVacancyList(incoming);
    if (!clean.length) {
      return res.status(400).json({ error: 'Minimal satu lowongan harus tersedia.' });
    }
    const saved = await writeVacancyStore(clean);
    res.json(saved);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Gagal menyimpan daftar lowongan.' });
  }
});

// Replicate caching headers from vercel.json / _headers
app.use((req, res, next) => {
  const reqPath = req.path;
  if (
    reqPath === '/form' ||
    reqPath === '/form/' ||
    reqPath.startsWith('/form/') ||
    reqPath === '/apply' ||
    reqPath === '/apply/' ||
    reqPath === '/sw.js'
  ) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  } else if (reqPath.startsWith('/assets/')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  next();
});

// Prevent exposing internal server/backup/test/data files over HTTP
app.use((req, res, next) => {
  const reqPath = req.path.toLowerCase();
  if (
    reqPath === '/server.js' ||
    reqPath === '/package.json' ||
    reqPath === '/package-lock.json' ||
    reqPath.startsWith('/ai_context_') ||
    reqPath.startsWith('/qa/') ||
    reqPath.startsWith('/tests/') ||
    reqPath.startsWith('/data/')
  ) {
    return res.status(404).sendFile(path.join(__dirname, '404.html'));
  }
  next();
});

app.use(
  express.static(__dirname, {
    index: 'index.html',
    dotfiles: 'ignore',
    extensions: ['html']
  })
);

// Serve 404.html for unmatched routes (preserves /tahap-1/ .. /tahap-4/ redirect logic)
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '404.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Portal Karir server listening on http://${HOST}:${PORT}`);
});
