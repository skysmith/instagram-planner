# Instagram Post Planner (Local Web Portal)

A local-first planner for Instagram posts that works with images in synced iCloud Drive and Google Drive folders.

## Features

- Connect two local folders (iCloud + Google Drive) from your browser
- Browse images recursively from both folders
- Draft caption, hashtags, and scheduled datetime per image
- Generate AI caption/hashtags from the selected image (server-side OpenAI key)
- View and manage a publishing queue
- Export/import plans as JSON

## Run

1. Install dependencies:

```bash
cd instagram-planner
npm install
```

2. Create a local env file:

```bash
cp .env.example .env
```

3. Edit `.env` and set at minimum:

- `OPENAI_API_KEY`

4. Start the app:

```bash
npm start
```

Then open `http://localhost:8080` in Chrome, Edge, or Safari.

## Important notes

- Chrome/Edge use direct folder access (`showDirectoryPicker`).
- Safari uses a fallback folder upload picker (`webkitdirectory`) that reads the chosen folder contents.
- For iCloud/Google Drive, choose folders that are already synced to your local machine.
- This MVP stores plans in browser local storage.
- AI requests go through `POST /api/suggest` on the local server.
- The OpenAI API key stays on the server via env var (`OPENAI_API_KEY`), not in browser code.
- Optional Nextcloud image samples:
  - Add `NEXTCLOUD_BASE_URL`, `NEXTCLOUD_USERNAME`, `NEXTCLOUD_APP_PASSWORD`, `NEXTCLOUD_DIR` in `.env`.
  - Then use `Load Nextcloud samples` in the UI.
  - `NEXTCLOUD_BASE_URL` can be either the bare host (`http://174.52.247.20`) or the full files URL (`.../apps/files/files?dir=...`).
  - Shared files UI links are converted server-side to WebDAV under `/remote.php/dav/files/...`.
