import { computeBuildStats, emptyArr, addArr, negSumArr } from "./compat.js";

const GEAR_SLOTS = ["helmet", "chestplate", "leggings", "boots", "necklace", "bracelet", "ring", "weapon"];

function weaponTypeForClass(cls) {
  const m = { warrior: "spear", mage: "wand", archer: "bow", assassin: "dagger", shaman: "relik" };
  return m[cls] ?? null;
}

function passesBaseFilters(it, ctx) {
  if (it.levelReq > ctx.level) return false;

  if (ctx.class) {
    // class requirement field is inconsistent in practice; we enforce weapon type strictly if requested
    if (it.slot === "weapon" && ctx.strictWeaponClass) {
      const w = weaponTypeForClass(ctx.class);
      if (w && it.weaponType && it.weaponType !== w) return false;
    }
    if (it.classReq && it.classReq !== ctx.class) return false;
  }

  if (ctx.minItemLevel != null && it.levelReq < ctx.minItemLevel) return false;

  if (ctx.noMythic && String(it.rarity).toLowerCase() === "mythic") return false;
  if (ctx.allowedRarities?.length && !ctx.allowedRarities.includes(it.rarity)) return false;

  // best-effort “no crafted/unidentified”: keep only identified items
  if (ctx.noCraftedBestEffort && !it.identifier) return false;

  if (ctx.noNegativeItemSkillBonuses) {
    if (it.bonusArr.some((v) => v < 0)) return false;
  }

  if (ctx.mustGiveStat != null) {
    const idx = ctx.mustGiveStat;
    if ((it.slot === "weapon" ? it.bonusArr[idx] : it.bonusEffArr[idx]) <= 0) return false;
  }

  return true;
}

export function solveBuild(db, ctx) {
  // ctx: { level, class, budget, lockedBySlot, tomes[], constraints..., objective... }
  // lockedBySlot: { helmet: item|null, ..., ring1, ring2 }
  const lockedItems = [];
  const chosenNames = new Set();

  // rings handled separately
  const locked = ctx.lockedBySlot ?? {};
  for (const slot of ["helmet","chestplate","leggings","boots","necklace","bracelet","weapon"]) {
    const it = locked[slot];
    if (it) { lockedItems.push(it); chosenNames.add(it.name); }
  }
  const ring1 = locked.ring1 ?? null;
  const ring2 = locked.ring2 ?? null;
  if (ring1) { lockedItems.push(ring1); chosenNames.add(ring1.name); }
  if (ring2) { lockedItems.push(ring2); chosenNames.add(ring2.name); }

  for (const t of (ctx.tomes ?? [])) {
    if (!chosenNames.has(t.name)) { lockedItems.push(t); chosenNames.add(t.name); }
  }

  // build pools
  const pools = new Map();

  for (const slot of ["helmet","chestplate","leggings","boots","necklace","bracelet","weapon"]) {
    if (locked[slot]) continue;
    const pool = (db.bySlot.get(slot) ?? [])
      .filter((it) => !chosenNames.has(it.name))
      .filter((it) => passesBaseFilters(it, ctx))
      .slice(0, ctx.poolCap ?? 80); // hard cap for performance
    pools.set(slot, pool);
  }

  // rings (two picks) if not locked
  if (!ring1 || !ring2) {
    const pool = (db.bySlot.get("ring") ?? [])
      .filter((it) => !chosenNames.has(it.name))
      .filter((it) => passesBaseFilters(it, ctx))
      .slice(0, ctx.ringPoolCap ?? 120);
    pools.set("ring", pool);
  }

  // slot ordering: smallest pool first
  const slotsToFill = Array.from(pools.keys()).sort((a, b) => (pools.get(a).length - pools.get(b).length));

  let best = null;

  function scoreBuild(items) {
    const st = computeBuildStats(items, ctx.budget, { perSkillCap: 100 });
    // objective: maximize remaining, then minimize negative tradeoffs
    const neg = items.reduce((s, it) => s + negSumArr(it.bonusArr), 0);
    return { remaining: st.remainingSP, neg, finalSpend: st.finalSpend, equipOrderOk: st.equipOrderOk, netBonus: st.netBonus };
  }

  function violatesNetNegative(items) {
    if (!ctx.noNegativeNetSkillBonuses) return false;
    const net = items.reduce((acc, it) => addArr(acc, it.bonusEffArr), emptyArr());
    return net.some((v) => v < 0);
  }

  function rec(i, currentItems, usedNames) {
    // prune: final budget lower bound (minFinalSpend) must be <= budget
    const stNow = computeBuildStats(currentItems, ctx.budget, { perSkillCap: 100 });
    if (stNow.finalSpend > ctx.budget) return;
    if (violatesNetNegative(currentItems)) return;

    if (i === slotsToFill.length) {
      // final validity
      if (stNow.remainingSP < 0) return;
      if (!stNow.equipOrderOk) return;

      const sc = scoreBuild(currentItems);
      if (sc.remaining < 0) return;

      if (!best) best = { items: currentItems.slice(), score: sc };
      else {
        const b = best.score;
        if (sc.remaining > b.remaining ||
            (sc.remaining === b.remaining && sc.neg < b.neg) ||
            (sc.remaining === b.remaining && sc.neg === b.neg && sc.finalSpend < b.finalSpend)) {
          best = { items: currentItems.slice(), score: sc };
        }
      }
      return;
    }

    const slot = slotsToFill[i];
    const pool = pools.get(slot) ?? [];

    if (slot !== "ring") {
      for (const cand of pool) {
        if (usedNames.has(cand.name)) continue;
        usedNames.add(cand.name);
        currentItems.push(cand);
        rec(i + 1, currentItems, usedNames);
        currentItems.pop();
        usedNames.delete(cand.name);
      }
      return;
    }

    // ring slot: need up to 2 rings if not locked
    const needR1 = !ring1;
    const needR2 = !ring2;

    if (!needR1 && !needR2) {
      rec(i + 1, currentItems, usedNames);
      return;
    }

    // pick rings in a nested loop but capped
    const poolLimited = pool.slice(0, 90);
    if (needR1 && needR2) {
      for (let a = 0; a < poolLimited.length; a++) {
        const rA = poolLimited[a];
        if (usedNames.has(rA.name)) continue;
        usedNames.add(rA.name);
        currentItems.push(rA);

        for (let b = a + 1; b < poolLimited.length; b++) {
          const rB = poolLimited[b];
          if (usedNames.has(rB.name)) continue;
          usedNames.add(rB.name);
          currentItems.push(rB);

          rec(i + 1, currentItems, usedNames);

          currentItems.pop();
          usedNames.delete(rB.name);
        }

        currentItems.pop();
        usedNames.delete(rA.name);
      }
      return;
    }

    // only one ring needed
    for (const r of poolLimited) {
      if (usedNames.has(r.name)) continue;
      usedNames.add(r.name);
      currentItems.push(r);
      rec(i + 1, currentItems, usedNames);
      currentItems.pop();
      usedNames.delete(r.name);
    }
  }

  rec(0, lockedItems.slice(), new Set(chosenNames));

  return best;
}