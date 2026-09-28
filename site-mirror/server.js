const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = __dirname;
const WWW = path.join(ROOT, "www");
const MEDIA = path.join(ROOT, "content", "media");
const PROGRESS_FILE = path.join(ROOT, "content", "progress.json");
const PORT = Number(process.env.PORT) || 4173;
const ORIGIN = "https://nextmodels.space";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function localize(value) {
  if (typeof value === "string") return value.split(ORIGIN).join("");
  if (Array.isArray(value)) return value.map(localize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = localize(item);
    return out;
  }
  return value;
}

const user = localize(readJson(path.join(ROOT, "content", "me.json")));
const themes = localize(readJson(path.join(ROOT, "content", "themes.json")));
const branding = localize(readJson(path.join(WWW, "api", "settings", "branding.json")));
const lessons = new Map();
for (const file of fs.readdirSync(path.join(ROOT, "content", "lessons"))) {
  if (!file.endsWith(".json")) continue;
  const lesson = localize(readJson(path.join(ROOT, "content", "lessons", file)));
  lessons.set(lesson.id, lesson);
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return [];
  return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
}

function saveProgress(items) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(items, null, 2));
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-cache",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function safeFile(root, urlPath) {
  const rel = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) return null;
  return file;
}

function serveFile(req, res, file) {
  const stat = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match && match[1] ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : stat.size - 1;
    if (start > end || end >= stat.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/auth/me") return sendJson(res, 200, user);
  if (req.method === "POST" && pathname === "/api/auth/login") return sendJson(res, 200, { user });
  if (req.method === "POST" && (pathname === "/api/auth/logout" || pathname === "/api/auth/logout-all")) {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "GET" && pathname === "/api/lessons/themes") return sendJson(res, 200, themes);
  if (req.method === "GET" && pathname === "/api/settings/branding") return sendJson(res, 200, branding);
  if (req.method === "GET" && pathname === "/api/progress/my") return sendJson(res, 200, loadProgress());
  if (req.method === "GET" && pathname.startsWith("/api/lessons/lessons/")) {
    const id = pathname.slice("/api/lessons/lessons/".length);
    const lesson = lessons.get(id);
    if (!lesson) return sendJson(res, 404, { message: "Урок не найден" });
    return sendJson(res, 200, lesson);
  }
  if (req.method === "POST" && pathname === "/api/progress") {
    const body = await readBody(req);
    const items = loadProgress();
    const index = items.findIndex((item) => item.theme_id === body.theme_id && item.lesson_id === body.lesson_id);
    const next = {
      ...(index >= 0 ? items[index] : {}),
      theme_id: body.theme_id,
      lesson_id: body.lesson_id,
      started: body.started !== false,
      completed: Boolean(body.completed),
      data: body.data || (index >= 0 ? items[index].data : {}),
    };
    if (index >= 0) items[index] = next;
    else items.push(next);
    saveProgress(items);
    return sendJson(res, 200, next);
  }
  return sendJson(res, 404, { message: "Не найдено" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }
    const candidates = [safeFile(MEDIA, pathname), safeFile(WWW, pathname)].filter(Boolean);
    for (const file of candidates) {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        serveFile(req, res, file);
        return;
      }
    }
    serveFile(req, res, path.join(WWW, "index.html"));
  } catch (err) {
    sendJson(res, 500, { message: "Ошибка сервера" });
    console.error(err);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Local copy: http://127.0.0.1:${PORT}/courses`);
});
