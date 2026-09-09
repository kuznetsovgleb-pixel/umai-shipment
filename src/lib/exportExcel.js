import * as XLSX from "xlsx";
import { STORES, STORE_WINDOWS, POINT_UNLOAD_SEC } from "../data/reference";

const fmtDateRu = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

// скиллы для выгрузки: только тоннаж и ГБ (без Доверительная/Недоверительная)
const composeSkills = (tons, gb) => {
  const parts = [];
  if (tons) parts.push(`${tons}Т`);
  if (gb) parts.push("ГБ");
  return parts.join(";");
};

export function buildWorkbook(dateIso, consolidated, vehicles) {
  const dateLabel = fmtDateRu(dateIso);

  const ordersHeader = [
    "Номер заказа *", "Дата доставки*", "Наименование точки отгрузки*", "Наименование точки доставки*",
    "Кол-во ГМ", "Тип ГМ", "Вес (брутто), кг",
    "Время на разгрузку, сек (на единицу груза)", "Время на разгрузку, сек (на точку)",
    "Товарная группа",
  ];
  const ordersRows = consolidated.map((r) => [
    r.order, dateLabel, r.shipPoint, r.store,
    r.total, "Паллета", r.weight,
    r.unloadSec, POINT_UNLOAD_SEC,
    r.group || "",
  ]);

  const vehiclesHeader = [
    "ExtID", "Госномер", "Наименование перевозчика", "Готовность", "Тип кузова", "Паллетовместимость, шт",
    "Фактическая грузоподъемность, т", "Собственный", "Vip", "Приоритетные зоны доставки", "Скиллы",
    "Время погрузки ТС, с", "Время погрузки ТС, по", "Наименование точки старта",
    "Максимальное количество точек доставки",
  ];
  // ТК больше не участвует в выгрузке — только собственный транспорт
  const vehiclesRows = vehicles
    .filter((v) => v.carrier !== "ТК")
    .map((v) => {
      const extId = v.extId || v.plate;
      const skills = composeSkills(v.tons, v.gb);
      return [
        extId, v.plate, "УмайГрупп", v.ready ? 1 : 0, "РЕФ", v.pallets || "",
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
