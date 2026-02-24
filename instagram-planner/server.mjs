import "dotenv/config";
import express from "express";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "127.0.0.1";
const defaultModel = process.env.OPENAI_MODEL || "gpt-5.2-2025-12-11";
const fallbackModel = process.env.OPENAI_FALLBACK_MODEL || "gpt-4o-mini";
const nextcloudUsername = process.env.NEXTCLOUD_USERNAME || "";
const nextcloudAppPassword = process.env.NEXTCLOUD_APP_PASSWORD || "";
const resolvedNextcloud = resolveNextcloudLocation(
  process.env.NEXTCLOUD_BASE_URL || "",
  process.env.NEXTCLOUD_DIR || "",
);
const nextcloudBaseUrl = resolvedNextcloud.baseUrl;
const nextcloudDir = resolvedNextcloud.dir || "/Bridger Gear/iCloud Photos";

app.use(express.json({ limit: "25mb" }));

app.post("/api/suggest", async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "OPENAI_API_KEY is not set on server" });
    return;
  }

  const mode = req.body?.mode;
  const imageDataUrl = req.body?.imageDataUrl;

  if (!["caption", "hashtags", "both"].includes(mode)) {
    res.status(400).json({ error: "Invalid mode" });
    return;
  }

  if (typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
    res.status(400).json({ error: "Invalid or missing imageDataUrl" });
    return;
  }

  try {
    let response = await callOpenAi({
      apiKey,
      model: defaultModel,
      mode,
      imageDataUrl,
    });

    if (!response.ok) {
      const errText = await response.text();
      const modelNotFound = /"code"\s*:\s*"model_not_found"/.test(errText);
      if (modelNotFound && fallbackModel && fallbackModel !== defaultModel) {
        response = await callOpenAi({
          apiKey,
          model: fallbackModel,
          mode,
          imageDataUrl,
        });
      } else {
        res.status(response.status).json({ error: `OpenAI error: ${errText}` });
        return;
      }
    }

    if (!response.ok) {
      const errText = await response.text();
      res.status(response.status).json({ error: `OpenAI error: ${errText}` });
      return;
    }

    const payload = await response.json();
    const output = extractOutputText(payload);
    const captionMatch = output.match(/CAPTION:\s*(.+)/i);
    const tagsMatch = output.match(/HASHTAGS:\s*(.+)/i);

    res.json({
      caption: captionMatch?.[1]?.trim() || "",
      hashtags: tagsMatch?.[1]?.trim() || "",
      raw: output,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/api/nextcloud/samples", async (_req, res) => {
  if (!hasNextcloudConfig()) {
    res.status(400).json({
      error: "Missing NEXTCLOUD_* env vars (base URL, username, app password).",
    });
    return;
  }

  const davUrl = buildNextcloudDavUrl(nextcloudDir);
  const authHeader = `Basic ${Buffer.from(`${nextcloudUsername}:${nextcloudAppPassword}`).toString("base64")}`;

  try {
    const entries = await crawlNextcloudImages({
      startDir: nextcloudDir,
      maxImages: 300,
      maxDepth: 6,
      authHeader,
    });
    const images = entries.slice(0, 200).map((entry) => ({
      name: entry.name,
      path: entry.path,
      url: `/api/nextcloud/file?path=${encodeURIComponent(entry.path)}`,
    }));
    res.json({ images });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/api/nextcloud/file", async (req, res) => {
  if (!hasNextcloudConfig()) {
    res.status(400).send("Missing Nextcloud env configuration.");
    return;
  }

  const relativePath = typeof req.query.path === "string" ? req.query.path : "";
  if (!relativePath) {
    res.status(400).send("Missing path query.");
    return;
  }

  const authHeader = `Basic ${Buffer.from(`${nextcloudUsername}:${nextcloudAppPassword}`).toString("base64")}`;
  const fileUrl = buildNextcloudDavUrl(`${nextcloudDir}/${relativePath}`);

  try {
    const response = await fetch(fileUrl, {
      method: "GET",
      signal: AbortSignal.timeout(12000),
      headers: { Authorization: authHeader },
    });

    if (!response.ok || !response.body) {
      const errText = await response.text();
      res.status(response.status || 502).send(errText || "Could not fetch file.");
      return;
    }

    res.setHeader("Content-Type", response.headers.get("content-type") || "application/octet-stream");
    Readable.fromWeb(response.body).pipe(res);
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : "Unknown error");
  }
});

app.use(express.static(__dirname));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`Instagram planner running on http://${host}:${port}`);
});

function buildPrompt(mode) {
  const common =
    "Analyze the image. Write in a polished Instagram style. Avoid cliches and keep it natural.";
  if (mode === "caption") {
    return `${common} Return exactly:\nCAPTION: <one caption only>`;
  }
  if (mode === "hashtags") {
    return `${common} Return exactly:\nHASHTAGS: <5-12 relevant hashtags, space-separated, each starts with #>`;
  }
  return `${common} Return exactly two lines:\nCAPTION: <one caption>\nHASHTAGS: <5-12 relevant hashtags, space-separated>`;
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const chunks = [];
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === "string") chunks.push(part.text);
    }
  }

  return chunks.join("\n").trim();
}

async function callOpenAi({ apiKey, model, mode, imageDataUrl }) {
  return fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: buildPrompt(mode) },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      ],
    }),
  });
}

function hasNextcloudConfig() {
  return Boolean(nextcloudBaseUrl && nextcloudUsername && nextcloudAppPassword);
}

function buildNextcloudDavUrl(rawPath) {
  const cleanPath = `/${String(rawPath || "").replace(/^\/+/, "")}`;
  const encodedPath = cleanPath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${nextcloudBaseUrl}/remote.php/dav/files/${encodeURIComponent(nextcloudUsername)}${encodedPath}`;
}

async function crawlNextcloudImages({ startDir, maxImages, maxDepth, authHeader }) {
  const root = `/${String(startDir || "").replace(/^\/+/, "").replace(/\/+$/, "")}`;
  const queue = [{ dir: root, depth: 0 }];
  const visited = new Set();
  const images = [];

  while (queue.length && images.length < maxImages) {
    const { dir, depth } = queue.shift();
    if (visited.has(dir)) continue;
    visited.add(dir);

    const response = await fetch(buildNextcloudDavUrl(dir), {
      method: "PROPFIND",
      signal: AbortSignal.timeout(12000),
      headers: {
        Authorization: authHeader,
        Depth: "1",
        "Content-Type": "application/xml",
      },
      body: `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype />
    <d:getcontenttype />
  </d:prop>
</d:propfind>`,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Nextcloud PROPFIND failed (${response.status}): ${errText}`);
    }

    const xml = await response.text();
    const entries = parseNextcloudEntries(xml);

    for (const entry of entries) {
      if (entry.path === dir.replace(/^\/+/, "")) continue;

      if (entry.isCollection) {
        if (depth < maxDepth) queue.push({ dir: `/${entry.path}`, depth: depth + 1 });
        continue;
      }

      if (!entry.contentType.startsWith("image/")) continue;

      const relativeFromRoot = entry.path.startsWith(root.replace(/^\/+/, ""))
        ? entry.path.slice(root.replace(/^\/+/, "").length).replace(/^\/+/, "")
        : entry.path;
      if (!relativeFromRoot) continue;

      images.push({
        path: relativeFromRoot,
        name: relativeFromRoot.split("/").pop() || relativeFromRoot,
      });
      if (images.length >= maxImages) break;
    }
  }

  return images;
}

function parseNextcloudEntries(xml) {
  const responseBlocks = xml.match(/<d:response[\s\S]*?<\/d:response>/g) || [];
  const results = [];

  for (const block of responseBlocks) {
    const hrefMatch = block.match(/<d:href>([\s\S]*?)<\/d:href>/);
    if (!hrefMatch?.[1]) continue;

    const href = decodeURIComponent(hrefMatch[1]);
    const path = extractDavRelativePath(href);
    if (!path) continue;

    const contentTypeMatch = block.match(/<d:getcontenttype>([\s\S]*?)<\/d:getcontenttype>/);
    const contentType = (contentTypeMatch?.[1] || "").trim().toLowerCase();
    const isCollection = /<d:resourcetype>[\s\S]*<d:collection\/>[\s\S]*<\/d:resourcetype>/i.test(
      block,
    );

    results.push({
      path,
      contentType,
      isCollection,
    });
  }

  return results;
}

function extractDavRelativePath(href) {
  const hrefPath = href.replace(/^https?:\/\/[^/]+/i, "");
  const marker = "/remote.php/dav/files/";
  const markerIndex = hrefPath.indexOf(marker);
  if (markerIndex < 0) return "";
  const tail = hrefPath.slice(markerIndex + marker.length);
  const slashIdx = tail.indexOf("/");
  if (slashIdx < 0) return "";
  return tail.slice(slashIdx + 1).replace(/^\/+/, "").replace(/\/+$/, "");
}

function resolveNextcloudLocation(baseInput, dirInput) {
  let baseUrl = String(baseInput || "").trim();
  let dir = String(dirInput || "").trim();

  try {
    if (baseUrl && baseUrl.includes("/apps/files/files")) {
      const parsed = new URL(baseUrl);
      if (!dir) dir = parsed.searchParams.get("dir") || "";
      baseUrl = parsed.origin;
    } else if (baseUrl) {
      const parsed = new URL(baseUrl);
      baseUrl = parsed.origin;
    }
  } catch {
    // Keep raw values; config validation happens elsewhere.
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    dir: dir || "",
  };
}
