import * as XLSX from "xlsx";
import {
  STORES,
  STORE_WINDOWS,
  DRIVERS_REF,
  PALLET_UNLOAD_SEC,
  POINT_UNLOAD_SEC,
} from "../data/reference";

const fmtDateRu = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

export function buildWorkbook(dateIso, consolidated, vehicles) {
  const dateLabel = fmtDateRu(dateIso);

  const ordersHeader = [
    "Номер заказа *", "Дата доставки*", "Наименование точки отгрузки*", "Наименование точки доставки*",
    "Кол-во ГМ", "Тип ГМ", "Окно приемки 1, с*", "Окно приемки 1, по*",
    "Время на разгрузку, сек (на единицу груза)", "Время на разгрузку, сек (на точку)",
  ];
  const ordersRows = consolidated.map((r) => {
    const win = STORE_WINDOWS[r.store] || "";
    const [from, to] = win ? win.split("-") : ["", ""];
    return [
      r.order, dateLabel, r.shipPoint, r.store,
      r.total, "Паллета", from, to,
      PALLET_UNLOAD_SEC, POINT_UNLOAD_SEC,
    ];
  });

  const vehiclesHeader = [
    "ExtID", "Госномер", "Наименование перевозчика", "Готовность", "Тип кузова", "Паллетовместимость, шт",
    "Фактическая грузоподъемность, т", "Собственный", "Vip", "Скиллы",
    "Время погрузки ТС, с", "Время погрузки ТС, по", "Наименование точки старта",
    "Водитель (Фамилия)", "Водитель (Имя)",
  ];
  const vehiclesRows = vehicles.map((v) => [
    v.extId || "", v.plate, v.carrier, v.ready ? 1 : 0, v.bodyType || "", v.pallets || "",
    v.tons || "", v.custom ? 0 : 1, v.custom ? 0 : 1, v.skills || "",
    v.from || "", v.to || "", v.start || "", v.driverLastName || "", v.driverFirstName || "",
  ]);

  const driversHeader = ["Наименование перевозчика", "Фамилия", "Имя"];
  const driversRows = DRIVERS_REF.map((d) => [d.carrier, d.lastName, d.firstName]);

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
