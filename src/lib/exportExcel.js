import * as XLSX from "xlsx";
import { STORES, STORE_WINDOWS, POINT_UNLOAD_SEC } from "../data/reference";

const fmtDateRu = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

// для новых (вручную добавленных) ТС скиллы собираются автоматически:
// Доверительная;Недоверительная + тоннаж + ГБ, если проставлено «Есть»
const composeSkills = (tons, gb) => {
  const parts = ["Доверительная", "Недоверительная"];
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
    "Водитель (Фамилия)", "Водитель (Имя)", "Максимальное количество точек доставки",
  ];
  const vehiclesRows = vehicles.map((v) => {
    // собственный транспорт (не ТК) имеет приоритет над наёмным
    const isOwn = v.carrier !== "ТК";
    // у вручную добавленных ТС нет отдельного ExtID — дублируем госномер в оба поля
    const extId = v.extId || v.plate;
    // у вручную добавленных ТС скиллы собираются из тоннажа и ГБ, у остальных — как в справочнике
    const skills = v.custom ? composeSkills(v.tons, v.gb) : v.skills;
    return [
      extId, v.plate, v.carrier, v.ready ? 1 : 0, v.bodyType || "", v.pallets || "",
      v.tons || "", isOwn ? 1 : 0, isOwn ? 1 : 0, isOwn ? "Бишкек_город" : "Бишкек_пригород", skills || "",
      v.from || "", v.to || "", v.start || "", v.driverLastName || "", v.driverFirstName || "", v.maxPoints || "",
    ];
  });

  // список водителей собирается из фактического списка ТС на эту дату,
  // а не из статичного справочника — так туда попадают и новые водители
  const driversHeader = ["Наименование перевозчика", "Фамилия", "Имя"];
  const seenDrivers = new Set();
  const driversRows = [];
  vehicles.forEach((v) => {
    if (!v.driverLastName) return;
    const key = `${v.carrier}|${v.driverLastName}|${v.driverFirstName}`;
    if (seenDrivers.has(key)) return;
    seenDrivers.add(key);
    driversRows.push([v.carrier, v.driverLastName, v.driverFirstName || ""]);
  });

  const storesHeader = ["Код магазина", "Временное окно приемки (в будни)", "Время на разгрузку, сек (на точку)"];
  const storesRows = STORES.map((s) => [s, STORE_WINDOWS[s] || "", POINT_UNLOAD_SEC]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([ordersHeader, ...ordersRows]), "Orders");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([vehiclesHeader, ...vehiclesRows]), "Vehicles");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([driversHeader, ...driversRows]), "Drivers");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([storesHeader, ...storesRows]), "Магазины");
  return wb;
}

export function downloadWorkbook(dateIso, consolidated, vehicles) {
  const wb = buildWorkbook(dateIso, consolidated, vehicles);
  XLSX.writeFile(wb, `TMS_import_${dateIso}.xlsx`);
}
