CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    filename TEXT NOT NULL,
    uploader_name TEXT NOT NULL DEFAULT 'Guest',
    object_key TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL,
    type TEXT NOT NULL,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    delete_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_images_created_at ON images(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_name ON images(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_images_uploader ON images(uploader_name COLLATE NOCASE);
