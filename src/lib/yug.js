import * as XLSX from "xlsx";
import { HOLOD_YUG_STORES as STORES } from "../data/reference";

// ---------------------------------------------------------------------------
// Холод Юг: даты отгрузки, загрузка заказов Жашылчи из файла 1С,
// подбор магазина по названию, пересчёт веса/объёма в паллеты,
// объединение заказов одного магазина.
// ---------------------------------------------------------------------------

export const YUG_ZH_SHIP_POINT = "РЦ Жашылча";
export const YUG_ZH_GROUP = "Охлажденка";
export const YUG_ZH_NAME = "Жашылча";

// паллета: до 500 кг и до 1 м³ — одна паллета; свыше — делим на несколько
export const YUG_PALLET_KG = 500;
export const YUG_PALLET_M3 = 1;

// ---- даты отгрузки: понедельник, среда, пятница, суббота ----

export const YUG_SHIP_WEEKDAYS = [1, 3, 5, 6]; // 0 = воскресенье

const parseISO = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const toISO = (dt) => {
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${dt.getFullYear()}-${m}-${d}`;
};

export const isShipDay = (iso) => YUG_SHIP_WEEKDAYS.includes(parseISO(iso).getDay());

// ближайший день отгрузки, не раньше указанной даты (сама дата — если она день отгрузки)
export const nextShipDate = (iso) => {
  const dt = parseISO(iso);
  for (let i = 0; i < 8; i++) {
    if (YUG_SHIP_WEEKDAYS.includes(dt.getDay())) return toISO(dt);
    dt.setDate(dt.getDate() + 1);
  }
  return iso;
};

// шаг к следующему (dir = 1) или предыдущему (dir = -1) дню отгрузки
export const stepShipDate = (iso, dir) => {
  const dt = parseISO(iso);
  for (let i = 0; i < 8; i++) {
    dt.setDate(dt.getDate() + dir);
    if (YUG_SHIP_WEEKDAYS.includes(dt.getDay())) return toISO(dt);
  }
  return iso;
};

const WEEKDAY_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
export const weekdayShort = (iso) => WEEKDAY_SHORT[parseISO(iso).getDay()];

// ---- паллеты и объединение заказов ----

export const yugPallets = (weightKg, volumeM3) => {
  const w = Number(weightKg) || 0;
  const v = Number(volumeM3) || 0;
  // 1e-9 — защита от ошибок плавающей точки (500.0000000001 не должно давать 2 паллеты)
  return Math.max(1, Math.ceil(w / YUG_PALLET_KG - 1e-9), Math.ceil(v / YUG_PALLET_M3 - 1e-9));
};

const round3 = (x) => Math.round(x * 1000) / 1000;

// заказы одного магазина схлопываются в один: вес и объём суммируются,
// паллеты считаются по суммам, номером остаётся номер первого заказа
export const collapseYugRows = (rows) => {
  const groups = [];
  const byStore = new Map();
  rows.forEach((r) => {
    const order = (r.order || "").trim();
    if (!order) return;
    const weight = parseFloat(r.weight) || 0;
    const volume = parseFloat(r.volume) || 0;
    const category = r.category || "";
    const storeName = (r.store || "").trim().toLowerCase();
    // заказы одного магазина объединяются; если у строк есть товарная группа
    // (Транзит Юг) — только в пределах одной группы
    const storeKey = storeName ? `${storeName}|${category}` : "";
    let g = storeKey ? byStore.get(storeKey) : null;
    if (!g) {
      g = { key: r.id, store: r.store || "", category, order, orders: [], count: 0, weight: 0, volume: 0, firstId: r.id };
      groups.push(g);
      if (storeKey) byStore.set(storeKey, g);
    }
    g.orders.push(order);
    g.count += 1;
    g.weight += weight;
    g.volume += volume;
  });
  groups.forEach((g) => {
    g.weight = round3(g.weight);
    g.volume = round3(g.volume);
    g.pallets = yugPallets(g.weight, g.volume);
  });
  return groups;
};

// ---- подбор магазина по названию из файла ----

const normName = (s) => String(s).toLowerCase().replace(/ё/g, "е");
const squash = (s) => normName(s).replace(/[\s\-_.()]/g, "");
const codeOf = (s) => {
  const m = normName(s).match(/^\s*(глобус|достор|spar)[\s\-]*(\d+)/);
  return m ? `${m[1]}${parseInt(m[2], 10)}` : null;
};

// индекс магазинов для подбора по названию: по умолчанию — магазины Холода Юга;
// для других вкладок (например, РЦ Жашылча) передаётся свой список
const buildIndex = (list) => {
  const bySquash = new Map();
  const byCode = new Map();
  list.forEach((s) => {
    bySquash.set(squash(s), s);
    const c = codeOf(s);
    if (c) {
      if (!byCode.has(c)) byCode.set(c, []);
      byCode.get(c).push(s);
    }
  });
  return { bySquash, byCode };
};
const DEFAULT_INDEX = buildIndex(STORES);
const indexCache = new WeakMap();
const indexFor = (list) => {
  if (!list || list === STORES) return DEFAULT_INDEX;
  if (!indexCache.has(list)) indexCache.set(list, buildIndex(list));
  return indexCache.get(list);
};

// 1) точное совпадение (без учёта регистра, пробелов и дефисов);
// 2) по коду: «Глобус14 Ош-Нурзаман» → «Глобус14», «SPAR-05 Атыр» → «SPAR-05 Атыр»;
// не нашли или несколько кандидатов — возвращаем "", магазин выберут вручную
export const matchStore = (rawName, storeList) => {
  const { bySquash, byCode } = indexFor(storeList);
  const name = String(rawName || "").trim();
  if (!name) return "";
  const exact = bySquash.get(squash(name));
  if (exact) return exact;
  const c = codeOf(name);
  if (c && byCode.has(c)) {
    let cands = byCode.get(c);
    if (cands.length > 1) {
      const wantsSp = /(^|\s)сп$/.test(normName(name));
      cands = cands.filter((s) => /(^|\s)СП$/.test(s) === wantsSp);
    }
    if (cands.length === 1) return cands[0];
  }
  return "";
};

// ---- чтение файла 1С ----

const dmyToISO = (s) => {
  const m = String(s).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return "";
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
};

const cellToISO = (v) => {
  if (v == null || v === "") return "";
  if (typeof v === "number") {
    const p = XLSX.SSF.parse_date_code(v);
    return p ? `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}` : "";
  }
  if (v instanceof Date) return toISO(v);
  return dmyToISO(v);
};

const toNum = (v) => {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return isNaN(n) ? 0 : n;
};

// Ожидаемые столбцы: «Номер ERP», «Контрагент», «Общая масса», «Общий объём»
// (+ первый столбец с датой отгрузки). Строка «Итого» и пустые строки пропускаются.
export function parseYugFile(arrayBuffer, storeList) {
  let wb;
  try {
    wb = XLSX.read(arrayBuffer, { type: "array", cellDates: false });
  } catch {
    return { error: "Не удалось прочитать файл. Нужен Excel (.xlsx или .xls)." };
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { error: "В файле нет листов." };
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  let headerIdx = -1;
  let col = {};
  for (let i = 0; i < data.length; i++) {
    const cells = (data[i] || []).map((c) => (c == null ? "" : normName(c)));
    const order = cells.findIndex((c) => c.includes("номер erp"));
    const store = cells.findIndex((c) => c.includes("контрагент"));
    if (order >= 0 && store >= 0) {
      headerIdx = i;
      col = {
        order,
        store,
        weight: cells.findIndex((c) => c.includes("масса")),
        volume: cells.findIndex((c) => c.includes("объем")),
        date: cells.findIndex((c) => c.includes("дата отгрузки")),
      };
      break;
    }
  }
  if (headerIdx < 0 || col.weight < 0 || col.volume < 0) {
    return { error: "Не нашёл столбцы «Номер ERP», «Контрагент», «Общая масса», «Общий объём». Проверьте файл." };
  }

  const lines = [];
  const dates = new Set();
  for (let i = headerIdx + 1; i < data.length; i++) {
    const r = data[i] || [];
    const order = String(r[col.order] ?? "").trim();
    const rawName = String(r[col.store] ?? "").trim();
    if (!order || !rawName) continue;
    const dateIso = col.date >= 0 ? cellToISO(r[col.date]) : "";
    if (dateIso) dates.add(dateIso);
    lines.push({
      order,
      rawName,
      store: matchStore(rawName, storeList),
      weight: round3(toNum(r[col.weight])),
      volume: round3(toNum(r[col.volume])),
    });
  }
  if (lines.length === 0) return { error: "В файле не найдено ни одного заказа." };
  return { lines, dates: [...dates].sort() };
}
