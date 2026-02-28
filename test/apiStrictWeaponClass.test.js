import test from "node:test";
import assert from "node:assert/strict";

import { parseStrictWeaponClass, passesFilters } from "../src/api.js";

function mkItem({ slot = "weapon", classReq = null, weaponType = null } = {}) {
  return {
    levelReq: 1,
    slot,
    classReq,
    weaponType,
    rarity: "Rare",
    identifier: true,
    bonusArr: [0, 0, 0, 0, 0],
    bonusEffArr: [0, 0, 0, 0, 0],
  };
}

test("strictWeaponClass parser defaults to true for missing or invalid values", () => {
  assert.equal(parseStrictWeaponClass(undefined), true);
  assert.equal(parseStrictWeaponClass(null), true);
  assert.equal(parseStrictWeaponClass(""), true);
  assert.equal(parseStrictWeaponClass("invalid"), true);
});

test("strictWeaponClass parser accepts booleans, numbers, and common strings", () => {
  assert.equal(parseStrictWeaponClass(true), true);
  assert.equal(parseStrictWeaponClass(false), false);
  assert.equal(parseStrictWeaponClass(1), true);
  assert.equal(parseStrictWeaponClass(0), false);
  assert.equal(parseStrictWeaponClass("1"), true);
  assert.equal(parseStrictWeaponClass("0"), false);
  assert.equal(parseStrictWeaponClass("true"), true);
  assert.equal(parseStrictWeaponClass("false"), false);
});

test("class + weapon filtering honors strictWeaponClass parity across query/body-style values", () => {
  const classCtx = { level: 106, class: "mage", minItemLevel: null };
  const spear = mkItem({ weaponType: "spear" });

  const queryCtx = {
    ...classCtx,
    strictWeaponClass: parseStrictWeaponClass(undefined),
  };
  const bodyCtx = {
    ...classCtx,
    strictWeaponClass: parseStrictWeaponClass(undefined),
  };

  assert.equal(passesFilters(spear, queryCtx), false);
  assert.equal(passesFilters(spear, bodyCtx), false);

  const queryLooseCtx = {
    ...classCtx,
    strictWeaponClass: parseStrictWeaponClass("0"),
  };
  const bodyLooseCtx = {
    ...classCtx,
    strictWeaponClass: parseStrictWeaponClass(0),
  };

  assert.equal(passesFilters(spear, queryLooseCtx), true);
  assert.equal(passesFilters(spear, bodyLooseCtx), true);
});
