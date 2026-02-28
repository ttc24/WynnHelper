import test from "node:test";
import assert from "node:assert/strict";

import { solveBuild } from "../src/solver.js";

function mkItem(name, slot, {
  levelReq = 1,
  reqArr = [0, 0, 0, 0, 0],
  bonusArr = [0, 0, 0, 0, 0],
  bonusEffArr = bonusArr,
  rarity = "Rare",
  identifier = true,
  classReq = null,
  weaponType = null,
} = {}) {
  return { name, slot, levelReq, reqArr, bonusArr, bonusEffArr, rarity, identifier, classReq, weaponType };
}

test("solveBuild keeps high-value item beyond index 80 when shortlist is scored", () => {
  const helmets = [];
  for (let i = 0; i < 100; i++) {
    helmets.push(mkItem(`aa-decoy-${String(i).padStart(3, "0")}`, "helmet", {
      levelReq: 100,
      bonusArr: [1, -2, 0, 0, 0],
      bonusEffArr: [1, -2, 0, 0, 0],
    }));
  }

  const neededHelmet = mkItem("zz-needed-helmet", "helmet", {
    levelReq: 1,
    bonusArr: [40, 0, 0, 0, 0],
    bonusEffArr: [40, 0, 0, 0, 0],
  });
  helmets.push(neededHelmet);

  const lockedBySlot = {
    weapon: mkItem("locked-weapon", "weapon"),
    chestplate: mkItem("locked-chest", "chestplate"),
    leggings: mkItem("locked-legs", "leggings"),
    boots: mkItem("locked-boots", "boots"),
    necklace: mkItem("locked-neck", "necklace"),
    bracelet: mkItem("locked-brace", "bracelet"),
    ring1: mkItem("locked-ring-1", "ring"),
    ring2: mkItem("locked-ring-2", "ring"),
  };

  const db = {
    bySlot: new Map([
      ["helmet", helmets],
    ]),
  };

  const result = solveBuild(db, {
    level: 106,
    budget: 0,
    mustGiveStat: 0,
    noNegativeNetSkillBonuses: true,
    lockedBySlot,
    tomes: [],
    poolCap: 80,
    ringPoolCap: 140,
  });

  assert.ok(result.best, "solver should find a build");
  assert.ok(result.best.items.some((it) => it.name === neededHelmet.name), "build should include the needed helmet");
});
