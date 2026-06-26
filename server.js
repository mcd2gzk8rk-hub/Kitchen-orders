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
    category: "breakfast",
    name: "فطور عربي",
    ingredients: "بيض، فول، خبز، جبن، خضار",
    image: "https://images.unsplash.com/photo-1533089860892-a7c6f0a88666?auto=format&fit=crop&w=700&q=70"
  },
  {
    id: crypto.randomUUID(),
    category: "lunch",
    name: "كبسة دجاج",
    ingredients: "دجاج، أرز بسمتي، طماطم، بصل، بهارات كبسة",
    image: "https://images.unsplash.com/photo-1599043513900-ed6fe01d3833?auto=format&fit=crop&w=700&q=70"
  },
  {
    id: crypto.randomUUID(),
    category: "dinner",
    name: "مشويات مشكلة",
    ingredients: "كباب، شيش طاووق، خضار مشوية، خبز",
    image: "https://images.unsplash.com/photo-1529692236671-f1f6cf9683ba?auto=format&fit=crop&w=700&q=70"
  },
  {
    id: crypto.randomUUID(),
    category: "snack",
    name: "سلطة فتوش",
    ingredients: "خس، خيار، طماطم، نعناع، خبز محمص، دبس رمان",
    image: "https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=700&q=70"
  }
];

const demoPlaces = [
  { id: "place-majlis", name: "المجلس" },
  { id: "place-office", name: "المكتب" },
  { id: "place-room", name: "غرفة 2" }
];

let state = loadState();
const clients = new Set();

function normalizeState(nextState) {
  return {
    meals: (nextState.meals || []).map((meal) => ({ category: "lunch", ...meal })),
    orders: nextState.orders || [],
    places: nextState.places && nextState.places.length ? nextState.places : demoPlaces
  };
}

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    if (Array.isArray(saved.meals) && Array.isArray(saved.orders)) return normalizeState(saved);
  } catch (error) {}
  return normalizeState({ meals: demoMeals, orders: [], places: demoPlaces });
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

function cleanCategory(value) {
  return ["breakfast", "lunch", "dinner", "snack"].includes(value) ? value : "lunch";
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
      category: cleanCategory(body.category),
      name: cleanText(body.name, 80),
      ingredients: cleanText(body.ingredients, 800),
      image: cleanText(body.image, 500)
    };
    if (!meal.name || !meal.ingredients) return sendJson(res, 400, { error: "Meal name and ingredients are required" });
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

  if (req.method === "POST" && url.pathname === "/api/places") {
    const body = await readJson(req);
    const place = {
      id: crypto.randomUUID(),
      name: cleanText(body.name, 80)
    };
    if (!place.name) return sendJson(res, 400, { error: "Place name is required" });
    state.places.push(place);
    saveState();
    broadcast();
    return sendJson(res, 201, state);
  }

  const placeDelete = url.pathname.match(/^\/api\/places\/([^/]+)$/);
  if (req.method === "DELETE" && placeDelete) {
    state.places = state.places.filter((place) => place.id !== decodeURIComponent(placeDelete[1]));
    saveState();
    broadcast();
    return sendJson(res, 200, state);
  }

  if (req.method === "POST" && url.pathname === "/api/orders") {
    const body = await readJson(req);
    const meal = state.meals.find((item) => item.id === body.mealId);
    if (!meal) return sendJson(res, 404, { error: "Meal not found" });
    const place = state.places.find((item) => item.id === body.placeId) || { id: "", name: cleanText(body.placeName, 80) };
    if (!place.name) return sendJson(res, 400, { error: "Place is required" });
    const qty = Math.max(1, Math.min(99, Number(body.qty) || 1));
    state.orders.push({
      id: crypto.randomUUID(),
      mealId: meal.id,
      mealName: meal.name,
      ingredients: meal.ingredients,
      category: meal.category || "lunch",
      qty,
      time: cleanText(body.time, 20),
      note: cleanText(body.note, 300),
      placeId: place.id,
      placeName: place.name,
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
    const allowed = new Set(["ready", "done"]);
    if (!allowed.has(body.status)) return sendJson(res, 400, { error: "Invalid status" });
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
