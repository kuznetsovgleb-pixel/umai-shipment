import * as XLSX from "xlsx";

// Выгрузка для складов: из выгрузки маршрутов ТМС (лист «Маршруты (подробно)»)
// строится файл «Погрузка по точкам»: вкладка на каждую точку погрузки,
// 3 столбца — Рейс / Время погрузки / Магазины. Всё считается в браузере, в базу ничего не пишется.

const SHEET_NAME = "Маршруты (подробно)";
const COL = {
  route: "Маршрут",
  type: "Тип операции на точке",
  point: "Наименование точки",
  arrival: "Прибытие на точку, план",
  shops: "Магазины для погрузки",
};
// запасные индексы (как в выгрузке ТМС), если заголовок не найден по названию
const FALLBACK = { route: 1, type: 8, point: 9, shops: 33 };

const SHEET_RENAME = { "Кондитерское Центральное Производство": "Кондитерское производство" };
const FIRST_POINTS = ["Кулинарное производство", "Кондитерское Центральное Производство", "Глобус26 Медерова"];

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

// → { serial (дата+время как число дней Excel, для сортировки), minutes (минуты суток) } | null
function parseTime(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    const serial = v.getTime() / 86400000 + 25569 - v.getTimezoneOffset() / 1440;
    return { serial, minutes: v.getHours() * 60 + v.getMinutes() };
  }
  if (typeof v === "number") {
    const frac = v - Math.floor(v);
    return { serial: v, minutes: Math.round(frac * 1440) % 1440 };
  }
  const s = String(v);
  const m = s.match(/(\d{1,2})[:.](\d{2})(?::\d{2})?\s*$/);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  const d = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/) || null;
  let day = 0;
  if (d) day = Date.UTC(+d[3], +d[2] - 1, +d[1]) / 86400000 + 25569;
  else {
    const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) day = Date.UTC(+iso[1], +iso[2] - 1, +iso[3]) / 86400000 + 25569;
  }
  return { serial: day + minutes / 1440, minutes };
}

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// Разбор файла ТМС → { points: [{name, rows:[{route, time, shops}]}], dateIso }
export function parseTmsRoutes(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: false });
  const wsName = wb.SheetNames.find((n) => norm(n) === norm(SHEET_NAME));
  if (!wsName) throw new Error(`В файле нет листа «${SHEET_NAME}». Загрузите выгрузку маршрутов из ТМС.`);
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wsName], { header: 1, raw: true, defval: null });
  if (aoa.length < 2) throw new Error("Лист пуст");
  const head = aoa[0].map(norm);
  const find = (name, fb) => {
    const i = head.indexOf(norm(name));
    return i >= 0 ? i : fb;
  };
  const ix = {
    route: find(COL.route, FALLBACK.route),
    type: find(COL.type, FALLBACK.type),
    point: find(COL.point, FALLBACK.point),
    arrival: find(COL.arrival, -1),
    shops: find(COL.shops, FALLBACK.shops),
  };
  if (ix.arrival < 0) throw new Error(`Не найден столбец «${COL.arrival}»`);

  const byPoint = new Map();
  let firstSerial = null;
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row || norm(row[ix.type]) !== "погрузка") continue;
    const point = String(row[ix.point] ?? "").trim();
    const t = parseTime(row[ix.arrival]);
    const routeNo = parseInt(row[ix.route], 10);
    if (!point || !t || !Number.isFinite(routeNo)) continue;
    const shops = String(row[ix.shops] ?? "").split(";").map((s) => s.trim()).filter(Boolean);
    if (!byPoint.has(point)) byPoint.set(point, []);
    byPoint.get(point).push({ route: routeNo, serial: Math.floor(t.serial * 1440 + 1e-6) / 1440, minutes: t.minutes, shops });
    if (firstSerial == null || t.serial < firstSerial) firstSerial = t.serial;
  }
  if (byPoint.size === 0) throw new Error("В файле не найдено ни одной операции «Погрузка»");

  const names = [...FIRST_POINTS.filter((p) => byPoint.has(p)), ...[...byPoint.keys()].filter((p) => !FIRST_POINTS.includes(p))];
  const points = names.map((name) => ({
    name,
    rows: byPoint.get(name)
      .sort((a, b) => a.serial - b.serial || a.route - b.route)
      .map((x) => ({ route: x.route, time: hhmm(x.minutes), shops: x.shops.join(", ") })),
  }));

  // дата в названии файла: если погрузка начинается вечером — это отгрузка на следующий день
  let dateIso = null;
  if (firstSerial != null && firstSerial > 40000) {
    let day = Math.floor(firstSerial + 1e-9);
    const mins = Math.round((firstSerial - day) * 1440);
    if (mins >= 18 * 60) day += 1;
    const d = new Date(Math.round((day - 25569) * 86400000));
    dateIso = d.toISOString().slice(0, 10);
  }
  return { points, dateIso };
}

const safeSheetName = (name, used) => {
  let base = (SHEET_RENAME[name] || name).replace(/[\\/?*[\]:]/g, " ").slice(0, 31).trim() || "Точка";
  let n = base, i = 2;
  while (used.has(n.toLowerCase())) n = `${base.slice(0, 28)} ${i++}`;
  used.add(n.toLowerCase());
  return n;
};

export function buildWarehouseWorkbook(points) {
  const wb = XLSX.utils.book_new();
  const used = new Set();
  for (const p of points) {
    const aoa = [["Рейс", "Время погрузки", "Магазины"], ...p.rows.map((r) => [`Рейс ${r.route}`, r.time, r.shops])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 10 }, { wch: 16 }, { wch: 110 }];
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(p.name, used));
  }
  return wb;
}

export function warehouseFileName(dateIso) {
  if (!dateIso) return "Погрузка по точкам.xlsx";
  const [y, m, d] = dateIso.split("-");
  return `Погрузка по точкам ${d}.${m}.${y}.xlsx`;
}

export function downloadWarehouseWorkbook(points, dateIso) {
  XLSX.writeFile(buildWarehouseWorkbook(points), warehouseFileName(dateIso));
}
