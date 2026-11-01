# Architecture

## Goal

Perfect SMP Images is a public image library, not a personal browser gallery. If Alice uploads an image and Bob opens the website on another device, Bob must see the same upload. That requirement determines the storage design.

## Components

### Static frontend

`public/` contains the website. Cloudflare Workers Static Assets deploys it together with the Worker. The frontend uses only same-origin requests and has no dependency on a third-party JavaScript CDN.

### Worker

`src/worker.js` is the HTTP entry point. It handles API requests, raw image requests, deletion authorization and SPA share routes. Requests that are not API/raw/share routes fall through to the `ASSETS` binding.

### D1

D1 stores public metadata:

- image ID
- display title
- original filename
- public uploader label
- R2 object key
- byte size
- MIME type
- width and height
- upload timestamp
- tags
- hash of the private delete token

The global feed always comes from D1.

### R2

R2 stores the original image bytes. The database contains only the R2 object key. The Worker exposes `/raw/:id` so the R2 bucket itself does not need to be made independently public.

### Minecraft plugin

The plugin does not host or store the image collection. It knows the website origin and image ID format. This keeps the Minecraft server lightweight.

The plugin commands are:

- `/imagewebsite`
- `/uploadimage`
- `/image <id-or-link>`
- `/showimage <id>`
- `/closeimage`

When a player posts an image, the plugin validates that the image exists and sends a `tellraw` message with website and ingame viewer actions.

## Why D1 instead of browser storage

Browser storage cannot provide a community feed. IndexedDB belongs to one browser profile on one device. It is useful for temporary drafts or private preferences, but it cannot answer "show me every upload from every visitor".

D1 provides the shared source of truth. The website can be opened from a phone, desktop or another player's PC and the result set remains the same.

## Why R2 instead of D1 blobs

D1 is the metadata database. Large binary image objects belong in object storage. R2 is optimized for that purpose and is directly available to Workers through a binding.

## IDs

The Worker creates a random 12-byte identifier and encodes it in URL-safe Base64. IDs are therefore short enough for Minecraft chat but difficult to guess sequentially.

Example:

```text
Wz4c8x4g6fPzH_yM
```

An image has two important URLs:

```text
/image/Wz4c8x4g6fPzH_yM
/raw/Wz4c8x4g6fPzH_yM
```

The first is the human-facing share page. The second is binary data used by the Minecraft map renderer.

## Deletion model

The website is open for public viewing and public uploads. Public deletion would be dangerous because anyone could delete anyone else's image.

For each upload the Worker creates 32 random bytes as a delete token. The browser receives the token once. D1 stores only SHA-256(token).

When the uploader later deletes the image, the browser sends the token in an authorization header. The Worker hashes it and compares the result to D1.

This gives a simple ownership mechanism without requiring user accounts.

The tradeoff is intentional: clearing the browser's site storage loses the user's delete token. An owner/admin can still keep an `ADMIN_DELETE_TOKEN` Cloudflare secret for moderation.

## Plugin URL safety

`/image` and `/showimage` accept IDs or URLs, but arbitrary third-party URLs are rejected. A URL must use the configured Perfect SMP Images hostname before the plugin extracts an ID.

That is important because an unrestricted server-side URL fetcher can become an SSRF primitive. The plugin therefore constructs the actual image download URL itself:

```text
configuredWebsite + /raw/ + validatedId
```

It never downloads the URL supplied verbatim by the player.

## Minecraft map viewer

Vanilla Minecraft does not support arbitrary remote PNG/JPG rendering inside a normal chest GUI. A server-only plugin can, however, render image pixels onto a map.

The plugin downloads the image, decodes it with ImageIO, fits it into a 128×128 map canvas while preserving aspect ratio, temporarily replaces the selected hotbar item with the map and calls `Player#sendMap`.

During the viewer session inventory movement, dropping, hand swapping and hotbar switching are cancelled. `/closeimage` restores the original item. Quit and plugin shutdown also restore the saved item.

## Scaling

The public list endpoint supports pagination. The frontend requests 48 images per page and can load more. D1 therefore does not need to return the entire historical library in one response.

The user's requirement that every historical image remains visible is still met: old images remain queryable through pagination/search and keep stable IDs/links until explicitly deleted.

## Custom domain

The Worker can run on `*.workers.dev` or a Cloudflare custom domain. A custom domain such as:

```text
images.perfectsmp.net
```

is preferable because the Minecraft plugin's allowed host remains stable even if the Worker project name later changes.

## GitHub deployment

The repository contains two Actions workflows.

`deploy.yml` deploys Worker + static assets and applies D1 migrations.

`build-plugin.yml` compiles the Maven plugin project and stores the JAR as a GitHub Actions artifact.

## Repository structure

```text
PerfectSMPImages/
├── .github/
│   └── workflows/
│       ├── deploy.yml
│       └── build-plugin.yml
├── docs/
│   ├── API.md
│   └── ARCHITECTURE.md
├── migrations/
│   └── 0001_init.sql
├── plugin/
│   ├── pom.xml
│   └── src/main/
│       ├── java/de/perfectsmp/images/PerfectSMPImagesPlugin.java
│       └── resources/
│           ├── plugin.yml
│           └── config.yml
├── plugin-dist/
│   └── PerfectSMPImages-1.0.0.jar
├── public/
│   ├── app.js
│   ├── index.html
│   ├── logo.png
│   └── styles.css
├── src/
│   └── worker.js
├── package.json
├── README.md
└── wrangler.toml
```
