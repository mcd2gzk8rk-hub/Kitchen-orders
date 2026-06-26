const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const port = Number(process.env.PORT || 5173);
const root = __dirname;
const dataRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || root;
const dataFile = path.join(dataRoot, "kitchen-data.json");

const demoMeals = [
  {
    id: crypto.randomUUID(),
    name: "كبسة دجاج",
    ingredients: "دجاج، أرز بسمتي، طماطم، بصل، بهارات كبسة",
    image: "https://images.unsplash.com/photo-1599043513900-ed6fe01d3833?auto=format&fit=crop&w=700&q=70"
  },
  {
    id: crypto.randomUUID(),
    name: "مشويات مشكلة",
    ingredients: "كباب، شيش طاووق، خضار مشوية، خبز",
    image: "https://images.unsplash.com/photo-1529692236671-f1f6cf9683ba?auto=format&fit=crop&w=700&q=70"
  },
  {
    id: crypto.randomUUID(),
    name: "سلطة فتوش",
    ingredients: "خس، خيار، طماطم، نعناع، خبز محمص، دبس رمان",
    image: "https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=700&q=70"
  }
];

let state = loadState();
const clients = new Set();

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    if (Array.isArray(saved.meals) && Array.isArray(saved.orders)) return saved;
  } catch (error) {}
  return { meals: demoMeals, orders: [] };
}

function saveState() {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(state, null, 2), "utf8");
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function broadcast() {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(payload);
}

function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

async function routeApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, state);
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    clients.add(res);
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/meals") {
    const body = await readJson(req);
    const meal = {
      id: crypto.randomUUID(),
      name: cleanText(body.name, 80),
      ingredients: cleanText(body.ingredients, 800),
      image: cleanText(body.image, 500)
    };
    if (!meal.name || !meal.ingredients) return sendJson(res, 400, { error: "اسم الوجبة والمكونات مطلوبة" });
    state.meals.unshift(meal);
    saveState();
    broadcast();
    return sendJson(res, 201, state);
  }

  if (req.method === "POST" && url.pathname === "/api/reset-meals") {
    state.meals = demoMeals.map((meal) => ({ ...meal, id: crypto.randomUUID() }));
    saveState();
    broadcast();
    return sendJson(res, 200, state);
  }

  const mealDelete = url.pathname.match(/^\/api\/meals\/([^/]+)$/);
  if (req.method === "DELETE" && mealDelete) {
    state.meals = state.meals.filter((meal) => meal.id !== decodeURIComponent(mealDelete[1]));
    saveState();
    broadcast();
    return sendJson(res, 200, state);
  }

  if (req.method === "POST" && url.pathname === "/api/orders") {
    const body = await readJson(req);
    const meal = state.meals.find((item) => item.id === body.mealId);
    if (!meal) return sendJson(res, 404, { error: "الوجبة غير موجودة" });
    const qty = Math.max(1, Math.min(99, Number(body.qty) || 1));
    state.orders.push({
      id: crypto.randomUUID(),
      mealId: meal.id,
      mealName: meal.name,
      ingredients: meal.ingredients,
      qty,
      time: cleanText(body.time, 20),
      note: cleanText(body.note, 300),
      status: "new",
      createdAt: Date.now()
    });
    saveState();
    broadcast();
    return sendJson(res, 201, state);
  }

  const orderStatus = url.pathname.match(/^\/api\/orders\/([^/]+)\/status$/);
  if (req.method === "PATCH" && orderStatus) {
    const body = await readJson(req);
    const allowed = new Set(["new", "cooking", "ready", "done"]);
    if (!allowed.has(body.status)) return sendJson(res, 400, { error: "حالة غير صحيحة" });
    state.orders = state.orders.map((order) => (
      order.id === decodeURIComponent(orderStatus[1]) ? { ...order, status: body.status } : order
    ));
    saveState();
    broadcast();
    return sendJson(res, 200, state);
  }

  return sendJson(res, 404, { error: "Not found" });
}

function serveStatic(req, res, url) {
  const filePath = url.pathname === "/" ? path.join(root, "index.html") : path.join(root, url.pathname);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(root)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(resolved, (error, content) => {
    if (error) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const type = resolved.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/") || url.pathname === "/events") {
      await routeApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (error) {
    sendJson(res, 500, { error: "Server error" });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Kitchen app running at http://localhost:${port}`);
});
