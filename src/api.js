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

  // best-effort “no crafted”: only include items that are identified (crafted items often aren’t in the fixed DB; still useful) :contentReference[oaicite:5]{index=5}
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

function reasonFails(it, ctx, baseItems, candidateItems) {
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
    const baseSpend = minFinalSpend(baseItems);
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

  await db.load();

  router.get("/health", async (_req, res) => {
    try {
      const d = await db.load();
      res.json({ ok: true, itemCount: d.items.length, rarities: d.rarities });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message ?? e) });
    }
  });

  router.post("/reload", async (_req, res) => {
    cache.clear();
    await db.load({ force: true });
    res.json({ ok: true });
  });

  router.get("/search", async (req, res) => {
    const q = String(req.query.q ?? "").toLowerCase().trim();
    const slot = String(req.query.slot ?? "").trim();
    const mode = String(req.query.mode ?? "contains"); // contains | starts | fuzzy
    const level = Math.max(1, Math.floor(Number(req.query.level ?? 106)));
    const cls = String(req.query.class ?? "").toLowerCase().trim();

    const strictWeaponClass = String(req.query.strictWeaponClass ?? "0") === "1";

    const d = await db.load();
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

    const level = Math.max(1, Math.floor(Number(body.level ?? 106)));
    const extraPoints = Math.max(0, Math.floor(Number(body.extraPoints ?? 0)));
    const cls = String(body.class ?? "").toLowerCase().trim() || null;

    const strictWeaponClass = Boolean(body.strictWeaponClass ?? true);

    const allowedRarities = Array.isArray(body.rarities) ? body.rarities.map(String) : null;

    const minItemLevel = body.minItemLevel != null ? Math.max(0, Math.floor(Number(body.minItemLevel))) : null;

    const noMythic = Boolean(body.noMythic ?? false);
    const noCraftedBestEffort = Boolean(body.noCraftedBestEffort ?? false);

    const noNegativeItemSkillBonuses = Boolean(body.noNegativeItemSkillBonuses ?? false);
    const noNegativeNetSkillBonuses = Boolean(body.noNegativeNetSkillBonuses ?? false);

    const mustGiveStatName = String(body.mustGiveStat ?? "");
    const mustGiveStat = mustGiveStatName ? SKI[mustGiveStatName] : null;

    const minImprove = body.minImprove != null ? Number(body.minImprove) : null;

    const sortBy = String(body.sortBy ?? "bestRemaining"); // bestRemaining | lowestFinalSpend | lowestLevel | highestSTR... | leastNegative

    const debug = Boolean(body.debug ?? false);
    const debugLimit = Math.max(0, Math.min(200, Math.floor(Number(body.debugLimit ?? 80))));

    const limit = Math.max(10, Math.min(500, Math.floor(Number(body.limit ?? 150))));

    const targetSlot = String(body.targetSlot ?? ""); // single slot to search (recommended)
    const selected = body.selected ?? {};
    const locks = body.locks ?? {}; // per slotKey boolean
    const tomesSelected = Array.isArray(body.tomes) ? body.tomes.map(String) : [];

    const budgetBase = skillBudgetFromLevel(level);
    const budget = budgetBase + extraPoints;

    const d = await db.load();

    const ctx = {
      level, class: cls, strictWeaponClass,
      budget, allowedRarities, minItemLevel,
      noMythic, noCraftedBestEffort,
      noNegativeItemSkillBonuses, noNegativeNetSkillBonuses,
      mustGiveStat, minImprove
    };

    const cacheKey = stableKey({ ctx, selected, locks, tomesSelected, targetSlot, sortBy, limit, debug, debugLimit });
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

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
      const isTarget = targetSlot && (s.slot === targetSlot);
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
        .filter((s) => s.slot === targetSlot)
        .map((s) => selectedItemsByKey[s.key])
        .filter(Boolean);

      if (curTargets.length) {
        // For ring target: baseline uses both rings that were selected but not locked? Here target slot replaces “one slot”
        // We define baseline as fixed + all currently selected in target slot that are NOT locked.
        const addable = [];
        for (const s of GEAR_SLOT_KEYS.filter((x) => x.slot === targetSlot)) {
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

    // if target slot not selected: default “show missing slots” behavior
    const outputSlots = targetSlot ? [targetSlot] : ["helmet","chestplate","leggings","boots","necklace","bracelet","ring","weapon"];

    const results = {};
    const debugExcluded = debug ? { counts: {}, samples: [] } : null;

    for (const slot of outputSlots) {
      const pool = (d.bySlot.get(slot) ?? []).filter((it) => {
        if (usedNames.has(it.name)) return false;
        return passesFilters(it, ctx);
      });

      const compatible = [];
      const excludedSamples = [];

      for (const cand of pool) {
        // ring limits: if target slot is ring, we only replace ONE ring at a time;
        // candidates are tested as fixed + candidate + other fixed rings already in fixed.
        const test = fixed.concat([cand]);

        // net negative constraint
        const st = computeBuildStats(test, budget, { perSkillCap: 100 });

        let fail = null;
        if (noNegativeNetSkillBonuses && st.netBonus.some((v) => v < 0)) fail = "excluded negative net bonuses";
        else if (st.finalSpend > budget) fail = "fails final budget";
        else if (!st.equipOrderOk) fail = "fails equip order";

        // improvement threshold vs baseline fixed build
        const deltaRemaining = (budget - st.finalSpend) - (budget - baseStats.finalSpend);
        if (!fail && minImprove != null && deltaRemaining < minImprove) fail = "fails improvement threshold";

        if (fail) {
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

        if (compatible.length >= limit) break;
      }

      // sorting
      const statSort = (idx) => (b, a) => (a.bonus[idx] - b.bonus[idx]) || (a.remainingAfter - b.remainingAfter) || a.name.localeCompare(b.name);

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

      results[slot] = compatible;

      if (debug && debugExcluded) {
        for (const ex of excludedSamples) {
          debugExcluded.counts[ex.reason] = (debugExcluded.counts[ex.reason] ?? 0) + 1;
        }
        debugExcluded.samples = debugExcluded.samples.concat(excludedSamples.slice(0, 40));
      }
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
    };

    cache.set(cacheKey, response);
    res.json(response);
  });

  router.post("/explain", async (req, res) => {
    const body = req.body ?? {};
    const itemName = String(body.itemName ?? "").trim();
    const targetSlot = String(body.targetSlot ?? "").trim();
    const selected = body.selected ?? {};
    const locks = body.locks ?? {};
    const tomesSelected = Array.isArray(body.tomes) ? body.tomes.map(String) : [];

    const level = Math.max(1, Math.floor(Number(body.level ?? 106)));
    const extraPoints = Math.max(0, Math.floor(Number(body.extraPoints ?? 0)));
    const cls = String(body.class ?? "").toLowerCase().trim() || null;
    const strictWeaponClass = Boolean(body.strictWeaponClass ?? true);

    const allowedRarities = Array.isArray(body.rarities) ? body.rarities.map(String) : null;
    const minItemLevel = body.minItemLevel != null ? Math.max(0, Math.floor(Number(body.minItemLevel))) : null;
    const noMythic = Boolean(body.noMythic ?? false);
    const noCraftedBestEffort = Boolean(body.noCraftedBestEffort ?? false);
    const noNegativeItemSkillBonuses = Boolean(body.noNegativeItemSkillBonuses ?? false);
    const noNegativeNetSkillBonuses = Boolean(body.noNegativeNetSkillBonuses ?? false);

    const mustGiveStatName = String(body.mustGiveStat ?? "");
    const mustGiveStat = mustGiveStatName ? SKI[mustGiveStatName] : null;

    const minImprove = body.minImprove != null ? Number(body.minImprove) : null;

    const budget = skillBudgetFromLevel(level) + extraPoints;

    const d = await db.load();
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

    let fixed = [];
    for (const s of GEAR_SLOT_KEYS) {
      const it = selectedItemsByKey[s.key];
      if (!it) continue;
      const isLocked = Boolean(locks[s.key]);
      const isTarget = targetSlot && (s.slot === targetSlot);
      if (isLocked || !isTarget) fixed.push(it);
    }
    fixed = fixed.concat(tomeItems);

    const reason = reasonFails(cand, ctx, fixed, [cand]);
    res.json({ ok: true, item: cand.name, passes: reason == null, reason });
  });

  router.post("/solve", async (req, res) => {
    const body = req.body ?? {};
    const level = Math.max(1, Math.floor(Number(body.level ?? 106)));
    const extraPoints = Math.max(0, Math.floor(Number(body.extraPoints ?? 0)));
    const cls = String(body.class ?? "").toLowerCase().trim() || null;
    const strictWeaponClass = Boolean(body.strictWeaponClass ?? true);
    const budget = skillBudgetFromLevel(level) + extraPoints;

    const allowedRarities = Array.isArray(body.rarities) ? body.rarities.map(String) : null;
    const minItemLevel = body.minItemLevel != null ? Math.max(0, Math.floor(Number(body.minItemLevel))) : null;

    const noMythic = Boolean(body.noMythic ?? false);
    const noCraftedBestEffort = Boolean(body.noCraftedBestEffort ?? false);

    const noNegativeItemSkillBonuses = Boolean(body.noNegativeItemSkillBonuses ?? false);
    const noNegativeNetSkillBonuses = Boolean(body.noNegativeNetSkillBonuses ?? false);

    const mustGiveStatName = String(body.mustGiveStat ?? "");
    const mustGiveStat = mustGiveStatName ? SKI[mustGiveStatName] : null;

    const d = await db.load();

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

    const best = solveBuild(d, {
      level, class: cls, strictWeaponClass,
      budget,
      allowedRarities, minItemLevel,
      noMythic, noCraftedBestEffort,
      noNegativeItemSkillBonuses, noNegativeNetSkillBonuses,
      mustGiveStat,
      lockedBySlot: locked,
      tomes,
      poolCap: 80,
      ringPoolCap: 140,
    });

    if (!best) return res.json({ ok: true, found: false });

    res.json({
      ok: true,
      found: true,
      score: best.score,
      items: best.items.map((it) => ({ name: it.name, slot: it.slot, rarity: it.rarity, levelReq: it.levelReq })),
    });
  });

  return router;
}