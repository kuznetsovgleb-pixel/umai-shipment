import * as XLSX from "xlsx";
import { STORES, STORE_WINDOWS, POINT_UNLOAD_SEC } from "../data/reference";

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
const composeSkills = (tons, gb) => {
  const parts = [];
  if (tons && Number(tons) <= 5) parts.push("5т");
  if (gb) parts.push("ГБ");
  return parts.join(";");
};

export function buildWorkbook(dateIso, consolidated, vehicles) {
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

  const vehiclesHeader = [
    "Госномер", "Наименование перевозчика", "Готовность", "Тип кузова", "Паллетовместимость, шт",
    "Фактическая грузоподъемность, т", "Собственный", "Vip", "Приоритетные зоны доставки", "Скиллы",
    "Время погрузки ТС, с", "Время погрузки ТС, по", "Наименование точки старта",
    "Максимальное количество точек доставки",
  ];
  // ТК больше не участвует в выгрузке — только собственный транспорт
  const vehiclesRows = vehicles
    .filter((v) => v.carrier !== "ТК")
    .map((v) => {
      const skills = composeSkills(v.tons, v.gb);
      return [
        v.plate, "УмайГрупп", v.ready ? 1 : 0, "РЕФ", v.pallets || "",
        v.tons || "", 1, 1, "Бишкек_город", skills || "",
        v.from || "", v.to || "", v.start || "", v.maxPoints || "",
      ];
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
