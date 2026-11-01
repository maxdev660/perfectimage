# Perfect SMP Images — Cloudflare Pages

This repository is prepared for **Cloudflare Pages**, not Workers Static Assets.

## GitHub structure

Upload the repository contents exactly as-is. Important files/directories are:

- `public/` — website files published by Pages
- `functions/[[path]].js` — Pages Function handling `/api/*` and `/raw/*`
- `migrations/0001_init.sql` — D1 schema
- `wrangler.toml` — tells Pages that `public/` is the output directory
- `plugin-dist/PerfectSMPImages-1.0.0.jar` — Minecraft plugin

## Cloudflare Pages settings

For the existing Pages project `perfectsmpimage`:

- Production branch: `main`
- Build command: leave empty (or use `npm run build`)
- Build output directory: `public`
- Root directory: `/`

The included `wrangler.toml` also contains `pages_build_output_dir = "./public"` so Cloudflare can detect the output directory.

## Bindings

In **Pages project → Settings → Bindings** add:

### D1
- Type: D1 database
- Variable name: `DB`
- Database: your `perfect-smp-images` database

### R2
- Type: R2 bucket
- Variable name: `IMAGES`
- Bucket: your `perfect-smp-images` bucket

Optional secret:

- `ADMIN_DELETE_TOKEN`

After changing bindings, create a new Pages deployment.

## D1 setup

Open the Cloudflare D1 console for your database and execute the complete contents of:

`migrations/0001_init.sql`

## Tests

After deployment these URLs should work:

- `/` — website
- `/api/health` — binding status
- `/api/images` — global public image list
- `/image/<id>` — SPA share page
- `/raw/<id>` — direct image bytes

All uploaded images are stored globally in R2 and their public metadata is stored in D1, so every visitor sees uploads made by every other visitor.
