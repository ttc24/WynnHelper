import fs from "node:fs";
import path from "node:path";
import { emptyArr } from "./compat.js";

const DB_URL = "https://api.wynncraft.com/v3/item/database?fullResult=";
const TTL_MS = 55 * 60 * 1000;

function toNumAvg(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object") {
    if (typeof v.min === "number" && typeof v.max === "number") return Math.round((v.min + v.max) / 2);
    if (typeof v.raw === "number") return v.raw;
  }
  return 0;
}

function reqArrFromReq(req = {}) {
  return [
    Number(req.strength ?? 0),
    Number(req.dexterity ?? 0),
    Number(req.intelligence ?? 0),
    Number(req.defence ?? req.defense ?? 0),
    Number(req.agility ?? 0),
  ];
}

function bonusArrFromIds(ids = {}) {
  return [
    toNumAvg(ids.rawStrength),
    toNumAvg(ids.rawDexterity),
    toNumAvg(ids.rawIntelligence),
    toNumAvg(ids.rawDefence ?? ids.rawDefense),
    toNumAvg(ids.rawAgility),
  ];
}

function slotFromItem(it) {
  if (it.type === "armour" && it.armourType) return it.armourType;        // helmet/chestplate/leggings/boots
  if ((it.type === "accessory" || it.type === "accessories") && it.accessoryType) return it.accessoryType; // ring/bracelet/necklace
  if (it.type === "weapon" && it.weaponType) return "weapon";
  // Tomes are handled heuristically because type/subType values vary in practice.
  const t = String(it.type ?? "").toLowerCase();
  const st = String(it.subType ?? "").toLowerCase();
  if (t.includes("tome") || st.includes("tome")) return "tome";
  return null;
}

function classReqFromReq(req = {}) {
  const v = req.class_requirement ?? req.classRequirement ?? null; // class requirement appears under either key
  if (!v) return null;
  return String(v).toLowerCase();
}

function setNameBestEffort(it) {
  // Not in official schema; keep best-effort if present
  return it.set ?? it.setName ?? it.set_name ?? null;
}

export class WynnDb {
  constructor({ cacheDir }) {
    this.cacheFile = path.join(cacheDir, ".wynn_item_cache.json");
    this.norm = null;
    this.lastLoadInfo = null;
  }

  async load({ force = false } = {}) {
    if (!force && this.norm) return this.norm;

    const { raw, loadInfo } = await this.#loadRaw(force);
    const items = [];
    const byName = new Map();
    const bySlot = new Map();
    const byRarity = new Map();
    const rarities = new Set();

    for (const [name, it] of Object.entries(raw)) {
      const slot = slotFromItem(it);
      if (!slot) continue;

      // we only care about gear+tomes in this app
      const type = String(it.type ?? "");
      const rarity = String(it.rarity ?? "unknown");
      rarities.add(rarity);

      const req = it.requirements ?? {};
      const levelReq = Number(req.level ?? 0);
      const reqArr = reqArrFromReq(req);
      const bonusArr = bonusArrFromIds(it.identifications ?? {});

      // ✅ weapon bonus ignored for build validity; still kept for display
      const bonusEffArr = slot === "weapon" ? emptyArr() : bonusArr;

      const identifier = Boolean(it.identifier ?? false);          // optional flag from the API payload
      const allowCraftsman = Boolean(it.allow_craftsman ?? false); // optional craftsman compatibility flag

      const classReq = classReqFromReq(req); // e.g. "warrior" etc.
      const weaponType = it.weaponType ? String(it.weaponType).toLowerCase() : null;

      const lowerName = name.toLowerCase();
      const setName = setNameBestEffort(it);

      const norm = {
        name,
        lowerName,
        internalName: it.internalName ?? null,
        type,
        subType: it.subType ?? null,
        slot,
        rarity,
        levelReq,
        reqArr,
        bonusArr,      // display bonus
        bonusEffArr,   // math bonus
        identifier,
        allowCraftsman,
        classReq,      // best-effort (many armours are null)
        weaponType,
        setName,
      };

      items.push(norm);
      byName.set(name, norm);

      if (!bySlot.has(slot)) bySlot.set(slot, []);
      bySlot.get(slot).push(norm);

      if (!byRarity.has(rarity)) byRarity.set(rarity, []);
      byRarity.get(rarity).push(norm);
    }

    for (const arr of bySlot.values()) arr.sort((a, b) => a.name.localeCompare(b.name));

    this.lastLoadInfo = loadInfo;
    this.norm = {
      items,
      byName,
      bySlot,
      byRarity,
      rarities: Array.from(rarities).sort(),
      dataState: {
        degraded: Boolean(loadInfo?.degraded),
        warning: loadInfo?.warning ?? null,
        source: loadInfo?.source ?? "unknown",
      },
    };
    return this.norm;
  }

  async #loadRaw(force) {
    const readCache = () => {
      try {
        const st = fs.statSync(this.cacheFile);
        const raw = JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
        const ageMs = Date.now() - st.mtimeMs;
        return { raw, ageMs };
      } catch {
        return null;
      }
    };

    if (!force) {
      const cached = readCache();
      if (cached && cached.ageMs < TTL_MS) {
        return {
          raw: cached.raw,
          loadInfo: {
            degraded: false,
            warning: null,
            source: "cache:fresh",
          },
        };
      }
    }

    try {
      const res = await fetch(DB_URL, {
        headers: {
          accept: "application/json",
          "user-agent": "wynnhelperv3 (local)",
        },
      });

      if (!res.ok) throw new Error(`DB fetch failed: HTTP ${res.status}`);

      const json = await res.json();
      try {
        fs.writeFileSync(this.cacheFile, JSON.stringify(json));
      } catch {
        return {
          raw: json,
          loadInfo: {
            degraded: true,
            warning: "Live data loaded but cache write failed.",
            source: "live",
          },
        };
      }
      return {
        raw: json,
        loadInfo: {
          degraded: false,
          warning: null,
          source: "live",
        },
      };
    } catch (err) {
      const cached = readCache();
      if (cached) {
        const ageMins = Math.round(cached.ageMs / 60000);
        return {
          raw: cached.raw,
          loadInfo: {
            degraded: true,
            warning: `Live DB fetch failed; using cached data (${ageMins}m old).`,
            source: "cache:stale-fallback",
          },
        };
      }
      throw err;
    }
  }
}
