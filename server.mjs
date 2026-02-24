import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApiRouter } from "./src/api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));

app.use(express.static(path.join(__dirname, "public")));

app.use("/api", await buildApiRouter({
  cacheDir: __dirname,
}));

// friendly error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: String(err?.message ?? err) });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 5173;
app.listen(PORT, () => {
  console.log(`WynnHelperV3: http://localhost:${PORT}`);
});