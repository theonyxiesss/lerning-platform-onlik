const fs = require("fs");
const path = require("path");
const https = require("https");

const ORIGIN = "https://nextmodels.space";
const OUT = path.join(__dirname, "content");
const username = process.env.LP_USER;
const password = process.env.LP_PASS;
if (!username || !password) {
  console.error("missing credentials");
  process.exit(1);
}

let cookie = "";

function request(method, pathname, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {
      Accept: "application/json",
      "User-Agent": "site-mirror",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(extraHeaders || {}),
    };
    if (data) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = data.length;
    }
    const req = https.request(
      ORIGIN + pathname,
      { method, headers },
      (res) => {
        const set = res.headers["set-cookie"];
        if (set) {
          const parts = (Array.isArray(set) ? set : [set]).map((c) => c.split(";")[0]);
          const jar = new Map(
            cookie
              .split("; ")
              .filter(Boolean)
              .map((p) => [p.slice(0, p.indexOf("=")), p])
          );
          for (const p of parts) jar.set(p.slice(0, p.indexOf("=")), p);
          cookie = [...jar.values()].join("; ");
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const type = res.headers["content-type"] || "";
          let json = null;
          if (type.includes("json")) {
            try {
              json = JSON.parse(buf.toString("utf8"));
            } catch {}
          }
          resolve({ status: res.statusCode, type, buf, json, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error("timeout " + pathname)));
    if (data) req.write(data);
    req.end();
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "site-mirror", ...(cookie ? { Cookie: cookie } : {}) } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          download(new URL(res.headers.location, url).href, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          resolve({ status: res.statusCode, bytes: 0 });
          return;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve({ status: 200, bytes: fs.statSync(dest).size });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10 * 60 * 1000, () => req.destroy(new Error("timeout " + url)));
  });
}

function collectUrls(value, found) {
  if (!value) return;
  if (typeof value === "string") {
    const re = /https?:\/\/nextmodels\.space\/[^\s"'<>]+/g;
    let m;
    while ((m = re.exec(value))) found.add(m[0].replace(/[),.;]+$/, ""));
    if (value.startsWith("/storage/")) found.add(ORIGIN + value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, found);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) collectUrls(v, found);
  }
}

(async () => {
  const login = await request("POST", "/api/auth/login", { username, password });
  console.log("login", login.status, login.json && (login.json.full_name || login.json.role || login.json.message));
  if (login.status !== 200) {
    console.log(JSON.stringify(login.json));
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const me = await request("GET", "/api/auth/me");
  fs.writeFileSync(path.join(OUT, "me.json"), JSON.stringify(me.json, null, 2));

  const themes = await request("GET", "/api/lessons/themes");
  console.log("themes", themes.status);
  if (themes.status !== 200) {
    console.log(JSON.stringify(themes.json));
    process.exit(1);
  }
  fs.writeFileSync(path.join(OUT, "themes.json"), JSON.stringify(themes.json, null, 2));

  const list = themes.json.themes || [];
  let modules = 0;
  let lessons = 0;
  const lessonIds = [];
  for (const theme of list) {
    for (const mod of theme.modules || []) {
      modules++;
      for (const lesson of mod.lessons || []) {
        lessons++;
        if (lesson.id) lessonIds.push(lesson.id);
      }
    }
  }
  console.log("counts", { themes: list.length, modules, lessons });

  const fullDir = path.join(OUT, "lessons");
  fs.mkdirSync(fullDir, { recursive: true });
  const fullLessons = [];
  for (const id of lessonIds) {
    const res = await request("GET", "/api/lessons/lessons/" + id);
    console.log("lesson", res.status, id);
    if (res.status === 200) {
      fs.writeFileSync(path.join(fullDir, id + ".json"), JSON.stringify(res.json, null, 2));
      fullLessons.push(res.json);
    }
  }

  const urls = new Set();
  collectUrls(themes.json, urls);
  for (const lesson of fullLessons) collectUrls(lesson, urls);
  const mediaDir = path.join(OUT, "media");
  const mediaLog = [];
  for (const url of urls) {
    let pathname;
    try {
      pathname = new URL(url).pathname;
    } catch {
      continue;
    }
    const dest = path.join(mediaDir, pathname.replace(/^\//, "").replace(/[:*?"<>|]/g, "_"));
    const result = await download(url, dest);
    mediaLog.push({ url, status: result.status, bytes: result.bytes });
    console.log("media", result.status, result.bytes, pathname);
  }
  fs.writeFileSync(path.join(OUT, "media-log.json"), JSON.stringify(mediaLog, null, 2));
  console.log("DONE");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
