const ALLOWED_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
]);

const DEFAULT_MAX_UPLOAD = 15 * 1024 * 1024;

export async function onRequest(context) {
  const request = context.request;
  const env = context.env;
  const url = new URL(request.url);

  try {
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return await health(env);
    }

    if (url.pathname === '/api/images' && request.method === 'GET') {
      return await listImages(request, env);
    }

    if (url.pathname === '/api/images' && request.method === 'POST') {
      return await createImage(request, env);
    }

    const apiImageMatch = url.pathname.match(/^\/api\/images\/([A-Za-z0-9_-]+)$/);
    if (apiImageMatch) {
      const id = apiImageMatch[1];
      if (request.method === 'GET') return await getImageMetadata(request, env, id);
      if (request.method === 'DELETE') return await deleteImage(request, env, id);
    }

    const rawMatch = url.pathname.match(/^\/raw\/([A-Za-z0-9_-]+)$/);
    if (rawMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      return await serveRawImage(request, env, rawMatch[1]);
    }

    return json({ error: 'not_found' }, 404);
  } catch (error) {
    console.error(error);
    return json({
      error: 'internal_error',
      message: error instanceof Error ? error.message : 'Something went wrong.'
    }, 500);
  }
}

async function health(env) {
  let database = false;
  let storage = false;

  try {
    await env.DB.prepare('SELECT 1 AS ok').first();
    database = true;
  } catch {}

  try {
    await env.IMAGES.list({ limit: 1 });
    storage = true;
  } catch {}

  return json({
    ok: database && storage,
    service: 'Perfect SMP Images',
    platform: 'cloudflare-pages',
    database,
    storage,
    now: Date.now(),
  });
}

async function listImages(request, env) {
  requireBindings(env);

  const url = new URL(request.url);
  const page = clampInt(url.searchParams.get('page'), 1, 1, 100000);
  const limit = clampInt(url.searchParams.get('limit'), 48, 1, 100);
  const offset = (page - 1) * limit;
  const search = (url.searchParams.get('search') || '').trim().slice(0, 120);
  const sort = url.searchParams.get('sort') || 'newest';

  const orderBy = {
    newest: 'created_at DESC',
    oldest: 'created_at ASC',
    'name-asc': 'name COLLATE NOCASE ASC',
    'name-desc': 'name COLLATE NOCASE DESC',
    'size-desc': 'size DESC',
    'size-asc': 'size ASC',
  }[sort] || 'created_at DESC';

  let where = '';
  const bindings = [];

  if (search) {
    where = 'WHERE name LIKE ? ESCAPE \'\\\' OR filename LIKE ? ESCAPE \'\\\' OR uploader_name LIKE ? ESCAPE \'\\\' OR tags LIKE ? ESCAPE \'\\\'';
    const like = `%${escapeLike(search)}%`;
    bindings.push(like, like, like, like);
  }

  const countStatement = env.DB.prepare(`SELECT COUNT(*) AS total FROM images ${where}`);
  const countResult = bindings.length
    ? await countStatement.bind(...bindings).first()
    : await countStatement.first();

  const listStatement = env.DB.prepare(`
    SELECT id, name, filename, uploader_name, object_key, size, type,
           width, height, created_at, tags
      FROM images
      ${where}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?
  `);

  const result = await listStatement.bind(...bindings, limit, offset).all();
  const total = Number(countResult?.total || 0);
  const origin = url.origin;
  const rows = result.results || [];

  return json({
    images: rows.map(row => publicImage(row, origin)),
    page,
    limit,
    total,
    hasMore: offset + rows.length < total,
  });
}

async function getImageMetadata(request, env, id) {
  requireBindings(env);

  const row = await env.DB.prepare(`
    SELECT id, name, filename, uploader_name, object_key, size, type,
           width, height, created_at, tags
      FROM images
     WHERE id = ?
     LIMIT 1
  `).bind(id).first();

  if (!row) return json({ error: 'not_found', message: 'Image not found.' }, 404);
  return json({ image: publicImage(row, new URL(request.url).origin) });
}

async function createImage(request, env) {
  requireBindings(env);

  const maxBytes = Number(env.MAX_UPLOAD_BYTES || DEFAULT_MAX_UPLOAD) || DEFAULT_MAX_UPLOAD;
  const form = await request.formData();
  const file = form.get('image');

  if (!file || typeof file === 'string' || typeof file.stream !== 'function') {
    return json({ error: 'missing_image', message: 'No image file was provided.' }, 400);
  }

  if (!ALLOWED_TYPES.has(file.type)) {
    return json({ error: 'unsupported_type', message: 'Only PNG, JPG and WEBP are allowed.' }, 415);
  }

  if (file.size <= 0 || file.size > maxBytes) {
    return json({
      error: 'invalid_size',
      message: `Image must be between 1 byte and ${maxBytes} bytes.`
    }, 413);
  }

  const suppliedName = cleanText(form.get('name'), 120);
  const uploaderName = cleanText(form.get('uploader'), 48) || 'Guest';
  const width = clampInt(form.get('width'), 0, 0, 100000);
  const height = clampInt(form.get('height'), 0, 0, 100000);
  const tags = parseTags(form.get('tags'));

  const id = randomId();
  const extension = ALLOWED_TYPES.get(file.type);
  const objectKey = `images/${id}.${extension}`;
  const createdAt = Date.now();
  const originalFilename = cleanText(file.name, 180) || `${id}.${extension}`;
  const name = suppliedName || stripExtension(originalFilename).slice(0, 120) || 'Untitled image';
  const deleteToken = randomToken();
  const deleteHash = await sha256Hex(deleteToken);

  await env.IMAGES.put(objectKey, file.stream(), {
    httpMetadata: {
      contentType: file.type,
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: {
      id,
      originalFilename,
      uploaderName,
    },
  });

  try {
    await env.DB.prepare(`
      INSERT INTO images (
        id, name, filename, uploader_name, object_key, size, type,
        width, height, created_at, tags, delete_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      name,
      originalFilename,
      uploaderName,
      objectKey,
      file.size,
      file.type,
      width,
      height,
      createdAt,
      JSON.stringify(tags),
      deleteHash,
    ).run();
  } catch (error) {
    await env.IMAGES.delete(objectKey);
    throw error;
  }

  const row = {
    id,
    name,
    filename: originalFilename,
    uploader_name: uploaderName,
    object_key: objectKey,
    size: file.size,
    type: file.type,
    width,
    height,
    created_at: createdAt,
    tags: JSON.stringify(tags),
  };

  return json({
    image: publicImage(row, new URL(request.url).origin),
    deleteToken,
  }, 201);
}

async function deleteImage(request, env, id) {
  requireBindings(env);

  const row = await env.DB.prepare(`
    SELECT id, object_key, delete_hash
      FROM images
     WHERE id = ?
     LIMIT 1
  `).bind(id).first();

  if (!row) return json({ error: 'not_found', message: 'Image not found.' }, 404);

  const suppliedToken = bearerToken(request) || request.headers.get('x-delete-token') || '';
  const adminToken = String(env.ADMIN_DELETE_TOKEN || '');
  let allowed = false;

  if (adminToken && timingSafeStringEqual(suppliedToken, adminToken)) {
    allowed = true;
  } else if (suppliedToken) {
    const suppliedHash = await sha256Hex(suppliedToken);
    allowed = timingSafeStringEqual(suppliedHash, row.delete_hash || '');
  }

  if (!allowed) {
    return json({ error: 'forbidden', message: 'A valid delete token is required.' }, 403);
  }

  await env.IMAGES.delete(row.object_key);
  await env.DB.prepare('DELETE FROM images WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function serveRawImage(request, env, id) {
  requireBindings(env);

  const row = await env.DB.prepare(`
    SELECT object_key, type, filename
      FROM images
     WHERE id = ?
     LIMIT 1
  `).bind(id).first();

  if (!row) return new Response('Not found', { status: 404 });

  const object = await env.IMAGES.get(row.object_key);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', row.type || headers.get('Content-Type') || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Content-Disposition', `inline; filename="${sanitizeHeaderFilename(row.filename || 'image')}"`);
  if (object.httpEtag) headers.set('ETag', object.httpEtag);

  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }

  return new Response(object.body, { status: 200, headers });
}

function requireBindings(env) {
  if (!env.DB) {
    throw new Error('Missing Cloudflare Pages D1 binding: DB');
  }

  if (!env.IMAGES) {
    throw new Error('Missing Cloudflare Pages R2 binding: IMAGES');
  }
}

function publicImage(row, origin) {
  const id = String(row.id);
  return {
    id,
    name: row.name || row.filename || 'Untitled image',
    filename: row.filename || 'image',
    uploaderName: row.uploader_name || 'Guest',
    size: Number(row.size || 0),
    type: row.type || 'image/*',
    width: Number(row.width || 0),
    height: Number(row.height || 0),
    created: Number(row.created_at || 0),
    tags: parseStoredTags(row.tags),
    url: `${origin}/raw/${encodeURIComponent(id)}`,
    rawUrl: `${origin}/raw/${encodeURIComponent(id)}`,
    thumbnailUrl: `${origin}/raw/${encodeURIComponent(id)}`,
    publicUrl: `${origin}/image/${encodeURIComponent(id)}`,
  };
}

function parseStoredTags(value) {
  if (Array.isArray(value)) return value.map(String).slice(0, 8);
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String).slice(0, 8) : [];
  } catch {
    return [];
  }
}

function parseTags(value) {
  if (!value) return [];
  let raw;

  try {
    raw = JSON.parse(String(value));
  } catch {
    raw = String(value).split(',');
  }

  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  const result = [];

  for (const item of raw) {
    const tag = String(item)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 24);

    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= 8) break;
  }

  return result;
}

function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function stripExtension(filename) {
  return String(filename || '').replace(/\.[^.]+$/, '');
}

function sanitizeHeaderFilename(filename) {
  return String(filename).replace(/["\r\n\\]/g, '_').slice(0, 180);
}

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(String(value));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

function bearerToken(request) {
  const auth = request.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function timingSafeStringEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, ch => `\\${ch}`);
}

function json(payload, status = 200) {
  return cors(new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    },
  }));
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS,HEAD');
  headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Delete-Token');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
