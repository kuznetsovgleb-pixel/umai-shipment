import * as XLSX from "xlsx";
import { STORES, STORE_WINDOWS, ZHASHYLCHA_NIGHT_STORES, POINT_UNLOAD_SEC, KARAKOL_POINT, KARAKOL_WAREHOUSE_IDS } from "../data/reference";

const fmtDateRu = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

// компактная дата для суффикса номера заказа: 10092026 (без точек)
const fmtDateCompact = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}${m}${y}`;
};

// скиллы для выгрузки: только "5т" (для ТС грузоподъёмностью до 5т включительно)
// и "ГБ" (если у машины есть гидроборт)
// ISO-дата + n дней (без сдвигов часовых поясов)
const addDaysIso = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const composeSkills = (tons, gb) => {
  const parts = [];
  if (tons && Number(tons) <= 5) parts.push("5т");
  if (gb) parts.push("ГБ");
  return parts.join(";");
};

export function buildWorkbook(dateIso, consolidated, vehicles, options = {}) {
  const dateLabel = fmtDateRu(dateIso);
  const dateSuffix = fmtDateCompact(dateIso);

  const ordersHeader = [
    "Номер заказа *", "Дата доставки*", "Наименование точки отгрузки*", "Наименование точки доставки*",
    "Кол-во ГМ", "Тип ГМ", "Вес (брутто), кг",
    "Время на разгрузку, сек (на единицу груза)", "Время на разгрузку, сек (на точку)",
    "Товарная группа",
  ];
  // options.nextDayExcept — набор магазинов, у которых дата остаётся текущей; остальным +1 день
  const ordersRows = consolidated.map((r) => {
    const shifted = Boolean(options.nextDayExcept) && !options.nextDayExcept.has(r.store);
    const dIso = shifted ? addDaysIso(dateIso, 1) : dateIso;
    return [
      `${r.order}_${fmtDateCompact(dIso)}`, fmtDateRu(dIso), r.shipPoint, r.store,
      r.total, "Паллета", r.weight,
      r.unloadSec, POINT_UNLOAD_SEC,
      r.group || "",
    ];
  });

  // Жашылча: без столбца «Время погрузки ТС, по» (только время начала погрузки)
  const vehiclesHeader = [
    "Госномер", "Наименование перевозчика", "Готовность", "Тип кузова", "Паллетовместимость, шт",
    "Фактическая грузоподъемность, т", "Собственный", "Vip", "Приоритетные зоны доставки", "Скиллы",
    "Время погрузки ТС, с",
    ...(options.hideLoadToTime ? [] : ["Время погрузки ТС, по"]),
    "Наименование точки старта",
    "Максимальное количество точек доставки",
  ];
  // ТК больше не участвует в выгрузке — только собственный транспорт
  const vehiclesRows = vehicles
    .filter((v) => v.carrier !== "ТК")
    .map((v) => {
      const skills = composeSkills(v.tons, v.gb);
      const row = [
        v.plate, "УмайГрупп", v.ready ? 1 : 0, "РЕФ", v.pallets || "",
        v.tons || "", 1, 1, "Бишкек_город", skills || "",
        v.from || "",
      ];
      if (!options.hideLoadToTime) row.push(v.to || "");
      row.push(v.start || "", v.maxPoints || "");
      return row;
    });

  const storesHeader = ["Код магазина", "Временное окно приемки (в будни)", "Время на разгрузку, сек (на точку)"];
  const storesRows = STORES.map((s) => [s, STORE_WINDOWS[s] || "", POINT_UNLOAD_SEC]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([ordersHeader, ...ordersRows]), "Orders");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([vehiclesHeader, ...vehiclesRows]), "Vehicles");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([storesHeader, ...storesRows]), "Магазины");
  return wb;
}

export function downloadWorkbook(dateIso, consolidated, vehicles) {
  const wb = buildWorkbook(dateIso, consolidated, vehicles);
  XLSX.writeFile(wb, `TMS_import_${dateIso}.xlsx`);
}

// Жашылча (ночь) — отдельная выгрузка: тот же формат, но без столбца
// «Время погрузки ТС, по» на листе Vehicles
export function downloadZhashylchaWorkbook(dateIso, consolidated, vehicles) {
  const wb = buildWorkbook(dateIso, consolidated, vehicles, {
    hideLoadToTime: true,
    nextDayExcept: new Set(ZHASHYLCHA_NIGHT_STORES),
  });
  XLSX.writeFile(wb, `TMS_import_zhashylcha_${dateIso}.xlsx`);
}

// РЦ Жашылча — две выгрузки: «день» (Молоко день) и «ночь» (СОФ + Молоко ночь).
// Формат как у Жашылчи: Orders, Vehicles (без «Время погрузки ТС, по») и Магазины
export function downloadZhashylchaOrdersWorkbook(dateIso, consolidated, part, vehicles) {
  const wb = buildWorkbook(dateIso, consolidated, vehicles, { hideLoadToTime: true });
  XLSX.writeFile(wb, `TMS_import_zhashylcha_${part}_${dateIso}.xlsx`);
}

// ---------------------------------------------------------------------------
// Каракол — отдельная выгрузка: только лист Orders (без Vehicles и Магазины).
//  1) заказы магазинов Каракола: точка отгрузки = "РЦ Каракол";
//  2) перемещения "РЦ склада → РЦ Каракол" — по одному на склад, у которого
//     есть отправленные заказы. Номер: "003" + ддммгггг + номер склада
//     (Пригородное 1, Ак-Орго 2, ПТО 3, Садыгалиева-сыпучка 4, Транзит Север 5) — номер
//     склада фиксированный, не зависит от того, у кого есть заказы в этот день.
// ---------------------------------------------------------------------------

const round2 = (x) => Math.round(x * 100) / 100;

// товарная группа перемещения: у большинства складов она одна на склад; у Транзита
// категория выбирается по каждому заказу — берём ту, на которую приходится больше паллет
const pickGroup = (rows) => {
  const sums = {};
  rows.forEach((r) => {
    const g = r.group || "";
    sums[g] = (sums[g] || 0) + r.total;
  });
  let best = "", bestSum = -1;
  Object.keys(sums).forEach((g) => {
    if (sums[g] > bestSum) { best = g; bestSum = sums[g]; }
  });
  return best;
};

export function buildKarakolTransfers(dateIso, consolidated) {
  const dateSuffix = fmtDateCompact(dateIso);
  const transfers = [];
  KARAKOL_WAREHOUSE_IDS.forEach((whId, idx) => {
    const rows = consolidated.filter((r) => r.whId === whId);
    if (rows.length === 0) return;
    transfers.push({
      whId,
      warehouse: rows[0].warehouse,
      order: `003${dateSuffix}${idx + 1}`,
      shipPoint: rows[0].shipPoint, // РЦ склада
      store: KARAKOL_POINT,
      ordersCount: rows.length,
      total: round2(rows.reduce((s, r) => s + r.total, 0)),
      weight: round2(rows.reduce((s, r) => s + r.weight, 0)),
      unloadSec: rows[0].unloadSec,
      group: pickGroup(rows),
    });
  });
  return transfers;
}

export function buildKarakolWorkbook(dateIso, consolidated) {
  const dateLabel = fmtDateRu(dateIso);
  const dateSuffix = fmtDateCompact(dateIso);

  const ordersHeader = [
    "Номер заказа *", "Дата доставки*", "Наименование точки отгрузки*", "Наименование точки доставки*",
    "Кол-во ГМ", "Тип ГМ", "Вес (брутто), кг",
    "Время на разгрузку, сек (на единицу груза)", "Время на разгрузку, сек (на точку)",
    "Товарная группа",
  ];

  const storeRows = consolidated.map((r) => [
    `${r.order}_${dateSuffix}`, dateLabel, KARAKOL_POINT, r.store,
    r.total, "Паллета", r.weight,
    r.unloadSec, POINT_UNLOAD_SEC,
    r.group || "",
  ]);

  const transferRows = buildKarakolTransfers(dateIso, consolidated).map((t) => [
    t.order, dateLabel, t.shipPoint, t.store,
    t.total, "Паллета", t.weight,
    t.unloadSec, POINT_UNLOAD_SEC,
    t.group,
  ]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([ordersHeader, ...storeRows, ...transferRows]), "Orders");
  return wb;
}

export function downloadKarakolWorkbook(dateIso, consolidated) {
  const wb = buildKarakolWorkbook(dateIso, consolidated);
  XLSX.writeFile(wb, `TMS_import_karakol_${dateIso}.xlsx`);
}

// ---------------------------------------------------------------------------
// Холод Юг — стандартная выгрузка, но только лист Orders (без Vehicles и Магазины).
// Точка отгрузки — склад заказа (РЦ Садыгалиева - заморозка / РЦ Жашылча),
// дата — дата отгрузки, выбранная на вкладке «Холод Юг».
// ---------------------------------------------------------------------------

export function buildHolodYugWorkbook(dateIso, consolidated) {
  const dateLabel = fmtDateRu(dateIso);
  const dateSuffix = fmtDateCompact(dateIso);

  const ordersHeader = [
    "Номер заказа *", "Дата доставки*", "Наименование точки отгрузки*", "Наименование точки доставки*",
    "Кол-во ГМ", "Тип ГМ", "Вес (брутто), кг",
    "Время на разгрузку, сек (на единицу груза)", "Время на разгрузку, сек (на точку)",
    "Товарная группа",
  ];
  const ordersRows = consolidated.map((r) => [
    `${r.order}_${dateSuffix}`, dateLabel, r.shipPoint, r.store,
    r.total, "Паллета", r.weight,
    r.unloadSec, POINT_UNLOAD_SEC,
    r.group || "",
  ]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([ordersHeader, ...ordersRows]), "Orders");
  return wb;
}

export function downloadHolodYugWorkbook(dateIso, consolidated) {
  const wb = buildHolodYugWorkbook(dateIso, consolidated);
  XLSX.writeFile(wb, `TMS_import_holod_yug_${dateIso}.xlsx`);
}
