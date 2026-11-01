# Perfect SMP Images API

The API is intentionally small. The public website and Minecraft plugin both use the same image IDs, so a post has one identity everywhere.

## Base URL

Use the same origin as the website, for example:

```text
https://images.example.com
```

## GET /api/health

Simple health endpoint.

Example response:

```json
{
  "ok": true,
  "service": "Perfect SMP Images",
  "now": 1793500000000
}
```

## GET /api/images

Returns the global public feed. This endpoint never reads browser-local state. Every result comes from the shared D1 database.

Query parameters:

- `page`: one-based page number, default `1`
- `limit`: number of items, default `48`, maximum `100`
- `search`: title, filename, uploader or tag search
- `sort`: `newest`, `oldest`, `name-asc`, `name-desc`, `size-desc`, `size-asc`

Example:

```text
GET /api/images?page=1&limit=48&sort=newest&search=spawn
```

Example response shape:

```json
{
  "images": [
    {
      "id": "Wz4c8x4g6fPzH_yM",
      "name": "Spawn at sunset",
      "filename": "2026-11-01_18.31.22.png",
      "uploaderName": "Steve",
      "size": 1842021,
      "type": "image/png",
      "width": 2560,
      "height": 1440,
      "created": 1793500000000,
      "tags": ["spawn", "sunset"],
      "url": "https://images.example.com/raw/Wz4c8x4g6fPzH_yM",
      "rawUrl": "https://images.example.com/raw/Wz4c8x4g6fPzH_yM",
      "thumbnailUrl": "https://images.example.com/raw/Wz4c8x4g6fPzH_yM",
      "publicUrl": "https://images.example.com/image/Wz4c8x4g6fPzH_yM"
    }
  ],
  "page": 1,
  "limit": 48,
  "total": 151,
  "hasMore": true
}
```

## GET /api/images/:id

Returns metadata for one image. The Minecraft plugin can use the same ID to retrieve `/raw/:id`.

Example:

```text
GET /api/images/Wz4c8x4g6fPzH_yM
```

Response:

```json
{
  "image": {
    "id": "Wz4c8x4g6fPzH_yM",
    "name": "Spawn at sunset",
    "uploaderName": "Steve",
    "publicUrl": "https://images.example.com/image/Wz4c8x4g6fPzH_yM",
    "rawUrl": "https://images.example.com/raw/Wz4c8x4g6fPzH_yM"
  }
}
```

## POST /api/images

Creates a global public post and stores the original file in R2.

Content type:

```text
multipart/form-data
```

Fields:

- `image`: required file
- `name`: optional display title, maximum 120 characters
- `uploader`: optional public uploader label, maximum 48 characters
- `tags`: JSON array or comma-separated tags, maximum eight normalized tags
- `width`: client-detected pixel width
- `height`: client-detected pixel height

Accepted image MIME types:

- `image/png`
- `image/jpeg`
- `image/webp`

Default maximum file size is 15 MB. Change `MAX_UPLOAD_BYTES` in `wrangler.toml` if needed.

The successful response also contains a one-time delete token:

```json
{
  "image": {
    "id": "Wz4c8x4g6fPzH_yM"
  },
  "deleteToken": "private-random-token"
}
```

The website stores that token in the uploader browser's localStorage. The token itself is not written into D1. Only its SHA-256 hash is stored.

## DELETE /api/images/:id

Deletes an upload when the caller proves it owns the delete token.

Header option one:

```text
Authorization: Bearer DELETE_TOKEN
```

Header option two:

```text
X-Delete-Token: DELETE_TOKEN
```

The optional Cloudflare secret `ADMIN_DELETE_TOKEN` can also authorize deletion. Never put that secret into frontend JavaScript or the Minecraft plugin.

Successful response:

```json
{
  "ok": true
}
```

## GET /raw/:id

Returns the original image bytes from R2. The Minecraft plugin uses this endpoint for the ingame map renderer.

The response uses long immutable cache headers because an image ID always identifies the same uploaded object. Deleted images return `404`.

## GET /image/:id

Loads the SPA shell. The frontend recognizes the route and requests `/api/images/:id` to show the public image detail screen.

This is the preferred share URL because it gives normal browser visitors a complete page rather than only raw image bytes.

## Minecraft command mapping

A browser share page:

```text
https://images.example.com/image/Wz4c8x4g6fPzH_yM
```

becomes:

```text
/image https://images.example.com/image/Wz4c8x4g6fPzH_yM
```

The plugin extracts the ID, validates that the hostname matches its configured website, performs a HEAD request to `/raw/:id`, and only then broadcasts clickable `OPEN WEBSITE` and `SHOW INGAME` buttons.

## Error format

Most API errors use JSON:

```json
{
  "error": "error_code",
  "message": "Human-readable explanation"
}
```

Common status codes:

- `400` malformed upload
- `403` invalid delete token
- `404` missing image
- `413` image too large
- `415` unsupported image type
- `500` server-side error

## Caching

Metadata API responses use `no-store` so the public feed updates immediately. Raw image objects are immutable and use a one-year public cache lifetime.

## CORS

The API currently returns permissive CORS headers because the Minecraft plugin and future custom frontends may use the same public read API. If only one website origin should use browser-side API requests, narrow `Access-Control-Allow-Origin` in `src/worker.js`.
