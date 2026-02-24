export const SKILLS = ["strength", "dexterity", "intelligence", "defence", "agility"];
export const SKI = { strength: 0, dexterity: 1, intelligence: 2, defence: 3, agility: 4 };

export function emptyArr() { return [0, 0, 0, 0, 0]; }
export function addArr(a, b) { return a.map((v, i) => v + b[i]); }
export function maxArr(a, b) { return a.map((v, i) => Math.max(v, b[i])); }
export function negSumArr(a) { return a.reduce((s, v) => s + Math.max(0, -v), 0); }
export function allNonNeg(a) { return a.every((v) => v >= 0); }

export function skillBudgetFromLevel(level) {
  const L = Math.max(1, Math.floor(level || 1));
  const capped = Math.min(L, 101);
  return 2 * (capped - 1); // capped at 200 at 101
}

export function canEquipItemNow(reqArr, curBonusArr, budget, perSkillCap = 100) {
  let neededTotal = 0;
  for (let i = 0; i < 5; i++) {
    const need = Math.max(0, reqArr[i] - curBonusArr[i]);
    if (need > perSkillCap) return false;
    neededTotal += need;
    if (neededTotal > budget) return false;
  }
  return neededTotal <= budget;
}

/**
 * Exact subset DP (n <= ~11 is still fine). Uses "effective bonuses":
 * weapon skill bonuses should be zeroed in db normalization.
 */
export function canEquipAllInSomeOrder(items, budget, perSkillCap = 100) {
  const n = items.length;
  if (n === 0) return true;

  const reqs = items.map((it) => it.reqArr);
  const bonuses = items.map((it) => it.bonusEffArr);

  const size = 1 << n;
  const feasible = new Uint8Array(size);
  feasible[0] = 1;

  // precompute bonus sum for each mask
  const bonusSum = new Array(size);
  bonusSum[0] = emptyArr();
  for (let mask = 1; mask < size; mask++) {
    const lsb = mask & -mask;
    const i = Math.log2(lsb) | 0;
    const prev = mask ^ lsb;
    bonusSum[mask] = addArr(bonusSum[prev], bonuses[i]);
  }

  for (let mask = 0; mask < size; mask++) {
    if (!feasible[mask]) continue;
    const curBonus = bonusSum[mask];

    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) continue;
      if (canEquipItemNow(reqs[i], curBonus, budget, perSkillCap)) {
        feasible[mask | (1 << i)] = 1;
      }
    }
  }

  return feasible[size - 1] === 1;
}

/**
 * Minimum final SP spend:
 * used = Σ max(0, maxReq(skill) - totalBonusEff(skill))
 */
export function minFinalSpend(items) {
  let totalBonus = emptyArr();
  let maxReq = emptyArr();
  for (const it of items) {
    totalBonus = addArr(totalBonus, it.bonusEffArr);
    maxReq = maxArr(maxReq, it.reqArr);
  }
  let sum = 0;
  for (let i = 0; i < 5; i++) sum += Math.max(0, maxReq[i] - totalBonus[i]);
  return sum;
}

/**
 * Allocation vector that *achieves* minFinalSpend:
 * alloc = max(0, maxReq - totalBonusEff)
 */
export function minAllocation(items, perSkillCap = 100) {
  let totalBonus = emptyArr();
  let maxReq = emptyArr();
  for (const it of items) {
    totalBonus = addArr(totalBonus, it.bonusEffArr);
    maxReq = maxArr(maxReq, it.reqArr);
  }
  const alloc = maxReq.map((r, i) => Math.max(0, r - totalBonus[i]));
  // enforce manual cap for allocations
  for (let i = 0; i < 5; i++) alloc[i] = Math.min(perSkillCap, alloc[i]);
  return alloc;
}

export function allocPresets(items, budget, perSkillCap = 100) {
  const base = minAllocation(items, perSkillCap);
  const used = base.reduce((s, v) => s + v, 0);
  const remaining = Math.max(0, budget - used);

  const mk = (name, alloc) => ({
    name,
    alloc,
    used: alloc.reduce((s, v) => s + v, 0),
  });

  // Balanced: distribute remaining evenly over all skills up to cap
  const balanced = base.slice();
  let rem = remaining;
  while (rem > 0) {
    let progressed = false;
    for (let i = 0; i < 5 && rem > 0; i++) {
      if (balanced[i] < perSkillCap) {
        balanced[i] += 1;
        rem -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  // Prioritize each stat: fill that stat then distribute round-robin
  const prioritize = (idx) => {
    const a = base.slice();
    let r = remaining;

    while (r > 0 && a[idx] < perSkillCap) {
      a[idx] += 1;
      r -= 1;
    }
    // then balanced fill
    while (r > 0) {
      let progressed = false;
      for (let i = 0; i < 5 && r > 0; i++) {
        if (a[i] < perSkillCap) { a[i] += 1; r -= 1; progressed = true; }
      }
      if (!progressed) break;
    }
    return a;
  };

  return [
    mk("Min spend", base),
    mk("Balanced", balanced),
    mk("Prioritize STR", prioritize(0)),
    mk("Prioritize DEX", prioritize(1)),
    mk("Prioritize INT", prioritize(2)),
    mk("Prioritize DEF", prioritize(3)),
    mk("Prioritize AGI", prioritize(4)),
  ];
}

export function toObj(arr) {
  return {
    strength: arr[0],
    dexterity: arr[1],
    intelligence: arr[2],
    defence: arr[3],
    agility: arr[4],
  };
}

export function computeBuildStats(items, budget, opts) {
  const perSkillCap = opts?.perSkillCap ?? 100;

  const finalSpend = minFinalSpend(items);
  const remainingSP = budget - finalSpend;

  const allocs = remainingSP >= 0 ? allocPresets(items, budget, perSkillCap) : [];

  const equipOrderOk = remainingSP >= 0
    ? canEquipAllInSomeOrder(items, budget, perSkillCap)
    : false;

  // net effective bonuses (for “no negative net” option)
  const netBonus = items.reduce((acc, it) => addArr(acc, it.bonusEffArr), emptyArr());

  return {
    finalSpend,
    remainingSP,
    equipOrderOk,
    allocs,
    netBonus,
  };
}