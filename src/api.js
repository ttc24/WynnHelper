import express from "express";
import { WynnDb } from "./wynnDb.js";
import { LRUCache } from "./lru.js";
import { SKILLS, SKI, skillBudgetFromLevel, computeBuildStats, minFinalSpend, negSumArr, toObj } from "./compat.js";
import { solveBuild } from "./solver.js";

const GEAR_SLOT_KEYS = [
  { key: "helmet", slot: "helmet" },
  { key: "chestplate", slot: "chestplate" },
  { key: "leggings", slot: "leggings" },
  { key: "boots", slot: "boots" },
  { key: "necklace", slot: "necklace" },
  { key: "bracelet", slot: "bracelet" },
  { key: "ring1", slot: "ring" },
  { key: "ring2", slot: "ring" },
  { key: "weapon", slot: "weapon" },
];

const DEFAULT_POOL_CAP = 80;
const DEFAULT_RING_POOL_CAP = 140;
const MAX_POOL_CAP = 250;
const MAX_RING_POOL_CAP = 320;
const DEFAULT_SOLVE_MAX_NODES = 200000;
const MAX_SOLVE_MAX_NODES = 2000000;

function stableKey(obj) {
  // stable stringify (enough for caching our request bodies)
  const seen = new Set();
  return JSON.stringify(obj, (k, v) => {
    if (v && typeof v === "object") {
      if (seen.has(v)) return undefined;
      seen.add(v);
      if (Array.isArray(v)) return v;
      return Object.keys(v).sort().reduce((acc, kk) => (acc[kk] = v[kk], acc), {});
    }
    return v;
  });
}

function fuzzyScore(query, text) {
  // simple subsequence score
  let qi = 0;
  let score = 0;
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) { score += 2; qi++; }
    else score -= 0.2;
  }
  return (qi === query.length) ? score : -Infinity;
}

function weaponTypeForClass(cls) {
  const m = { warrior: "spear", mage: "wand", archer: "bow", assassin: "dagger", shaman: "relik" };
  return m[cls] ?? null;
}

function parseBool(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return fallback;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
    return fallback;
  }
  return fallback;
}

function parseSafeNumber(value, { fallback, min = -Infinity, max = Infinity, floor = true } = {}) {
  const parsed = Number(value);
  const safeDefault = Number.isFinite(Number(fallback)) ? Number(fallback) : 0;
  const finite = Number.isFinite(parsed) ? parsed : safeDefault;
  const normalized = floor ? Math.floor(finite) : finite;
  return Math.min(max, Math.max(min, normalized));
}

function parseOptionalSafeNumber(value, { min = -Infinity, max = Infinity, floor = false } = {}) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parseSafeNumber(parsed, { fallback: parsed, min, max, floor });
}

function targetSlotKey(targetSlot, requestedKey, selectedItemsByKey, locks) {
  if (!targetSlot) return null;

  if (requestedKey) {
    const requested = GEAR_SLOT_KEYS.find((s) => s.key === requestedKey);
    if (requested && requested.slot === targetSlot) return requestedKey;
  }

  if (targetSlot !== "ring") return targetSlot;

  const ringKeys = ["ring1", "ring2"];

  for (const key of ringKeys) {
    if (selectedItemsByKey[key] && !Boolean(locks[key])) return key;
  }

  for (const key of ringKeys) {
    if (!Boolean(locks[key])) return key;
  }

  return "ring1";
}

function areBothRingsLocked(locks) {
  return Boolean(locks.ring1) && Boolean(locks.ring2);
}

function isActiveSlotTargetLocked(slot, slotTargetKey, locks) {
  if (slot === "ring" && areBothRingsLocked(locks)) return true;
  if (!slotTargetKey) return false;
  return Boolean(locks[slotTargetKey]);
}

function isTargetEntry(slotEntry, targetSlot, targetKey) {
  if (!targetSlot) return false;
  if (targetKey) return slotEntry.key === targetKey;
  if (slotEntry.slot !== targetSlot) return false;
  return true;
}

function passesFilters(it, ctx) {
  if (it.levelReq > ctx.level) return false;

  if (ctx.class) {
    if (it.classReq && it.classReq !== ctx.class) return false;

    if (it.slot === "weapon" && ctx.strictWeaponClass) {
      const w = weaponTypeForClass(ctx.class);
      if (w && it.weaponType && it.weaponType !== w) return false;
    }
  }

  if (ctx.minItemLevel != null && it.levelReq < ctx.minItemLevel) return false;

  if (ctx.allowedRarities?.length && !ctx.allowedRarities.includes(it.rarity)) return false;
  if (ctx.noMythic && String(it.rarity).toLowerCase() === "mythic") return false;

  // Best-effort "no crafted": only include identified items.
  // Crafted items are often absent from the fixed DB, but this filter is still useful.
  if (ctx.noCraftedBestEffort && !it.identifier) return false;

  if (ctx.noNegativeItemSkillBonuses) {
    if (it.bonusArr.some((v) => v < 0)) return false;
  }

  if (ctx.mustGiveStat != null) {
    const idx = ctx.mustGiveStat;
    const bonus = it.slot === "weapon" ? it.bonusArr[idx] : it.bonusEffArr[idx];
    if (bonus <= 0) return false;
  }

  return true;
}

function reasonFails(it, ctx, baseItems, candidateItems, baselineSpend = null) {
  // ordered reasons
  if (it.levelReq > ctx.level) return "fails level";
  if (ctx.minItemLevel != null && it.levelReq < ctx.minItemLevel) return "fails min level";
  if (ctx.class) {
    if (it.classReq && it.classReq !== ctx.class) return "fails class";
    if (it.slot === "weapon" && ctx.strictWeaponClass) {
      const w = weaponTypeForClass(ctx.class);
      if (w && it.weaponType && it.weaponType !== w) return "fails weapon class";
    }
  }
  if (ctx.allowedRarities?.length && !ctx.allowedRarities.includes(it.rarity)) return "fails rarity";
  if (ctx.noMythic && String(it.rarity).toLowerCase() === "mythic") return "excluded mythic";
  if (ctx.noCraftedBestEffort && !it.identifier) return "excluded crafted/unidentified";
  if (ctx.noNegativeItemSkillBonuses && it.bonusArr.some((v) => v < 0)) return "excluded negative skill bonus";

  // final budget + equip order checks
  const test = baseItems.concat(candidateItems);
  const st = computeBuildStats(test, ctx.budget, { perSkillCap: 100 });

  if (ctx.noNegativeNetSkillBonuses && st.netBonus.some((v) => v < 0)) return "excluded negative net bonuses";
  if (st.finalSpend > ctx.budget) return "fails final budget";
  if (!st.equipOrderOk) return "fails equip order";

  // improvement requirement
  if (ctx.minImprove != null) {
    const baseSpend = baselineSpend ?? minFinalSpend(baseItems);
    const testSpend = st.finalSpend;
    const improve = (ctx.budget - testSpend) - (ctx.budget - baseSpend); // delta remaining
    if (improve < ctx.minImprove) return "fails improvement threshold";
  }

  return null;
}

export async function buildApiRouter({ cacheDir }) {
  const router = express.Router();

  const db = new WynnDb({ cacheDir });
  const cache = new LRUCache(250);

  function dataUnavailableJson(error) {
    return {
      ok: false,
      code: "DATA_UNAVAILABLE",
      error: "Item data unavailable",
      details: String(error?.message ?? error),
      retry: "Use Force DB reload and retry.",
    };
  }

  async function ensureDbData(res) {
    try {
      return await db.load();
    } catch (e) {
      if (res) res.status(503).json(dataUnavailableJson(e));
      return null;
    }
  }

  router.get("/health", async (_req, res) => {
    const d = await ensureDbData(res);
    if (!d) return;

    res.json({
      ok: true,
      itemCount: d.items.length,
      rarities: d.rarities,
      dataState: d.dataState,
    });
  });

  router.post("/reload", async (_req, res) => {
    try {
      await db.load({ force: true });
      cache.clear();
      res.json({ ok: true });
    } catch (e) {
      res.status(503).json(dataUnavailableJson(e));
    }
  });

  router.get("/search", async (req, res) => {
    const q = String(req.query.q ?? "").toLowerCase().trim();
    const slot = String(req.query.slot ?? "").trim();
    const mode = String(req.query.mode ?? "contains"); // contains | starts | fuzzy
    const level = parseSafeNumber(req.query.level, { fallback: 106, min: 1 });
    const cls = String(req.query.class ?? "").toLowerCase().trim();

    const strictWeaponClass = String(req.query.strictWeaponClass ?? "0") === "1";

    const d = await ensureDbData(res);
    if (!d) return;
    let pool = d.items;

    if (slot) pool = pool.filter((x) => x.slot === slot);

    const ctx = { level, class: cls || null, strictWeaponClass };
    pool = pool.filter((it) => passesFilters(it, { ...ctx, minItemLevel: null }));

    let results = [];
    if (!q) {
      results = pool.slice(0, 30).map((it) => ({ name: it.name, slot: it.slot, rarity: it.rarity, levelReq: it.levelReq }));
      return res.json({ ok: true, results });
    }

    if (mode === "starts") {
      results = pool.filter((it) => it.lowerName.startsWith(q));
    } else if (mode === "fuzzy") {
      results = pool
        .map((it) => ({ it, s: fuzzyScore(q, it.lowerName) }))
        .filter((x) => Number.isFinite(x.s))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.it);
    } else {
      results = pool.filter((it) => it.lowerName.includes(q));
    }

    res.json({
      ok: true,
      results: results.slice(0, 40).map((it) => ({ name: it.name, slot: it.slot, rarity: it.rarity, levelReq: it.levelReq })),
    });
  });

  router.post("/compatible", async (req, res) => {
    const body = req.body ?? {};

    const level = parseSafeNumber(body.level, { fallback: 106, min: 1 });
    const extraPoints = parseSafeNumber(body.extraPoints, { fallback: 0, min: 0 });
    const cls = String(body.class ?? "").toLowerCase().trim() || null;

    const strictWeaponClass = parseBool(body.strictWeaponClass, true);

    const allowedRarities = Array.isArray(body.rarities) ? body.rarities.map(String) : null;

    const minItemLevel = body.minItemLevel != null
      ? parseSafeNumber(body.minItemLevel, { fallback: 0, min: 0 })
      : null;

    const noMythic = parseBool(body.noMythic, false);
    const noCraftedBestEffort = parseBool(body.noCraftedBestEffort, false);

    const noNegativeItemSkillBonuses = parseBool(body.noNegativeItemSkillBonuses, false);
    const noNegativeNetSkillBonuses = parseBool(body.noNegativeNetSkillBonuses, false);

    const mustGiveStatName = String(body.mustGiveStat ?? "");
    const mustGiveStat = mustGiveStatName ? SKI[mustGiveStatName] : null;
    const poolCap = parseSafeNumber(body.poolCap, {
      fallback: DEFAULT_POOL_CAP,
      min: 10,
      max: MAX_POOL_CAP,
    });
    const ringPoolCap = parseSafeNumber(body.ringPoolCap, {
      fallback: DEFAULT_RING_POOL_CAP,
      min: 10,
      max: MAX_RING_POOL_CAP,
    });
    const minImprove = parseOptionalSafeNumber(body.minImprove);

    const sortBy = String(body.sortBy ?? "bestRemaining"); // bestRemaining | lowestFinalSpend | lowestLevel | highestSTR... | leastNegative

    const debug = parseBool(body.debug, false);
    const debugLimit = parseSafeNumber(body.debugLimit, { fallback: 80, min: 0, max: 200 });

    const limit = parseSafeNumber(body.limit, { fallback: 150, min: 10, max: 500 });

    const targetSlot = String(body.targetSlot ?? ""); // single slot to search (recommended)
    const requestedTargetSlotKey = String(body.targetSlotKey ?? "").trim();
    const selected = body.selected ?? {};
    const locks = body.locks ?? {}; // per slotKey boolean
    const tomesSelected = Array.isArray(body.tomes) ? body.tomes.map(String) : [];

    const budgetBase = skillBudgetFromLevel(level);
    const budget = budgetBase + extraPoints;

    const d = await ensureDbData(res);
    if (!d) return;

    const ctx = {
      level, class: cls, strictWeaponClass,
      budget, allowedRarities, minItemLevel,
      noMythic, noCraftedBestEffort,
      noNegativeItemSkillBonuses, noNegativeNetSkillBonuses,
      mustGiveStat, minImprove
    };

    const notes = [];
    notes.push("Weapon skill bonuses are ignored for build validity (weapon requirements still apply).");

    // resolve selected items
    const selectedItemsByKey = {};
    const selectedItems = [];
    const usedNames = new Set();

    for (const s of GEAR_SLOT_KEYS) {
      const name = String(selected[s.key] ?? "").trim();
      if (!name) continue;
      const it = d.byName.get(name);
      if (!it) continue;
      selectedItemsByKey[s.key] = it;
      selectedItems.push(it);
      usedNames.add(it.name);
    }

    const resolvedTargetSlotKey = targetSlotKey(targetSlot, requestedTargetSlotKey, selectedItemsByKey, locks);

    const cacheKey = stableKey({ ctx, selected, locks, tomesSelected, targetSlot, targetSlotKey: resolvedTargetSlotKey, sortBy, limit, debug, debugLimit });
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // tomes
    const tomeItems = [];
    for (const tName of tomesSelected) {
      const it = d.byName.get(tName);
      if (it && it.slot === "tome" && !usedNames.has(it.name)) {
        tomeItems.push(it);
        usedNames.add(it.name);
      }
    }

    // Determine fixed items: locked slots + all non-target slots with a selection
    // Target slot can be a slot name (helmet/..../ring/weapon). For rings, targetSlot="ring" means replace either ring.
    let fixed = [];
    for (const s of GEAR_SLOT_KEYS) {
      const it = selectedItemsByKey[s.key];
      if (!it) continue;

      const isLocked = Boolean(locks[s.key]);
      const isTarget = isTargetEntry(s, targetSlot, resolvedTargetSlotKey);
      if (isLocked || !isTarget) fixed.push(it);
      // else: item in target slot is replaceable, so we drop it from fixed
    }
    fixed = fixed.concat(tomeItems);

    // baseline build stats = fixed + (current target item if exists and not locked?)
    let baseline = fixed.slice();
    let baselineCurrent = null;

    if (targetSlot) {
      // pick current target item (if any) to define baseline remaining for delta compare
      const curTargets = GEAR_SLOT_KEYS
        .filter((s) => isTargetEntry(s, targetSlot, resolvedTargetSlotKey))
        .map((s) => selectedItemsByKey[s.key])
        .filter(Boolean);

      if (curTargets.length) {
        const addable = [];
        for (const s of GEAR_SLOT_KEYS.filter((x) => isTargetEntry(x, targetSlot, resolvedTargetSlotKey))) {
          const it = selectedItemsByKey[s.key];
          if (!it) continue;
          if (Boolean(locks[s.key])) continue;
          addable.push(it);
        }
        // baseline includes them (current setup)
        baseline = baseline.concat(addable);
        baselineCurrent = addable[0] ?? null;
      }
    }

    const baseStats = computeBuildStats(baseline, budget, { perSkillCap: 100 });

    // set synergy (best effort)
    const setItems = baseline.filter((it) => String(it.rarity).toLowerCase() === "set");
    const setGroups = {};
    for (const it of setItems) {
      const key = it.setName || "(unknown set name)";
      setGroups[key] ??= [];
      setGroups[key].push(it.name);
    }

    // If target slot is not specified, we intentionally show all slots (including filled ones);
    // per-slot evaluation below is replacement-aware and swaps against that slot's current item.
    const outputSlots = targetSlot ? [targetSlot] : ["helmet","chestplate","leggings","boots","necklace","bracelet","ring","weapon"];

    const results = {};
    const debugExcluded = debug ? { counts: {}, samples: [] } : null;
    const allReasonCounts = debug ? {} : null;

    for (const slot of outputSlots) {
      const slotTargetKey = slot === "ring"
        ? (targetSlot === "ring"
            ? resolvedTargetSlotKey
            : targetSlotKey("ring", "", selectedItemsByKey, locks))
        : slot;

      const slotLocked = isActiveSlotTargetLocked(slot, slotTargetKey, locks);
      if (slotLocked) {
        results[slot] = [];
        notes.push(`Skipped ${slot} candidates: slot locked.`);

        if (debug && allReasonCounts) {
          allReasonCounts["slot locked"] = (allReasonCounts["slot locked"] ?? 0) + 1;
        }

        continue;
      }

      const slotBase = [];
      for (const s of GEAR_SLOT_KEYS) {
        const it = selectedItemsByKey[s.key];
        if (!it) continue;

        const isLocked = Boolean(locks[s.key]);
        const isTarget = isTargetEntry(s, slot, slotTargetKey);
        if (!isLocked && isTarget) continue;
        slotBase.push(it);
      }
      slotBase.push(...tomeItems);

      const currentSlotItem = slotTargetKey ? selectedItemsByKey[slotTargetKey] ?? null : null;
      const slotBaseline = slotBase.slice();
      if (currentSlotItem && !slotBaseline.includes(currentSlotItem)) {
        slotBaseline.push(currentSlotItem);
      }
      const slotBaseStats = computeBuildStats(slotBaseline, budget, { perSkillCap: 100 });

      const pool = (d.bySlot.get(slot) ?? []).filter((it) => {
        if (usedNames.has(it.name)) return false;
        return passesFilters(it, ctx);
      });

      const compatible = [];
      const reasonCounts = {};
      const excludedSamples = [];

      for (const cand of pool) {
        const test = slotBase.concat([cand]);

        // net negative constraint
        const st = computeBuildStats(test, budget, { perSkillCap: 100 });

        let fail = null;
        if (noNegativeNetSkillBonuses && st.netBonus.some((v) => v < 0)) fail = "excluded negative net bonuses";
        else if (st.finalSpend > budget) fail = "fails final budget";
        else if (!st.equipOrderOk) fail = "fails equip order";

        // improvement threshold vs baseline for this slot (same base, current item when present)
        const deltaRemaining = (budget - st.finalSpend) - (budget - slotBaseStats.finalSpend);
        if (!fail && minImprove != null && deltaRemaining < minImprove) fail = "fails improvement threshold";

        if (fail) {
          if (debug) {
            reasonCounts[fail] = (reasonCounts[fail] ?? 0) + 1;
          }
          if (debug && excludedSamples.length < debugLimit) {
            excludedSamples.push({ name: cand.name, reason: fail });
          }
          continue;
        }

        compatible.push({
          name: cand.name,
          rarity: cand.rarity,
          levelReq: cand.levelReq,
          req: cand.reqArr,
          bonus: cand.bonusArr, // display
          finalSpend: st.finalSpend,
          remainingAfter: budget - st.finalSpend,
          deltaRemaining,
          negTradeoff: negSumArr(cand.bonusArr),
        });

      }

      // sorting
      const statSort = (idx) => (a, b) =>
        (b.bonus[idx] - a.bonus[idx]) ||
        (b.remainingAfter - a.remainingAfter) ||
        a.name.localeCompare(b.name);

      compatible.sort((a, b) => {
        if (sortBy === "lowestFinalSpend") return a.finalSpend - b.finalSpend || b.remainingAfter - a.remainingAfter;
        if (sortBy === "lowestLevel") return a.levelReq - b.levelReq || b.remainingAfter - a.remainingAfter;
        if (sortBy === "leastNegative") return a.negTradeoff - b.negTradeoff || b.remainingAfter - a.remainingAfter;
        if (sortBy === "highestSTR") return statSort(0)(a, b);
        if (sortBy === "highestDEX") return statSort(1)(a, b);
        if (sortBy === "highestINT") return statSort(2)(a, b);
        if (sortBy === "highestDEF") return statSort(3)(a, b);
        if (sortBy === "highestAGI") return statSort(4)(a, b);
        // default bestRemaining
        return b.remainingAfter - a.remainingAfter || a.finalSpend - b.finalSpend || a.name.localeCompare(b.name);
      });

      results[slot] = compatible.slice(0, limit);

      if (debug && debugExcluded) {
        for (const [reason, count] of Object.entries(reasonCounts)) {
          allReasonCounts[reason] = (allReasonCounts[reason] ?? 0) + count;
        }
        const roomLeft = Math.max(0, debugLimit - debugExcluded.samples.length);
        if (roomLeft > 0) {
          debugExcluded.samples = debugExcluded.samples.concat(excludedSamples.slice(0, roomLeft));
        }
      }
    }

    if (debug && debugExcluded) {
      debugExcluded.counts = allReasonCounts;
    }

    const response = {
      ok: true,
      level,
      class: cls,
      budgetBase,
      extraPoints,
      budget,
      baseline: {
        finalSpend: baseStats.finalSpend,
        remainingSP: baseStats.remainingSP,
        equipOrderOk: baseStats.equipOrderOk,
      },
      allocationPreview: baseStats.remainingSP >= 0 ? baseStats.allocs.map((a) => ({
        name: a.name,
        used: a.used,
        remaining: budget - a.used,
        alloc: toObj(a.alloc),
      })) : [],
      setSynergy: {
        count: setItems.length,
        groups: setGroups,
      },
      results,
      debugExcluded,
      notes,
      dataState: d.dataState,
    };

    cache.set(cacheKey, response);
    res.json(response);
  });

  router.post("/explain", async (req, res) => {
    const body = req.body ?? {};
    const itemName = String(body.itemName ?? "").trim();
    const targetSlot = String(body.targetSlot ?? "").trim();
    const requestedTargetSlotKey = String(body.targetSlotKey ?? "").trim();
    const selected = body.selected ?? {};
    const locks = body.locks ?? {};
    const tomesSelected = Array.isArray(body.tomes) ? body.tomes.map(String) : [];

    const level = parseSafeNumber(body.level, { fallback: 106, min: 1 });
    const extraPoints = parseSafeNumber(body.extraPoints, { fallback: 0, min: 0 });
    const cls = String(body.class ?? "").toLowerCase().trim() || null;
    const strictWeaponClass = parseBool(body.strictWeaponClass, true);

    const allowedRarities = Array.isArray(body.rarities) ? body.rarities.map(String) : null;
    const minItemLevel = body.minItemLevel != null
      ? parseSafeNumber(body.minItemLevel, { fallback: 0, min: 0 })
      : null;
    const noMythic = parseBool(body.noMythic, false);
    const noCraftedBestEffort = parseBool(body.noCraftedBestEffort, false);
    const noNegativeItemSkillBonuses = parseBool(body.noNegativeItemSkillBonuses, false);
    const noNegativeNetSkillBonuses = parseBool(body.noNegativeNetSkillBonuses, false);

    const mustGiveStatName = String(body.mustGiveStat ?? "");
    const mustGiveStat = mustGiveStatName ? SKI[mustGiveStatName] : null;

    const minImprove = parseOptionalSafeNumber(body.minImprove);

    const budget = skillBudgetFromLevel(level) + extraPoints;

    const d = await ensureDbData(res);
    if (!d) return;
    const cand = d.byName.get(itemName);
    if (!cand) return res.json({ ok: false, error: "Item not found" });

    const ctx = { level, class: cls, strictWeaponClass, budget, allowedRarities, minItemLevel, noMythic, noCraftedBestEffort, noNegativeItemSkillBonuses, noNegativeNetSkillBonuses, mustGiveStat, minImprove };

    // fixed base set (same logic as /compatible)
    const usedNames = new Set();
    const selectedItemsByKey = {};
    for (const s of GEAR_SLOT_KEYS) {
      const name = String(selected[s.key] ?? "").trim();
      if (!name) continue;
      const it = d.byName.get(name);
      if (!it) continue;
      selectedItemsByKey[s.key] = it;
      usedNames.add(it.name);
    }

    const tomeItems = [];
    for (const tName of tomesSelected) {
      const it = d.byName.get(tName);
      if (it && it.slot === "tome" && !usedNames.has(it.name)) {
        tomeItems.push(it);
        usedNames.add(it.name);
      }
    }

    const resolvedTargetSlotKey = targetSlotKey(targetSlot, requestedTargetSlotKey, selectedItemsByKey, locks);

    const resolvedTargetSlotFamily = resolvedTargetSlotKey
      ? (GEAR_SLOT_KEYS.find((s) => s.key === resolvedTargetSlotKey)?.slot ?? null)
      : null;
    const expectedSlotFamily = targetSlot || resolvedTargetSlotFamily;

    if (expectedSlotFamily && isActiveSlotTargetLocked(expectedSlotFamily, resolvedTargetSlotKey, locks)) {
      return res.json({ ok: true, item: cand.name, passes: false, reason: "slot locked" });
    }

    if (expectedSlotFamily && cand.slot !== expectedSlotFamily) {
      return res.json({ ok: true, item: cand.name, passes: false, reason: "fails slot mismatch" });
    }

    let fixed = [];
    for (const s of GEAR_SLOT_KEYS) {
      const it = selectedItemsByKey[s.key];
      if (!it) continue;
      const isLocked = Boolean(locks[s.key]);
      const isTarget = isTargetEntry(s, targetSlot, resolvedTargetSlotKey);
      if (isLocked || !isTarget) fixed.push(it);
    }
    fixed = fixed.concat(tomeItems);

    let baseline = fixed.slice();
    for (const s of GEAR_SLOT_KEYS.filter((x) => isTargetEntry(x, targetSlot, resolvedTargetSlotKey))) {
      const it = selectedItemsByKey[s.key];
      if (!it) continue;
      if (Boolean(locks[s.key])) continue;
      baseline.push(it);
      break;
    }
    const baselineStats = computeBuildStats(baseline, budget, { perSkillCap: 100 });

    const reason = reasonFails(cand, ctx, fixed, [cand], baselineStats.finalSpend);
    res.json({ ok: true, item: cand.name, passes: reason == null, reason, dataState: d.dataState });
  });

  router.post("/solve", async (req, res) => {
    const body = req.body ?? {};
    const level = parseSafeNumber(body.level, { fallback: 106, min: 1 });
    const extraPoints = parseSafeNumber(body.extraPoints, { fallback: 0, min: 0 });
    const cls = String(body.class ?? "").toLowerCase().trim() || null;
    const strictWeaponClass = parseBool(body.strictWeaponClass, true);
    const budget = skillBudgetFromLevel(level) + extraPoints;

    const allowedRarities = Array.isArray(body.rarities) ? body.rarities.map(String) : null;
    const minItemLevel = body.minItemLevel != null
      ? parseSafeNumber(body.minItemLevel, { fallback: 0, min: 0 })
      : null;

    const noMythic = parseBool(body.noMythic, false);
    const noCraftedBestEffort = parseBool(body.noCraftedBestEffort, false);

    const noNegativeItemSkillBonuses = parseBool(body.noNegativeItemSkillBonuses, false);
    const noNegativeNetSkillBonuses = parseBool(body.noNegativeNetSkillBonuses, false);

    const mustGiveStatName = String(body.mustGiveStat ?? "");
    const mustGiveStat = mustGiveStatName ? SKI[mustGiveStatName] : null;
    const poolCap = parseSafeNumber(body.poolCap, {
      fallback: DEFAULT_POOL_CAP,
      min: 10,
      max: MAX_POOL_CAP,
    });
    const ringPoolCap = parseSafeNumber(body.ringPoolCap, {
      fallback: DEFAULT_RING_POOL_CAP,
      min: 10,
      max: MAX_RING_POOL_CAP,
    });
    const maxNodes = parseSafeNumber(body.maxNodes, {
      fallback: DEFAULT_SOLVE_MAX_NODES,
      min: 1000,
      max: MAX_SOLVE_MAX_NODES,
    });

    const d = await ensureDbData(res);
    if (!d) return;

    // lockedBySlot uses actual item objects
    const lockedBySlot = {};
    const selected = body.selected ?? {};
    const locks = body.locks ?? {};
    for (const s of GEAR_SLOT_KEYS) {
      if (!locks[s.key]) continue;
      const name = String(selected[s.key] ?? "").trim();
      if (!name) continue;
      const it = d.byName.get(name);
      if (it) lockedBySlot[s.key] = it;
    }
    // map keys to slot-names solver expects
    const locked = {
      helmet: lockedBySlot.helmet ?? null,
      chestplate: lockedBySlot.chestplate ?? null,
      leggings: lockedBySlot.leggings ?? null,
      boots: lockedBySlot.boots ?? null,
      necklace: lockedBySlot.necklace ?? null,
      bracelet: lockedBySlot.bracelet ?? null,
      ring1: lockedBySlot.ring1 ?? null,
      ring2: lockedBySlot.ring2 ?? null,
      weapon: lockedBySlot.weapon ?? null,
    };

    const tomesSelected = Array.isArray(body.tomes) ? body.tomes.map(String) : [];
    const tomes = [];
    for (const tName of tomesSelected) {
      const it = d.byName.get(tName);
      if (it && it.slot === "tome") tomes.push(it);
    }

    const solveResult = solveBuild(d, {
      level, class: cls, strictWeaponClass,
      budget,
      allowedRarities, minItemLevel,
      noMythic, noCraftedBestEffort,
      noNegativeItemSkillBonuses, noNegativeNetSkillBonuses,
      mustGiveStat,
      lockedBySlot: locked,
      tomes,
      poolCap,
      ringPoolCap,
      maxNodes,
    });

    const { best, truncated, nodesVisited } = solveResult;

    if (!best) {
      return res.json({
        ok: true,
        found: false,
        dataState: d.dataState,
        truncated,
        meta: { nodesVisited, maxNodes },
      });
    }

    res.json({
      ok: true,
      found: true,
      dataState: d.dataState,
      truncated,
      meta: { nodesVisited, maxNodes },
      score: best.score,
      items: best.items.map((it) => ({ name: it.name, slot: it.slot, rarity: it.rarity, levelReq: it.levelReq })),
    });
  });

  return router;
}
