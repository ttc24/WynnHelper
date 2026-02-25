const SKILLS = ["strength","dexterity","intelligence","defence","agility"];

const slotKeys = [
  { key: "helmet", label: "Helmet", slot: "helmet" },
  { key: "chestplate", label: "Chestplate", slot: "chestplate" },
  { key: "leggings", label: "Leggings", slot: "leggings" },
  { key: "boots", label: "Boots", slot: "boots" },
  { key: "necklace", label: "Necklace", slot: "necklace" },
  { key: "bracelet", label: "Bracelet", slot: "bracelet" },
  { key: "ring1", label: "Ring 1", slot: "ring" },
  { key: "ring2", label: "Ring 2", slot: "ring" },
  { key: "weapon", label: "Weapon", slot: "weapon" },
];

const el = (id) => document.getElementById(id);

const state = {
  rarities: [],
  rarityEnabled: new Set(),
  selected: {},
  locks: {},
  tomes: [],

  lastResponse: null,

  compare: { slotKey: null, candidateName: null, candidate: null, currentName: null, slotLabel: null },
  ringTargetKey: "ring1"
};

function slotLabelByKey(slotKey) {
  return slotKeys.find((x) => x.key === slotKey)?.label || slotKey;
}

function getRingTargetKey() {
  if (state.ringTargetKey === "ring1" || state.ringTargetKey === "ring2") return state.ringTargetKey;
  return "ring1";
}

function resolveTargetKeyForSlot(slot) {
  if (slot !== "ring") return slotKeys.find((x) => x.slot === slot)?.key || null;

  if (getMode() === "swap") {
    const swapKey = el("swapKey")?.value || "";
    if (swapKey === "ring1" || swapKey === "ring2") return swapKey;
  }

  return getRingTargetKey();
}

function isTargetLocked(targetKey) {
  return Boolean(targetKey && state.locks[targetKey]);
}

function showLockedSwapMessage(targetKey) {
  const targetLabel = slotLabelByKey(targetKey);
  const msg = `${targetLabel} is locked. Unlock it to swap.`;
  const status = el("status");
  if (status) status.textContent = msg;
  else alert(msg);
}

function badge(text) {
  const span = document.createElement("span");
  span.className = "badge";
  span.textContent = text;
  return span;
}

function makeSuggestItem(it) {
  const div = document.createElement("div");
  div.className = "suggestItem";

  const name = document.createElement("span");
  name.textContent = it.name;

  const meta = document.createElement("span");
  meta.className = "small";
  meta.textContent = `lvl ${it.levelReq}, ${it.rarity}`;

  div.appendChild(name);
  div.appendChild(meta);
  return div;
}

function reqStr(arr) {
  const map = ["STR","DEX","INT","DEF","AGI"];
  const parts = [];
  for (let i=0;i<5;i++) if (arr[i]) parts.push(`${map[i]}:${arr[i]}`);
  return parts.length ? parts.join(" ") : "—";
}

function bonusStr(arr) {
  const map = ["STR","DEX","INT","DEF","AGI"];
  const parts = [];
  for (let i=0;i<5;i++) if (arr[i]) parts.push(`${arr[i] > 0 ? "+" : ""}${arr[i]} ${map[i]}`);
  return parts.length ? parts.join(" ") : "—";
}

function gatherPayload() {
  const rarities = Array.from(state.rarityEnabled);
  const targetSlot = deriveTargetSlot();
  const targetSlotKey = deriveTargetSlotKey(targetSlot);

  return {
    level: Number(el("level").value),
    class: el("class").value || "",
    extraPoints: Number(el("extraPoints").value),
    strictWeaponClass: el("strictWeaponClass").value === "1",

    rarities,
    minItemLevel: Number(el("minItemLevel").value),
    limit: Number(el("limit").value),
    sortBy: el("sortBy").value,

    noMythic: el("noMythic").checked,
    noCraftedBestEffort: el("noCrafted").checked,
    noNegativeItemSkillBonuses: el("noNegItem").checked,
    noNegativeNetSkillBonuses: el("noNegNet").checked,

    mustGiveStat: el("mustGiveStat").value || "",
    minImprove: Number(el("minImprove").value || 0),

    selected: state.selected,
    locks: state.locks,
    targetSlot,
    targetSlotKey,
    tomes: state.tomes,

    debug: el("debug").checked,
    debugLimit: Number(el("debugLimit").value),
  };
}

function getMode() {
  return el("modeSwap")?.checked ? "swap" : "fill";
}

function normalizeSwapSlot(swapKey) {
  if (!swapKey) return "";
  return (swapKey === "ring1" || swapKey === "ring2") ? "ring" : swapKey;
}

function deriveTargetSlot() {
  if (getMode() !== "swap") return "";
  return normalizeSwapSlot(el("swapKey")?.value || "");
}

function deriveTargetSlotKey(targetSlot = deriveTargetSlot()) {
  if (!targetSlot) return "";

  if (getMode() === "swap") {
    const swapKey = el("swapKey")?.value || "";
    if (swapKey) return swapKey;
  }

  if (targetSlot === "ring") return getRingTargetKey();
  return targetSlot;
}

function syncModeUI() {
  const swapMode = getMode() === "swap";
  el("swapBox").style.display = swapMode ? "flex" : "none";
}

async function apiJson(url, opts) {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  return json;
}

async function initHealth() {
  const h = await apiJson("/api/health");
  state.rarities = h.rarities;
  state.rarityEnabled = new Set(h.rarities);
  renderRarities();
}

function renderRarities() {
  const box = el("rarityBox");
  box.innerHTML = "";
  for (const r of state.rarities) {
    const lab = document.createElement("label");
    lab.className = "pill";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.rarityEnabled.has(r);
    cb.addEventListener("change", () => {
      if (cb.checked) state.rarityEnabled.add(r);
      else state.rarityEnabled.delete(r);
      refresh();
    });
    const t = document.createElement("span");
    t.textContent = r;
    lab.appendChild(cb);
    lab.appendChild(t);
    box.appendChild(lab);
  }
}

function renderTomes() {
  const root = el("tomePills");
  root.innerHTML = "";
  for (const t of state.tomes) {
    const lab = document.createElement("span");
    lab.className = "pill";
    lab.textContent = t;
    const x = document.createElement("button");
    x.className = "secondary btnTiny";
    x.textContent = "×";
    x.addEventListener("click", () => {
      state.tomes = state.tomes.filter((v) => v !== t);
      renderTomes();
      refresh();
    });
    lab.appendChild(x);
    root.appendChild(lab);
  }
}

function renderSlots() {
  const root = el("slots");
  root.innerHTML = "";

  for (const s of slotKeys) {
    const meta = document.createElement("div");
    meta.className = "slotMeta";

    // lock checkbox (per slot key)
    const lockLab = document.createElement("label");
    lockLab.className = "pill";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = Boolean(state.locks[s.key]);
    cb.addEventListener("change", () => {
      state.locks[s.key] = cb.checked;
      refresh();
    });
    lockLab.appendChild(cb);
    lockLab.appendChild(document.createTextNode("Lock"));
    meta.appendChild(lockLab);

    if (s.key === "ring1") {
      const ringTargetLab = document.createElement("label");
      ringTargetLab.className = "pill";
      ringTargetLab.appendChild(document.createTextNode("Ring target"));

      const ringTarget = document.createElement("select");
      ringTarget.style.margin = "0";
      ringTarget.innerHTML = `
        <option value="ring1">Ring 1</option>
        <option value="ring2">Ring 2</option>
      `;
      ringTarget.value = getRingTargetKey();
      ringTarget.addEventListener("change", () => {
        state.ringTargetKey = ringTarget.value;
        refresh();
      });

      ringTargetLab.appendChild(ringTarget);
      meta.appendChild(ringTargetLab);
    }

    root.appendChild(meta);

    // selection row
    const row = document.createElement("div");
    row.className = "slotRow";

    const lab = document.createElement("div");
    lab.className = "small";
    lab.textContent = s.label;

    const suggestWrap = document.createElement("div");
    suggestWrap.className = "suggest";

    const input = document.createElement("input");
    input.placeholder = `Search ${s.label}...`;
    input.value = state.selected[s.key] || "";
    input.autocomplete = "off";

    const list = document.createElement("div");
    list.className = "suggestList";
    list.style.display = "none";

    let activeIdx = -1;
    let lastItems = [];
    let requestSeq = 0;
    let latestResultSeq = 0;
    let inflightController = null;

    const closeList = () => {
      list.style.display = "none";
      list.classList.remove("loading", "error");
      activeIdx = -1;
      lastItems = [];
    };

    const showListState = (text, cls) => {
      list.innerHTML = "";
      const statusRow = document.createElement("div");
      statusRow.className = "suggestItem small";
      if (cls) statusRow.classList.add(cls);
      statusRow.textContent = text;
      list.appendChild(statusRow);
      list.style.display = "block";
    };

    async function doSearch() {
      const q = input.value.trim();
      const seq = ++requestSeq;

      if (inflightController) inflightController.abort();
      const controller = new AbortController();
      inflightController = controller;

      list.classList.remove("error");
      list.classList.add("loading");
      showListState("Loading…", "loading");

      const params = new URLSearchParams({
        q,
        slot: s.slot,
        mode: el("searchMode").value,
        level: el("level").value,
        class: el("class").value || "",
        strictWeaponClass: el("strictWeaponClass").value,
      });

      try {
        const json = await apiJson(`/api/search?${params.toString()}`, { signal: controller.signal });
        if (seq !== requestSeq) return;

        latestResultSeq = seq;
        lastItems = json.results || [];

        list.innerHTML = "";
        activeIdx = -1;

        for (let i = 0; i < lastItems.length; i++) {
          const it = lastItems[i];
          const div = makeSuggestItem(it);
          div.addEventListener("mousedown", (e) => {
            e.preventDefault();
            state.selected[s.key] = it.name;
            input.value = it.name;
            closeList();
            refresh();
          });
          list.appendChild(div);
        }

        list.style.display = lastItems.length ? "block" : "none";
      } catch (err) {
        if (seq !== requestSeq) return;
        if (err?.name === "AbortError") return;

        closeList();
        if (document.activeElement === input) {
          list.classList.add("error");
          showListState("Search failed. Try again.", "error");
        }
      } finally {
        if (seq !== requestSeq) return;
        if (inflightController === controller) inflightController = null;
        list.classList.remove("loading");
      }
    }

    let t = null;
    input.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(doSearch, 140);
    });
    input.addEventListener("focus", doSearch);
    input.addEventListener("blur", () => setTimeout(closeList, 120));

    // keyboard navigation
    input.addEventListener("keydown", (e) => {
      if (latestResultSeq !== requestSeq) return;
      if (list.style.display !== "block") return;
      const items = Array.from(list.querySelectorAll(".suggestItem"));
      if (!items.length) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIdx = Math.min(items.length - 1, activeIdx + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIdx = Math.max(0, activeIdx - 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeIdx >= 0 && lastItems[activeIdx]) {
          state.selected[s.key] = lastItems[activeIdx].name;
          input.value = lastItems[activeIdx].name;
          closeList();
          refresh();
        }
        return;
      } else {
        return;
      }

      items.forEach((x) => x.classList.remove("active"));
      if (items[activeIdx]) items[activeIdx].classList.add("active");
    });

    suggestWrap.appendChild(input);
    suggestWrap.appendChild(list);

    const clearBtn = document.createElement("button");
    clearBtn.className = "secondary btnTiny";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", () => {
      delete state.selected[s.key];
      input.value = "";
      refresh();
    });

    row.appendChild(lab);
    row.appendChild(suggestWrap);
    row.appendChild(clearBtn);

    root.appendChild(row);
  }
}

async function refresh() {
  try {
    el("status").textContent = "Loading…";
    el("alloc").textContent = "";
    el("setSynergy").textContent = "";
    el("results").innerHTML = "";
    el("debugBox").innerHTML = "";

    const payload = gatherPayload();
    const json = await apiJson("/api/compatible", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    state.lastResponse = json;

    const b = json.budget;
    const base = json.baseline;
    el("status").textContent = `Budget ${b} | Baseline spend ${base.finalSpend} | Remaining ${base.remainingSP} | Equip-order ${base.equipOrderOk ? "OK" : "NO"}`;

    // allocation preview
    if (json.allocationPreview?.length) {
      const top3 = json.allocationPreview.slice(0, 3).map((a) => {
        const v = a.alloc;
        return `${a.name}: used ${a.used}, rem ${a.remaining} | STR ${v.strength} DEX ${v.dexterity} INT ${v.intelligence} DEF ${v.defence} AGI ${v.agility}`;
      });
      el("alloc").textContent = "Allocation preview:\n" + top3.join("\n");
    } else {
      el("alloc").textContent = "Allocation preview: (build invalid / over budget)";
    }

    // set synergy
    const sy = json.setSynergy;
    if (sy && sy.count) {
      const groups = Object.entries(sy.groups || {}).map(([k, v]) => `${k}: ${v.length} (${v.join(", ")})`);
      el("setSynergy").textContent = `Set synergy: ${sy.count} set items\n` + groups.join("\n");
    }

    // notes
    const notesEl = el("notes");
    notesEl.innerHTML = "";
    for (const n of (json.notes || [])) {
      const noteLine = document.createElement("div");
      noteLine.textContent = `• ${n}`;
      notesEl.appendChild(noteLine);
    }

    // debug excluded
    if (payload.debug && json.debugExcluded) {
      const c = json.debugExcluded.counts || {};
      const countsLine = Object.entries(c).sort((a,b)=>b[1]-a[1]).map(([k,v]) => `${k}: ${v}`).join(" | ");
      const sample = (json.debugExcluded.samples || []).slice(0, 25).map((x) => `- ${x.name}: ${x.reason}`).join("\n");

      const debugBox = el("debugBox");

      const heading = document.createElement("strong");
      heading.textContent = "Why excluded (total counts + partial samples):";

      const details = document.createElement("div");
      details.className = "small mono";
      details.style.whiteSpace = "pre-wrap";
      details.style.marginTop = ".35rem";
      details.textContent = `${countsLine || "(no exclusions captured)"}\n\n${sample || ""}`;

      debugBox.appendChild(heading);
      debugBox.appendChild(details);
    }

    renderResults(json.results, payload.targetSlot, payload.targetSlotKey);
  } catch (e) {
    el("status").textContent = `Error: ${e.message || e}`;
    el("alloc").textContent = "If this says DB fetch failed, hit “Force DB reload”.";
  }
}

function renderResults(results, targetSlot, targetSlotKey = "") {
  const root = el("results");
  root.innerHTML = "";

  const slots = Object.keys(results || {});
  for (const slot of slots) {
    const card = document.createElement("div");
    card.className = "card";

    const h = document.createElement("h5");
    h.style.marginBottom = ".25rem";
    h.textContent = `Slot: ${slot}`;
    card.appendChild(h);

    const list = document.createElement("div");
    const items = results[slot] || [];

    const targetKey = targetSlot && slot === targetSlot
      ? (targetSlotKey || resolveTargetKeyForSlot(slot))
      : resolveTargetKeyForSlot(slot);
    if (targetSlot && slot !== targetSlot) continue;
    const currentName = targetKey ? (state.selected[targetKey] || null) : null;
    const targetLocked = isTargetLocked(targetKey);
    const targetLabel = targetKey ? slotLabelByKey(targetKey) : slot;

    for (const it of items) {
      const row = document.createElement("div");
      row.className = "resultItem";

      const top = document.createElement("div");
      top.className = "resultTop";

      const left = document.createElement("div");

      const nameLine = document.createElement("div");
      nameLine.style.display = "flex";
      nameLine.style.gap = ".4rem";
      nameLine.style.flexWrap = "wrap";
      nameLine.style.alignItems = "center";

      const name = document.createElement("strong");
      name.textContent = it.name;

      nameLine.appendChild(name);
      nameLine.appendChild(badge(it.rarity));
      nameLine.appendChild(badge(`lvl ${it.levelReq}`));
      nameLine.appendChild(badge(`rem ${it.remainingAfter}`));
      nameLine.appendChild(badge(`Δrem ${it.deltaRemaining >= 0 ? "+" : ""}${it.deltaRemaining}`));

      left.appendChild(nameLine);

      const meta = document.createElement("div");
      meta.className = "small mono";
      meta.textContent = `req: ${reqStr(it.req)} | bonus: ${bonusStr(it.bonus)} | finalSpend ${it.finalSpend}`;
      left.appendChild(meta);

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.gap = ".4rem";
      right.style.flexWrap = "wrap";

      const compareBtn = document.createElement("button");
      compareBtn.className = "secondary btnTiny";
      compareBtn.textContent = "Compare";
      compareBtn.addEventListener("click", () => openCompare(slot, targetKey, it, currentName, targetLabel));

      const swapBtn = document.createElement("button");
      swapBtn.className = "btnTiny";
      swapBtn.textContent = "Swap";
      swapBtn.disabled = targetLocked;
      if (targetLocked) {
        swapBtn.title = `${targetLabel} is locked`;
        swapBtn.setAttribute("aria-label", `Swap disabled: ${targetLabel} is locked`);
      }
      swapBtn.addEventListener("click", () => swapIntoTarget(slot, it.name, targetKey));

      right.appendChild(compareBtn);
      right.appendChild(swapBtn);

      top.appendChild(left);
      top.appendChild(right);

      row.appendChild(top);
      list.appendChild(row);
    }

    card.appendChild(list);
    root.appendChild(card);
  }
}

function swapIntoTarget(slot, candName, explicitTargetKey = null) {
  const targetKey = explicitTargetKey || resolveTargetKeyForSlot(slot);
  if (!targetKey) return;

  if (isTargetLocked(targetKey)) {
    showLockedSwapMessage(targetKey);
    return;
  }

  state.selected[targetKey] = candName;

  if (slot === "ring" && (targetKey === "ring1" || targetKey === "ring2")) {
    state.ringTargetKey = targetKey;
  }

  renderSlots();
  refresh();
}

function openCompare(slot, slotKey, candidate, currentName, slotLabel) {
  const dlg = el("compareDlg");
  const title = el("cmpTitle");
  const body = el("cmpBody");

  const cur = currentName ? `Current: ${currentName}` : "Current: (none)";
  const resolvedLabel = slotLabel || slotLabelByKey(slotKey || slot);
  title.textContent = `${resolvedLabel} – Compare`;

  body.textContent =
`Slot: ${resolvedLabel}
${cur}
Candidate: ${candidate.name}

Candidate req:   ${reqStr(candidate.req)}
Candidate bonus: ${bonusStr(candidate.bonus)}

After swap:
Final spend: ${candidate.finalSpend}
Remaining SP: ${candidate.remainingAfter}
Δ Remaining:  ${candidate.deltaRemaining >= 0 ? "+" : ""}${candidate.deltaRemaining}`;

  state.compare = { slotKey: slotKey || slot, candidateName: candidate.name, candidate, currentName, slotLabel: resolvedLabel };

  dlg.showModal();
}

function wireCompareDialog() {
  el("cmpClose").addEventListener("click", () => el("compareDlg").close());
  el("cmpSwap").addEventListener("click", () => {
    const c = state.compare;
    if (c?.slotKey && c?.candidateName) {
      const slot = slotKeys.find((s) => s.key === c.slotKey)?.slot || c.slotKey;
      swapIntoTarget(slot, c.candidateName, c.slotKey);
    }
    el("compareDlg").close();
  });
}

function wireTomeSearch() {
  const input = el("tomeInput");
  const list = el("tomeList");

  let activeIdx = -1;
  let lastItems = [];

  const close = () => { list.style.display = "none"; activeIdx = -1; lastItems = []; };

  async function doSearch() {
    const q = input.value.trim();
    if (!q) { close(); return; }

    // tomes are stored as slot="tome" on backend, but /api/search expects slot
    const params = new URLSearchParams({
      q,
      slot: "tome",
      mode: el("searchMode").value,
      level: el("level").value,
      class: el("class").value || "",
      strictWeaponClass: el("strictWeaponClass").value,
    });

    const json = await apiJson(`/api/search?${params.toString()}`);
    lastItems = json.results || [];

    list.innerHTML = "";
    activeIdx = -1;

    for (let i=0;i<lastItems.length;i++) {
      const it = lastItems[i];
      const div = makeSuggestItem(it);
      div.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (!state.tomes.includes(it.name)) state.tomes.push(it.name);
        input.value = "";
        close();
        renderTomes();
        refresh();
      });
      list.appendChild(div);
    }

    list.style.display = lastItems.length ? "block" : "none";
  }

  let t = null;
  input.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(doSearch, 140);
  });
  input.addEventListener("focus", doSearch);
  input.addEventListener("blur", () => setTimeout(close, 120));

  input.addEventListener("keydown", (e) => {
    if (list.style.display !== "block") return;
    const items = Array.from(list.querySelectorAll(".suggestItem"));
    if (!items.length) return;

    if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(items.length-1, activeIdx+1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(0, activeIdx-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx >= 0 && lastItems[activeIdx]) {
        const it = lastItems[activeIdx];
        if (!state.tomes.includes(it.name)) state.tomes.push(it.name);
        input.value = "";
        close();
        renderTomes();
        refresh();
      }
      return;
    } else return;

    items.forEach((x) => x.classList.remove("active"));
    if (items[activeIdx]) items[activeIdx].classList.add("active");
  });

  el("clearTomes").addEventListener("click", () => {
    state.tomes = [];
    renderTomes();
    refresh();
  });
}

function wireControls() {
  const refreshers = [
    "level","class","extraPoints","strictWeaponClass",
    "searchMode","sortBy","minItemLevel","limit",
    "noMythic","noCrafted","noNegItem","noNegNet","mustGiveStat","minImprove","debug","debugLimit"
  ];
  for (const id of refreshers) el(id).addEventListener("change", refresh);

  const onModeChange = () => {
    syncModeUI();
    refresh();
  };

  el("modeFill").addEventListener("change", onModeChange);
  el("modeSwap").addEventListener("change", onModeChange);
  el("swapKey").addEventListener("change", () => {
    if (getMode() === "swap") refresh();
  });

  el("refresh").addEventListener("click", refresh);

  el("clearAll").addEventListener("click", () => {
    state.selected = {};
    state.locks = {};
    renderSlots();
    refresh();
  });

  el("reloadDb").addEventListener("click", async () => {
    try {
      await apiJson("/api/reload", { method: "POST" });
      await initHealth();
      renderSlots();
      refresh();
    } catch (e) {
      alert(`Reload failed: ${e.message || e}`);
    }
  });

  el("explainBtn").addEventListener("click", explainItem);

  el("solve").addEventListener("click", solveBuild);
}

async function explainItem() {
  el("explainOut").textContent = "";
  const name = el("explainName").value.trim();
  if (!name) return;

  try {
    const payload = gatherPayload();
    const json = await apiJson("/api/explain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, itemName: name }),
    });
    el("explainOut").textContent = JSON.stringify(json, null, 2);
  } catch (e) {
    el("explainOut").textContent = `Error: ${e.message || e}`;
  }
}

async function solveBuild() {
  try {
    const payload = gatherPayload();
    const json = await apiJson("/api/solve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!json.found) {
      alert("Solver: no full build found with current locks/filters. Try loosening filters or locking fewer items.");
      return;
    }

    // Apply solution back into selection (best effort)
    const bySlot = {};
    for (const it of json.items) {
      if (it.slot === "ring") (bySlot.rings ??= []).push(it.name);
      else bySlot[it.slot] = it.name;
    }

    for (const s of slotKeys) {
      if (s.slot === "ring") continue;
      if (bySlot[s.slot]) state.selected[s.key] = bySlot[s.slot];
    }
    const rings = (bySlot.rings ?? []);
    if (rings[0]) state.selected.ring1 = rings[0];
    if (rings[1]) state.selected.ring2 = rings[1];

    renderSlots();
    refresh();

    alert(`Solver found build. Remaining SP: ${json.score.remaining} (neg tradeoffs: ${json.score.neg}).`);
  } catch (e) {
    alert(`Solver error: ${e.message || e}`);
  }
}

(async function init() {
  await initHealth();
  renderTomes();
  renderSlots();
  syncModeUI();
  wireCompareDialog();
  wireTomeSearch();
  wireControls();
  refresh();
})();
