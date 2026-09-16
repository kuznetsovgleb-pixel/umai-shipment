import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  Plus, Trash2, Send, Download, Truck, CheckCircle2, Circle, AlertTriangle,
  Lock, Pencil, Check, Loader2, Wifi, Users, Moon,
} from "lucide-react";
import { WAREHOUSES, STORES, COEFFICIENT, PALLET_UNLOAD_SEC, POINT_UNLOAD_SEC } from "../data/reference";
import {
  subscribeToDay, makeEmptyRow, emptyDay, seedVehiclesForDay, saveWarehouseRows, setSubmitted, saveVehicles,
  subscribeToZhashylchaDay, setZhashylchaSubmitted, saveZhashylchaRows, saveZhashylchaVehicles, seedZhashylchaVehicles,
} from "../lib/dayStore";
import { downloadWorkbook, downloadZhashylchaWorkbook } from "../lib/exportExcel";

const ACCENT = {
  emerald: { text: "text-emerald-700", bg: "bg-emerald-600", dot: "bg-emerald-500" },
  orange: { text: "text-orange-700", bg: "bg-orange-600", dot: "bg-orange-500" },
  indigo: { text: "text-indigo-700", bg: "bg-indigo-600", dot: "bg-indigo-500" },
  sky: { text: "text-sky-700", bg: "bg-sky-600", dot: "bg-sky-500" },
  rose: { text: "text-rose-700", bg: "bg-rose-600", dot: "bg-rose-500" },
  amber: { text: "text-amber-700", bg: "bg-amber-600", dot: "bg-amber-500" },
  violet: { text: "text-violet-700", bg: "bg-violet-600", dot: "bg-violet-500" },
  cyan: { text: "text-cyan-700", bg: "bg-cyan-600", dot: "bg-cyan-500" },
  teal: { text: "text-teal-700", bg: "bg-teal-600", dot: "bg-teal-500" },
  lime: { text: "text-lime-700", bg: "bg-lime-600", dot: "bg-lime-500" },
};

const todayISO = () => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
};

const fmtDateRu = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

const sanitizeQty = (raw) => {
  if (raw === "") return "";
  const digitsOnly = raw.replace(/[^\d]/g, "");
  if (digitsOnly !== "") return String(parseInt(digitsOnly, 10));
  const num = parseFloat(raw.replace(",", "."));
  if (!isNaN(num)) return String(Math.ceil(num));
  return "";
};

// вес — допускаем дробные значения (весы могут показывать граммы)
const sanitizeWeight = (raw) => {
  if (raw === "") return "";
  let v = raw.replace(",", ".").replace(/[^\d.]/g, "");
  const parts = v.split(".");
  if (parts.length > 2) v = parts[0] + "." + parts.slice(1).join("");
  return v;
};

// паллеты с шагом 0.5 (только для Жашылча — евро/американцы могут быть дробными)
const sanitizeHalfStep = (raw) => {
  if (raw === "") return "";
  const num = parseFloat(raw.replace(",", "."));
  if (isNaN(num) || num < 0) return "";
  return String(Math.round(num * 2) / 2);
};

// коэффициенты веса для складов без ручного ввода (кг за паллето-эквивалент)
const PALLET_KG = 300;
const ROLL_KG = 250;

// пересчёт американских паллет в обычные (евро) для Садыгалиева-сыпучка
const EURO_AMERICAN_COEF = 1.2;

// коробки → паллето-эквивалент: до 20 шт — 0.5 паллеты, от 20 до 40 — целая паллета,
// дальше по той же логике (каждые следующие 20 коробок = ещё +0.5 паллеты)
const boxesToPallets = (boxes) => (boxes > 0 ? Math.ceil(boxes / 20) * 0.5 : 0);

const rowIssues = (r, requiresWeight = false, qtyMode = "default", requiresCategory = false) => {
  const qtyFilled =
    qtyMode === "euroAmerican" ? (r.euro !== "" || r.american !== "") :
    qtyMode === "euroAmericanBoxes" ? (r.euro !== "" || r.american !== "" || r.boxes !== "") :
    qtyMode === "palletsBoxes" ? (r.pallets !== "" || r.boxes !== "") :
    qtyMode === "palletsAmericanBoxes" ? (r.pallets !== "" || r.american !== "" || r.boxes !== "") :
    (r.pallets !== "" || r.rolls !== "");
  const hasData = Boolean(r.order.trim() || r.store || qtyFilled || (r.weight && r.weight !== "") || r.category);
  if (!hasData) {
    return { hasData: false, missingOrder: false, missingStore: false, missingQty: false, missingWeight: false, missingCategory: false, incomplete: false };
  }
  const missingOrder = !r.order.trim();
  const missingStore = !r.store;
  const missingQty = !qtyFilled;
  const missingWeight = requiresWeight && (!r.weight || r.weight === "");
  const missingCategory = requiresCategory && !r.category;
  return {
    hasData: true, missingOrder, missingStore, missingQty, missingWeight, missingCategory,
    incomplete: missingOrder || missingStore || missingQty || missingWeight || missingCategory,
  };
};

// товарные категории — для складов, где категория выбирается по каждому заказу отдельно
const CATEGORY_OPTIONS = ["Сухой", "Оборудование", "Сыпучка", "Заморозка", "СП", "Охлажденка"];

// магазины, которые встречаются в списке склада больше одного раза —
// на один магазин может быть только один заказ
const findDuplicateStores = (rows) => {
  const counts = {};
  rows.forEach((r) => {
    const key = r.store.trim().toLowerCase();
    if (!key) return;
    counts[key] = (counts[key] || 0) + 1;
  });
  return new Set(Object.keys(counts).filter((k) => counts[k] > 1));
};

const TABS = ["prigorodnoe", "argo", "pto", "sagadalieva", "sagadalieva_zamorozka", "hlebzavod", "kkcp", "transit_yug", "transit_sever", "zhashylcha", "otl"];

// список времени погрузки для выбора у ТС
const LOAD_TIME_OPTIONS = Array.from({ length: 11 }, (_, i) => `${String(8 + i).padStart(2, "0")}:00`);

// точки старта для собственных ТС (у ТК точки старта нет — поле неактивно)
const START_POINT_OPTIONS = ["Центральный офис", "РЦ Пригородное", "РЦ Ак-Орго", "РЦ Жашылча", "РЦ Садыгалиева - сыпучка", "РЦ Садыгалиева - заморозка", "РЦ РМ и ПТО", "РЦ Транзит Юг", "РЦ Транзит Север"];

// перевозчик — теперь фиксированный список, а не свободный текст
// ТК больше не используется — весь транспорт свой

// товарная группа для выгрузки — по складу
const GROUP_BY_WAREHOUSE = {
  prigorodnoe: "Сухой",
  argo: "Сухой",
  pto: "Оборудование",
  sagadalieva: "Сыпучка",
  sagadalieva_zamorozka: "Заморозка",
  hlebzavod: "СП",
  kkcp: "СП",
};

export default function ShipmentApp() {
  const [date, setDate] = useState(todayISO());
  const [day, setDay] = useState(emptyDay());
  const [loadingDay, setLoadingDay] = useState(true);
  const [toast, setToast] = useState(null);
  const [activeTab, setActiveTab] = useState("prigorodnoe");
  const [zhSubmitted, setZhSubmitted] = useState(false);

  // лёгкая отдельная подписка только на статус Жашылчи (для строки статусов
  // на вкладке «Для ОТЛ») — сами заказы сюда не подтягиваются, контур отдельный
  useEffect(() => {
    const unsub = subscribeToZhashylchaDay(
      todayISO(),
      (data) => setZhSubmitted(Boolean(data.submitted)),
      () => {}
    );
    return unsub;
  }, []);

  // подписка в реальном времени — если склад или ОТЛ поменяли что-то,
  // все остальные видят это без перезагрузки
  useEffect(() => {
    setLoadingDay(true);
    const unsub = subscribeToDay(
      date,
      (data) => {
        // самовосстановление: если список машин пуст (например, поле
        // случайно удалили в консоли Firestore) — подставляем свежий
        // список из справочника и сразу сохраняем его обратно
        if (!data.vehicles || data.vehicles.length === 0) {
          const seeded = seedVehiclesForDay();
          setDay({ ...data, vehicles: seeded });
          saveVehicles(date, seeded).catch(() => {});
        } else {
          setDay(data);
        }
        setLoadingDay(false);
      },
      () => setLoadingDay(false)
    );
    return unsub;
  }, [date]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  };

  const duplicateOrders = useMemo(() => {
    const counts = {};
    WAREHOUSES.forEach((w) => {
      (day[`rows_${w.id}`] || []).forEach((r) => {
        const key = r.order.trim().toLowerCase();
        if (!key) return;
        counts[key] = (counts[key] || 0) + 1;
      });
    });
    return new Set(Object.keys(counts).filter((k) => counts[k] > 1));
  }, [day]);

  // ---- склад: строки заказов (debounce перед записью в Firestore) ----
  // отдельный таймер на каждую цель сохранения (по складу + отдельно для машин) —
  // иначе быстрое редактирование одного места отменяет ещё не сработавшее
  // сохранение другого места, и данные тихо теряются
  const saveTimers = useRef({});
  const patchWarehouseRows = useCallback(
    (whId, updater) => {
      setDay((current) => {
        const nextRows = updater(current[`rows_${whId}`] || []);
        const next = { ...current, [`rows_${whId}`]: nextRows };
        const key = `rows_${whId}`;
        if (saveTimers.current[key]) clearTimeout(saveTimers.current[key]);
        saveTimers.current[key] = setTimeout(() => {
          saveWarehouseRows(date, whId, nextRows).catch(() => showToast("Не удалось сохранить — проверьте связь"));
        }, 500);
        return next;
      });
    },
    [date]
  );

  const updateRow = (whId, rowId, field, value) => {
    patchWarehouseRows(whId, (rows) =>
      rows.map((r) => {
        if (r.id !== rowId) return r;
        let v = value;
        if (field === "pallets" || field === "rolls" || field === "euro" || field === "american" || field === "boxes") v = sanitizeQty(value);
        if (field === "weight") v = sanitizeWeight(value);
        return { ...r, [field]: v };
      })
    );
  };
  const pasteQty = (whId, rowId, field, raw) => updateRow(whId, rowId, field, sanitizeQty(raw));
  const addRow = (whId) => patchWarehouseRows(whId, (rows) => [...rows, makeEmptyRow()]);
  const removeRow = (whId, rowId) =>
    patchWarehouseRows(whId, (rows) => (rows.length > 1 ? rows.filter((r) => r.id !== rowId) : rows));

  const submitWarehouse = async (whId) => {
    const wh = WAREHOUSES.find((w) => w.id === whId);
    const qtyMode = wh.qtyMode || "default";
    const rows = (day[`rows_${whId}`] || []).filter((r) => rowIssues(r, wh.requiresWeight, qtyMode, wh.perOrderCategory).hasData);
    if (rows.length === 0) return showToast("Нет заполненных строк для отправки");
    const incompleteCount = rows.filter((r) => rowIssues(r, wh.requiresWeight, qtyMode, wh.perOrderCategory).incomplete).length;
    if (incompleteCount > 0) {
      return showToast(
        incompleteCount === 1
          ? "Одна строка заполнена не полностью — проверьте подсвеченные поля"
          : `${incompleteCount} строк заполнены не полностью — проверьте подсвеченные поля`
      );
    }
    const hasDupe = rows.some((r) => duplicateOrders.has(r.order.trim().toLowerCase()));
    if (hasDupe) return showToast("Есть повторяющиеся номера заказов — исправьте перед отправкой");

    const dupStores = findDuplicateStores(rows);
    const hasDupeStore = rows.some((r) => dupStores.has(r.store.trim().toLowerCase()));
    if (hasDupeStore) return showToast("На один магазин может быть только один заказ — исправьте повторяющиеся магазины");

    try {
      await setSubmitted(date, whId, true);
      showToast(`${wh.name}: данные отправлены в транспортный отдел`);
    } catch {
      showToast("Не удалось отправить — проверьте связь и попробуйте снова");
    }
  };
  const unlockWarehouse = (whId) => setSubmitted(date, whId, false).catch(() => showToast("Не удалось изменить статус"));

  // ---- ОТЛ: транспорт ----
  const patchVehicles = useCallback(
    (updater) => {
      setDay((current) => {
        const next = { ...current, vehicles: updater(current.vehicles || []) };
        const key = "vehicles";
        if (saveTimers.current[key]) clearTimeout(saveTimers.current[key]);
        saveTimers.current[key] = setTimeout(() => {
          saveVehicles(date, next.vehicles).catch(() => showToast("Не удалось сохранить — проверьте связь"));
        }, 500);
        return next;
      });
    },
    [date]
  );
  const addVehicle = () =>
    patchVehicles((vs) => [
      ...vs,
      { id: Math.random().toString(36).slice(2, 10), extId: "", plate: "", carrier: "УмайГрупп", driverLastName: "", driverFirstName: "", pallets: "", tons: "", skills: "", from: "08:00", to: "19:00", start: "", bodyType: "РЕФ", gb: false, maxPoints: "", custom: true, ready: false },
    ]);
  const updateVehicle = (id, field, value) => patchVehicles((vs) => vs.map((v) => (v.id === id ? { ...v, [field]: value } : v)));
  const removeVehicle = (id) => patchVehicles((vs) => vs.filter((v) => v.id !== id));

  const consolidated = useMemo(() => {
    const rows = [];
    WAREHOUSES.forEach((w) => {
      if (!day[`submitted_${w.id}`]) return;
      const qtyMode = w.qtyMode || "default";
      (day[`rows_${w.id}`] || []).forEach((r) => {
        if (!r.order.trim()) return;
        const weight = w.requiresWeight ? parseFloat(r.weight) || 0 : null;

        let pallets = null, rolls = null, euro = null, american = null, boxes = null, total;

        if (qtyMode === "euroAmerican") {
          euro = parseInt(r.euro, 10) || 0;
          american = parseInt(r.american, 10) || 0;
          total = Math.ceil((euro + american * EURO_AMERICAN_COEF) * 100) / 100;
        } else if (qtyMode === "palletsBoxes") {
          pallets = parseInt(r.pallets, 10) || 0;
          boxes = parseInt(r.boxes, 10) || 0;
          total = Math.ceil((pallets + boxesToPallets(boxes)) * 100) / 100;
        } else if (qtyMode === "palletsAmericanBoxes") {
          pallets = parseInt(r.pallets, 10) || 0;
          american = parseInt(r.american, 10) || 0;
          boxes = parseInt(r.boxes, 10) || 0;
          total = Math.ceil((pallets + american * EURO_AMERICAN_COEF + boxesToPallets(boxes)) * 100) / 100;
        } else {
          pallets = parseInt(r.pallets, 10) || 0;
          rolls = parseInt(r.rolls, 10) || 0;
          total = Math.ceil((pallets + rolls * COEFFICIENT) * 100) / 100;
        }

        const fallbackWeight = (qtyMode === "palletsBoxes" || qtyMode === "palletsAmericanBoxes") ? total * PALLET_KG : (pallets || 0) * PALLET_KG + (rolls || 0) * ROLL_KG;
        const unloadSec = w.unloadPerPalletSec || PALLET_UNLOAD_SEC;

        rows.push({
          id: r.id, warehouse: w.name, shipPoint: w.shipPoint, accent: w.accent,
          order: r.order.trim(), store: r.store || "—",
          pallets, rolls, euro, american, boxes,
          weight: weight === null ? Math.round(fallbackWeight * 100) / 100 : Math.round(weight * 100) / 100,
          total,
          unloadSec,
          group: w.perOrderCategory ? (r.category || "") : (GROUP_BY_WAREHOUSE[w.id] || ""),
        });
      });
    });
    return rows;
  }, [day]);

  const exportExcel = () => {
    if (consolidated.length === 0) return showToast("Нет данных для выгрузки — дождитесь отправки со складов");
    const readyCount = (day.vehicles || []).filter((v) => v.ready && v.carrier !== "ТК").length;
    if (readyCount === 0) return showToast("Сначала проставьте готовность хотя бы одного ТС на вкладке «Транспорт»");
    downloadWorkbook(date, consolidated, day.vehicles);
    showToast("Файл сформирован и скачан");
  };

  const tabLabel = (id) => (id === "otl" ? "Для ОТЛ" : WAREHOUSES.find((w) => w.id === id)?.name);

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 font-sans">
      <div className="border-b border-stone-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-xs uppercase tracking-widest text-stone-400 font-semibold">Умай Групп · РЦ</div>
            <h1 className="text-xl font-bold tracking-tight text-stone-900">Ежедневная отгрузка</h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-stone-400">
              <Wifi size={13} className="text-emerald-500" /> Синхронизировано
            </div>
            <label className="flex items-center gap-2 bg-stone-50 border border-stone-300 rounded-lg px-3 py-2">
              <span className="text-xs font-medium text-stone-500 uppercase tracking-wide">Дата</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="bg-transparent text-sm font-mono font-semibold text-stone-900 outline-none" />
            </label>
          </div>
        </div>
      </div>
      <div className="bg-amber-50 border-b border-amber-200">
        <div className="max-w-6xl mx-auto px-6 py-1.5 flex items-center gap-2 text-xs text-amber-800">
          <Users size={12} />
          Открытая ссылка: без входа, данные видит и может менять любой, у кого она есть.
        </div>
      </div>

      <div className="border-b border-stone-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 flex items-end gap-1 flex-wrap">
          {TABS.map((id) => {
            const isOtl = id === "otl";
            const isZh = id === "zhashylcha";
            const w = !isOtl && !isZh ? WAREHOUSES.find((x) => x.id === id) : null;
            const a = w ? ACCENT[w.accent] : isZh ? ACCENT.cyan : null;
            const active = activeTab === id;
            const sub = !isOtl && !isZh && day[`submitted_${id}`];
            return (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`relative flex items-center gap-2 px-4 py-3 text-sm font-semibold rounded-t-lg transition-colors ${
                  active ? "bg-stone-50 text-stone-900" : "text-stone-500 hover:text-stone-700"
                }`}
              >
                {isOtl ? <Truck size={14} /> : isZh ? <Moon size={14} /> : <span className={`h-1.5 w-1.5 rounded-full ${sub ? a.dot : "bg-stone-300"}`} />}
                {isZh ? ZH_DISPLAY_NAME : tabLabel(id)}
                {sub && <Lock size={12} className="text-stone-400" />}
                {active && <span className={`absolute left-0 right-0 -bottom-px h-0.5 ${isOtl ? "bg-stone-800" : a.bg}`} />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6">
        {activeTab === "zhashylcha" ? (
          <ZhashylchaPanel date={date} />
        ) : loadingDay ? (
          <div className="flex items-center justify-center gap-2 text-sm text-stone-400 py-24">
            <Loader2 size={16} className="animate-spin" /> Загрузка данных за {fmtDateRu(date)}…
          </div>
        ) : activeTab !== "otl" ? (
          <WarehousePanel
            wh={WAREHOUSES.find((w) => w.id === activeTab)}
            rows={day[`rows_${activeTab}`] || []}
            submitted={day[`submitted_${activeTab}`]}
            duplicateOrders={duplicateOrders}
            onUpdate={(rowId, field, value) => updateRow(activeTab, rowId, field, value)}
            onPasteQty={(rowId, field, raw) => pasteQty(activeTab, rowId, field, raw)}
            onAdd={() => addRow(activeTab)}
            onRemove={(rowId) => removeRow(activeTab, rowId)}
            onSubmit={() => submitWarehouse(activeTab)}
            onUnlock={() => unlockWarehouse(activeTab)}
            dateLabel={fmtDateRu(date)}
          />
        ) : (
          <OtlPanel
            day={day}
            consolidated={consolidated}
            onAddVehicle={addVehicle}
            onUpdateVehicle={updateVehicle}
            onRemoveVehicle={removeVehicle}
            onExport={exportExcel}
            dateLabel={fmtDateRu(date)}
            zhSubmitted={zhSubmitted}
          />
        )}
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-stone-900 text-white text-sm font-medium px-4 py-3 rounded-lg shadow-lg flex items-center gap-2">
          <AlertTriangle size={14} className="text-amber-400" /> {toast}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Вкладка склада
// ---------------------------------------------------------------------------

function WarehousePanel({ wh, rows, submitted, duplicateOrders, onUpdate, onPasteQty, onAdd, onRemove, onSubmit, onUnlock, dateLabel }) {
  const a = ACCENT[wh.accent];
  const requiresWeight = Boolean(wh.requiresWeight);
  const requiresCategory = Boolean(wh.perOrderCategory);
  const qtyMode = wh.qtyMode || "default";
  const duplicateStores = useMemo(() => findDuplicateStores(rows), [rows]);

  const qtyDescription =
    qtyMode === "euroAmerican" ? "количество евро- и американских паллет" :
    qtyMode === "palletsBoxes" ? "количество паллет и коробок" :
    qtyMode === "palletsAmericanBoxes" ? "количество паллет, американцев и коробок" :
    "количество паллет и роллкейджей";

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className={`inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide ${a.text} mb-1`}>
            <span className={`h-2 w-2 rounded-full ${a.dot}`} /> Склад · {wh.name}
          </div>
          <p className="text-sm text-stone-500">
            Заказ №, {qtyDescription}{requiresWeight ? ", вес" : ""}{requiresCategory ? ", товарная категория" : ""} на {dateLabel}. Магазин выбирается из списка.
            {(qtyMode === "palletsBoxes" || qtyMode === "palletsAmericanBoxes") && " Коробки пересчитываются в паллеты автоматически (до 20 шт — 0,5 паллеты, 20–40 — целая паллета и так далее)."}
            {qtyMode === "palletsAmericanBoxes" && " Вес считается автоматически, вручную вводить не нужно."}
          </p>
        </div>
      </div>

      {submitted && (
        <div className="mb-4 flex items-center justify-between gap-3 bg-stone-100 border border-stone-300 rounded-lg px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-stone-700">
            <Lock size={15} className="text-stone-500" /> Данные за {dateLabel} отправлены в транспортный отдел. Редактирование заблокировано.
          </div>
          <button onClick={onUnlock} className="text-xs font-semibold text-stone-600 underline underline-offset-2 hover:text-stone-900 whitespace-nowrap">
            Вернуть на редактирование
          </button>
        </div>
      )}
            <div className="bg-white border border-stone-200 rounded-xl overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-stone-50 text-stone-500 text-xs uppercase tracking-wide">
              <th className="text-left font-semibold px-4 py-3 w-10">#</th>
              <th className="text-left font-semibold px-4 py-3 w-40">Заказ №</th>
              <th className="text-left font-semibold px-4 py-3">Магазин</th>
              {qtyMode === "euroAmerican" && (
                <>
                  <th className="text-left font-semibold px-4 py-3 w-32">Евро</th>
                  <th className="text-left font-semibold px-4 py-3 w-32">Американцы</th>
                </>
              )}
              {qtyMode === "palletsBoxes" && (
                <>
                  <th className="text-left font-semibold px-4 py-3 w-32">Паллеты</th>
                  <th className="text-left font-semibold px-4 py-3 w-32">Коробки</th>
                </>
              )}
              {qtyMode === "palletsAmericanBoxes" && (
                <>
                  <th className="text-left font-semibold px-4 py-3 w-28">Паллеты</th>
                  <th className="text-left font-semibold px-4 py-3 w-28">Американцы</th>
                  <th className="text-left font-semibold px-4 py-3 w-28">Коробки</th>
                </>
              )}
              {qtyMode === "default" && (
                <>
                  <th className="text-left font-semibold px-4 py-3 w-32">Паллеты</th>
                  <th className="text-left font-semibold px-4 py-3 w-32">Роллы</th>
                </>
              )}
              {requiresWeight && <th className="text-left font-semibold px-4 py-3 w-32">Вес, кг</th>}
              {requiresCategory && <th className="text-left font-semibold px-4 py-3 w-40">Товарная категория</th>}
              <th className="px-4 py-3 w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isDupe = r.order.trim() && duplicateOrders.has(r.order.trim().toLowerCase());
              const isDupeStore = r.store && duplicateStores.has(r.store.trim().toLowerCase());
              const issues = rowIssues(r, requiresWeight, qtyMode, requiresCategory);
              const errBorder = "border-rose-400 bg-rose-50 focus:ring-2 focus:ring-rose-400";
              const okBorder = "border-stone-300 focus:ring-2 focus:ring-stone-400";
              return (
                <tr key={r.id} className="border-t border-stone-100 align-top">
                  <td className="px-4 py-2 text-stone-400 font-mono text-xs pt-2.5">{i + 1}</td>
                  <td className="px-4 py-2">
                    <input
                      type="text" disabled={submitted} value={r.order}
                      onChange={(e) => onUpdate(r.id, "order", e.target.value)}
                      placeholder="напр. 100234"
                      className={`w-full font-mono text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 ${isDupe || issues.missingOrder ? errBorder : okBorder}`}
                    />
                    {isDupe && <div className="text-xs text-rose-600 mt-1">Номер дублируется</div>}
                    {!isDupe && issues.missingOrder && <div className="text-xs text-rose-600 mt-1">Укажите номер заказа</div>}
                  </td>
                  <td className="px-4 py-2">
                    <select
                      disabled={submitted} value={r.store}
                      onChange={(e) => onUpdate(r.id, "store", e.target.value)}
                      className={`w-full text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 bg-white ${issues.missingStore || isDupeStore ? errBorder : okBorder}`}
                    >
                      <option value="">— выбрать магазин —</option>
                      {STORES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                    {issues.missingStore && <div className="text-xs text-rose-600 mt-1">Выберите магазин</div>}
                    {!issues.missingStore && isDupeStore && <div className="text-xs text-rose-600 mt-1">На этот магазин уже есть заказ в списке — проверьте дубли</div>}
                  </td>
                  {qtyMode === "euroAmerican" && (
                    <>
                      <td className="px-4 py-2">
                        <input
                          type="text" inputMode="numeric" disabled={submitted} value={r.euro}
                          onChange={(e) => onUpdate(r.id, "euro", e.target.value)}
                          onPaste={(e) => { e.preventDefault(); onPasteQty(r.id, "euro", e.clipboardData.getData("text")); }}
                          placeholder="0"
                          className={`w-full font-mono text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 ${issues.missingQty ? errBorder : okBorder}`}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="text" inputMode="numeric" disabled={submitted} value={r.american}
                          onChange={(e) => onUpdate(r.id, "american", e.target.value)}
                          onPaste={(e) => { e.preventDefault(); onPasteQty(r.id, "american", e.clipboardData.getData("text")); }}
                          placeholder="0"
                          className={`w-full font-mono text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 ${issues.missingQty ? errBorder : okBorder}`}
                        />
                        {issues.missingQty && <div className="text-xs text-rose-600 mt-1">Укажите евро или американец</div>}
                      </td>
                    </>
                  )}
                  {qtyMode === "palletsBoxes" && (
                    <>
                      <td className="px-4 py-2">
                        <input
                          type="text" inputMode="numeric" disabled={submitted} value={r.pallets}
                          onChange={(e) => onUpdate(r.id, "pallets", e.target.value)}
                          onPaste={(e) => { e.preventDefault(); onPasteQty(r.id, "pallets", e.clipboardData.getData("text")); }}
                          placeholder="0"
                          className={`w-full font-mono text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 ${issues.missingQty ? errBorder : okBorder}`}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="text" inputMode="numeric" disabled={submitted} value={r.boxes}
                          onChange={(e) => onUpdate(r.id, "boxes", e.target.value)}
                          onPaste={(e) => { e.preventDefault(); onPasteQty(r.id, "boxes", e.clipboardData.getData("text")); }}
                          placeholder="0"
                          className={`w-full font-mono text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 ${issues.missingQty ? errBorder : okBorder}`}
                        />
                        {issues.missingQty && <div className="text-xs text-rose-600 mt-1">Укажите паллеты или коробки</div>}
                      </td>
                    </>
                  )}
                  {qtyMode === "palletsAmericanBoxes" && (
                    <>
                      <td className="px-4 py-2">
                        <input
                          type="text" inputMode="numeric" disabled={submitted} value={r.pallets}
                          onChange={(e) => onUpdate(r.id, "pallets", e.target.value)}
                          onPaste={(e) => { e.preventDefault(); onPasteQty(r.id, "pallets", e.clipboardData.getData("text")); }}
                          placeholder="0"
                          className={`w-full font-mono text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 ${issues.missingQty ? errBorder : okBorder}`}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="text" inputMode="numeric" disabled={submitted} value={r.american}
                          onChange={(e) => onUpdate(r.id, "american", e.target.value)}
                          onPaste={(e) => { e.preventDefault(); onPasteQty(r.id, "american", e.clipboardData.getData("text")); }}
                          placeholder="0"
                          className={`w-full font-mono text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 ${issues.missingQty ? errBorder : okBorder}`}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="text" inputMode="numeric" disabled={submitted} value={r.boxes}
                          onChange={(e) => onUpdate(r.id, "boxes", e.target.value)}
                          onPaste={(e) => { e.preventDefault(); onPasteQty(r.id, "boxes", e.clipboardData.getData("text")); }}
                          placeholder="0"
                          className={`w-full font-mono text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 ${issues.missingQty ? errBorder : okBorder}`}
                        />
                        {issues.missingQty && <div className="text-xs text-rose-600 mt-1">Укажите паллеты, американцев или коробки</div>}
                      </td>
                    </>
                  )}
                  {qtyMode === "default" && (
                    <>
                      <td className="px-4 py-2">
                        <input
                          type="text" inputMode="numeric" disabled={submitted} value={r.pallets}
                          onChange={(e) => onUpdate(r.id, "pallets", e.target.value)}
                          onPaste={(e) => { e.preventDefault(); onPasteQty(r.id, "pallets", e.clipboardData.getData("text")); }}
                          placeholder="0"
                          className={`w-full font-mono text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 ${issues.missingQty ? errBorder : okBorder}`}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="text" inputMode="numeric" disabled={submitted} value={r.rolls}
                          onChange={(e) => onUpdate(r.id, "rolls", e.target.value)}
                          onPaste={(e) => { e.preventDefault(); onPasteQty(r.id, "rolls", e.clipboardData.getData("text")); }}
                          placeholder="0"
                          className={`w-full font-mono text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 ${issues.missingQty ? errBorder : okBorder}`}
                        />
                        {issues.missingQty && <div className="text-xs text-rose-600 mt-1">Укажите паллеты или роллы</div>}
                      </td>
                    </>
                  )}
                  {requiresWeight && (
                    <td className="px-4 py-2">
                      <input
                        type="text" inputMode="decimal" disabled={submitted} value={r.weight}
                        onChange={(e) => onUpdate(r.id, "weight", e.target.value)}
                        placeholder="0"
                        className={`w-full font-mono text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 ${issues.missingWeight ? errBorder : okBorder}`}
                      />
                      {issues.missingWeight && <div className="text-xs text-rose-600 mt-1">Укажите вес</div>}
                    </td>
                  )}
                  {requiresCategory && (
                    <td className="px-4 py-2">
                      <select
                        disabled={submitted} value={r.category}
                        onChange={(e) => onUpdate(r.id, "category", e.target.value)}
                        className={`w-full text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 bg-white ${issues.missingCategory ? errBorder : okBorder}`}
                      >
                        <option value="">— выбрать категорию —</option>
                        {CATEGORY_OPTIONS.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                      {issues.missingCategory && <div className="text-xs text-rose-600 mt-1">Укажите категорию</div>}
                    </td>
                  )}
                  <td className="px-4 py-2 text-center">
                    {!submitted && (
                      <button onClick={() => onRemove(r.id)} className="text-stone-300 hover:text-rose-500 transition-colors">
                        <Trash2 size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!submitted && (
          <button onClick={onAdd} className="w-full flex items-center justify-center gap-2 text-sm font-semibold text-stone-500 hover:text-stone-800 hover:bg-stone-50 py-3 border-t border-stone-100 transition-colors">
            <Plus size={15} /> Добавить заказ
          </button>
        )}
      </div>

      {!submitted && (
        <div className="flex justify-end mt-4">
          <button onClick={onSubmit} className={`flex items-center gap-2 ${a.bg} text-white text-sm font-semibold px-5 py-2.5 rounded-lg hover:opacity-90 transition-opacity shadow-sm`}>
            <Send size={15} /> Отправить в транспортный отдел
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Вкладка ОТЛ
// ---------------------------------------------------------------------------

function OtlPanel({ day, consolidated, onAddVehicle, onUpdateVehicle, onRemoveVehicle, onExport, dateLabel, zhSubmitted }) {
  const totalPallets = consolidated.reduce((s, r) => s + r.total, 0);
  const totalWeight = consolidated.reduce((s, r) => s + r.weight, 0);
  const [editingCapacity, setEditingCapacity] = useState({});
  const toggleEditCapacity = (id) => setEditingCapacity((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className="space-y-8">
      <div className="bg-white border border-stone-200 rounded-xl px-4 py-3 flex items-center gap-6 flex-wrap">
        <span className="text-xs font-bold uppercase tracking-wide text-stone-400">Статус складов</span>
        {WAREHOUSES.map((w) => {
          const sub = day[`submitted_${w.id}`];
          const a = ACCENT[w.accent];
          return (
            <div key={w.id} className="flex items-center gap-1.5 text-sm font-medium">
              {sub ? <CheckCircle2 size={15} className={a.text} /> : <Circle size={15} className="text-stone-300" />}
              <span className={sub ? "text-stone-900" : "text-stone-400"}>{w.name}</span>
              <span className={`text-xs ${sub ? a.text : "text-stone-400"}`}>{sub ? "отправлено" : "ожидание"}</span>
            </div>
          );
        })}
        <div className="flex items-center gap-1.5 text-sm font-medium border-l border-stone-200 pl-6">
          {zhSubmitted ? <CheckCircle2 size={15} className="text-cyan-700" /> : <Circle size={15} className="text-stone-300" />}
          <span className={zhSubmitted ? "text-stone-900" : "text-stone-400"}>РЦ Жашылча - молочка (ночь)</span>
          <span className={`text-xs ${zhSubmitted ? "text-cyan-700" : "text-stone-400"}`}>{zhSubmitted ? "отправлено" : "ожидание"}</span>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">
              Консолидировано на {dateLabel} · {consolidated.length} заказ(ов)
            </h2>
            <p className="text-xs text-stone-400 mt-0.5">
              Итого: паллеты + роллкейджи × {COEFFICIENT} (Садыгалиева-сыпучка — евро + американцы × {EURO_AMERICAN_COEF}; Заморозка/Хлебзавод/ККЦП — паллеты + коробки по ступеням 20/40) ·
              разгрузка: {PALLET_UNLOAD_SEC} с/паллету ({`Садыгалиева-сыпучка — 600`}), {POINT_UNLOAD_SEC} с/точку (фиксировано) ·
              вес: Садыгалиева-сыпучка — как указал склад, остальные — паллето-эквивалент × {PALLET_KG} кг
            </p>
          </div>
          <button onClick={onExport} className="flex items-center gap-2 bg-stone-900 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-stone-700 transition-colors">
            <Download size={15} /> Скачать в Excel
          </button>
        </div>

        <div className="bg-white border border-stone-200 rounded-xl overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-stone-50 text-stone-500 text-xs uppercase tracking-wide">
                <th className="text-left font-semibold px-4 py-3">Заказ №</th>
                <th className="text-left font-semibold px-4 py-3">Склад</th>
                <th className="text-left font-semibold px-4 py-3">Магазин</th>
                <th className="text-right font-semibold px-4 py-3">Паллеты</th>
                <th className="text-right font-semibold px-4 py-3">Роллы</th>
                <th className="text-right font-semibold px-4 py-3">Евро</th>
                <th className="text-right font-semibold px-4 py-3">Американцы</th>
                <th className="text-right font-semibold px-4 py-3">Коробки</th>
                <th className="text-right font-semibold px-4 py-3">Итого</th>
                <th className="text-right font-semibold px-4 py-3">Вес, кг</th>
              </tr>
            </thead>
            <tbody>
              {consolidated.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-sm text-stone-400">
                    Пока нет отправленных данных. Ждём кнопку «Отправить в транспортный отдел» на складах.
                  </td>
                </tr>
              ) : (
                consolidated.map((r) => {
                  const a = ACCENT[r.accent];
                  return (
                    <tr key={r.id} className="border-t border-stone-100">
                      <td className="px-4 py-2 font-mono">{r.order}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${a.text}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${a.dot}`} /> {r.warehouse}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-stone-700">{r.store}</td>
                      <td className="px-4 py-2 text-right font-mono text-stone-600">{r.pallets ?? "—"}</td>
                      <td className="px-4 py-2 text-right font-mono text-stone-600">{r.rolls ?? "—"}</td>
                      <td className="px-4 py-2 text-right font-mono text-stone-600">{r.euro ?? "—"}</td>
                      <td className="px-4 py-2 text-right font-mono text-stone-600">{r.american ?? "—"}</td>
                      <td className="px-4 py-2 text-right font-mono text-stone-600">{r.boxes ?? "—"}</td>
                      <td className="px-4 py-2 text-right font-mono font-semibold text-stone-900">{r.total}</td>
                      <td className="px-4 py-2 text-right font-mono text-stone-600">{r.weight}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
            {consolidated.length > 0 && (
              <tfoot>
                <tr className="border-t border-stone-200 bg-stone-50">
                  <td colSpan={8} className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-stone-500">Итого</td>
                  <td className="px-4 py-2.5 text-right font-mono font-bold text-stone-900">{Math.round(totalPallets * 100) / 100}</td>
                  <td className="px-4 py-2.5 text-right font-mono font-bold text-stone-900">{Math.round(totalWeight * 100) / 100}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">Транспорт на {dateLabel}</h2>
          <span className="text-xs text-stone-400">Список преднастроен из мастер-файла ТМС · готовность подтверждается каждый день заново</span>
        </div>
        <div className="bg-white border border-stone-200 rounded-xl overflow-hidden overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="bg-stone-50 text-stone-500 text-xs uppercase tracking-wide">
                <th className="text-left font-semibold px-4 py-3 w-32">Госномер</th>
                <th className="text-left font-semibold px-4 py-3 w-44">Точка старта</th>
                <th className="text-right font-semibold px-4 py-3 w-28">Вместимость, палл.</th>
                <th className="text-right font-semibold px-4 py-3 w-32">Грузопод-ть, т</th>
                <th className="text-left font-semibold px-4 py-3 w-24">ГБ</th>
                <th className="text-right font-semibold px-4 py-3 w-32">Точек доставки</th>
                <th className="text-left font-semibold px-4 py-3 w-28">Погрузка с</th>
                <th className="text-left font-semibold px-4 py-3 w-36">Готов на завтра</th>
                <th className="px-4 py-3 w-10" />
              </tr>
            </thead>
            <tbody>
              {(day.vehicles || []).filter((v) => v.carrier !== "ТК").map((v) => (
                <tr key={v.id} className="border-t border-stone-100">
                  <td className="px-4 py-2">
                    <input type="text" disabled={!v.custom} value={v.plate} onChange={(e) => onUpdateVehicle(v.id, "plate", e.target.value)} placeholder="Госномер" className="w-full font-mono text-sm rounded-md border border-stone-300 px-2 py-1.5 outline-none focus:ring-2 focus:ring-stone-400 disabled:bg-stone-50 disabled:text-stone-400" />
                  </td>
                  <td className="px-4 py-2">
                    <select
                      value={v.start || ""}
                      onChange={(e) => onUpdateVehicle(v.id, "start", e.target.value)}
                      className="w-full text-sm rounded-md border border-stone-300 px-2 py-1.5 outline-none focus:ring-2 focus:ring-stone-400 bg-white"
                    >
                      <option value="">— выбрать точку —</option>
                      {START_POINT_OPTIONS.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      {editingCapacity[v.id] ? (
                        <>
                          <input
                            type="text" inputMode="numeric" autoFocus value={v.pallets}
                            onChange={(e) => onUpdateVehicle(v.id, "pallets", sanitizeQty(e.target.value))}
                            onBlur={() => toggleEditCapacity(v.id)}
                            onKeyDown={(e) => e.key === "Enter" && toggleEditCapacity(v.id)}
                            className="w-16 font-mono text-sm text-right rounded-md border border-stone-300 px-2 py-1 outline-none focus:ring-2 focus:ring-stone-400"
                          />
                          <button onClick={() => toggleEditCapacity(v.id)} className="text-emerald-600 hover:text-emerald-800">
                            <Check size={14} />
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="font-mono text-stone-600">{v.pallets || "—"}</span>
                          <button onClick={() => toggleEditCapacity(v.id)} className="text-stone-300 hover:text-stone-600 transition-colors">
                            <Pencil size={13} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="text" inputMode="numeric" value={v.tons}
                      onChange={(e) => onUpdateVehicle(v.id, "tons", sanitizeQty(e.target.value))}
                      placeholder="0"
                      className="w-full font-mono text-sm text-right rounded-md border border-stone-300 px-2 py-1.5 outline-none focus:ring-2 focus:ring-stone-400"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => onUpdateVehicle(v.id, "gb", !v.gb)}
                      className={`flex items-center gap-2 text-sm font-semibold px-3 py-1.5 rounded-full transition-colors ${v.gb ? "bg-emerald-100 text-emerald-700" : "bg-stone-100 text-stone-400"}`}
                    >
                      {v.gb ? <CheckCircle2 size={14} /> : <Circle size={14} />} {v.gb ? "Есть" : "Нет"}
                    </button>
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="text" inputMode="numeric" value={v.maxPoints}
                      onChange={(e) => onUpdateVehicle(v.id, "maxPoints", sanitizeQty(e.target.value))}
                      placeholder="0"
                      className="w-full font-mono text-sm text-right rounded-md border border-stone-300 px-2 py-1.5 outline-none focus:ring-2 focus:ring-stone-400"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <select
                      value={v.from || "08:00"}
                      onChange={(e) => onUpdateVehicle(v.id, "from", e.target.value)}
                      className="w-full text-sm rounded-md border border-stone-300 px-2 py-1.5 outline-none focus:ring-2 focus:ring-stone-400 bg-white"
                    >
                      {LOAD_TIME_OPTIONS.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => onUpdateVehicle(v.id, "ready", !v.ready)}
                      className={`flex items-center gap-2 text-sm font-semibold px-3 py-1.5 rounded-full transition-colors ${v.ready ? "bg-emerald-100 text-emerald-700" : "bg-stone-100 text-stone-400"}`}
                    >
                      {v.ready ? <CheckCircle2 size={14} /> : <Circle size={14} />} {v.ready ? "Готов" : "Не готов"}
                    </button>
                  </td>
                  <td className="px-4 py-2 text-center">
                    <button onClick={() => onRemoveVehicle(v.id)} className="text-stone-300 hover:text-rose-500 transition-colors">
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={onAddVehicle} className="w-full flex items-center justify-center gap-2 text-sm font-semibold text-stone-500 hover:text-stone-800 hover:bg-stone-50 py-3 border-t border-stone-100 transition-colors">
            <Plus size={15} /> Добавить ТС
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Жашылча (ночь) — полностью отдельный контур: свой склад, свой список ТС,
// своя выгрузка, всегда на сегодняшнюю дату (заказы подаются день в день)
// ---------------------------------------------------------------------------

const ZH_SHIP_POINT = "РЦ Жашылча";
const ZH_GROUP = "Охлажденка";
const ZH_DISPLAY_NAME = "РЦ Жашылча - молочка (ночь)";
const ZH_START_OPTIONS = ["РЦ Жашылча", "Центральный офис", "РЦ Пригородное", "РЦ Ак-Орго", "РЦ РМ и ПТО", "РЦ Садыгалиева - сыпучка", "РЦ Садыгалиева - заморозка"];
// Жашылча работает ночью — своя, более поздняя шкала времени погрузки
const ZH_LOAD_TIME_OPTIONS = ["18:00", "19:00", "20:00", "21:00", "22:00", "23:00"];

function ZhashylchaPanel({ date }) {
  // дата ввода всегда «сегодня» — эта вкладка просто следует за календариком
  // наверху для ПРОСМОТРА: назад — архив прошлых дней, вперёд — пустая форма
  const zhDate = date;
  const today = todayISO();
  const isToday = zhDate === today;
  const isFuture = zhDate > today;
  
  const [zhDay, setZhDay] = useState({ rows: [makeEmptyRow()], submitted: false, vehicles: [] });
  const [zhLoading, setZhLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const saveTimers = useRef({});

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  };

  useEffect(() => {
    // будущая дата — заказы день в день, туда ещё рано, базу не трогаем вообще
    if (zhDate > todayISO()) {
      setZhDay({ rows: [makeEmptyRow()], submitted: false, vehicles: [] });
      setZhLoading(false);
      return;
    }
    setZhLoading(true);
    const unsub = subscribeToZhashylchaDay(
      zhDate,
      (data) => {
        // самовосстановление списка машин — только для сегодняшнего дня;
        // для архивных дат ничего не досоздаём, это просто просмотр истории
        if (zhDate === todayISO() && (!data.vehicles || data.vehicles.length === 0)) {
          const seeded = seedZhashylchaVehicles();
          setZhDay({ ...data, vehicles: seeded });
          saveZhashylchaVehicles(zhDate, seeded).catch(() => {});
        } else {
          setZhDay(data);
        }
        setZhLoading(false);
      },
      () => setZhLoading(false)
    );
    return unsub;
  }, [zhDate]);

  const rows = zhDay.rows || [];

  const duplicateOrders = useMemo(() => {
    const counts = {};
    rows.forEach((r) => {
      const key = r.order.trim().toLowerCase();
      if (!key) return;
      counts[key] = (counts[key] || 0) + 1;
    });
    return new Set(Object.keys(counts).filter((k) => counts[k] > 1));
  }, [rows]);
  const duplicateStores = useMemo(() => findDuplicateStores(rows), [rows]);

  const patchRows = useCallback(
    (updater) => {
      setZhDay((current) => {
        const nextRows = updater(current.rows || []);
        const next = { ...current, rows: nextRows };
        const key = "rows";
        if (saveTimers.current[key]) clearTimeout(saveTimers.current[key]);
        saveTimers.current[key] = setTimeout(() => {
          saveZhashylchaRows(zhDate, nextRows).catch(() => showToast("Не удалось сохранить — проверьте связь"));
        }, 500);
        return next;
      });
    },
    [zhDate]
  );

  const updateRow = (rowId, field, value) => {
    patchRows((rs) =>
      rs.map((r) => {
        if (r.id !== rowId) return r;
        let v = value;
        if (field === "euro" || field === "american") v = sanitizeHalfStep(value);
        if (field === "boxes") v = sanitizeQty(value);
        if (field === "weight") v = sanitizeWeight(value);
        return { ...r, [field]: v };
      })
    );
  };
  const addRow = () => patchRows((rs) => [...rs, makeEmptyRow()]);
  const removeRow = (rowId) => patchRows((rs) => (rs.length > 1 ? rs.filter((r) => r.id !== rowId) : rs));

  const submitZh = async () => {
    const filled = rows.filter((r) => rowIssues(r, true, "euroAmericanBoxes").hasData);
    if (filled.length === 0) return showToast("Нет заполненных строк для отправки");
    const incompleteCount = filled.filter((r) => rowIssues(r, true, "euroAmericanBoxes").incomplete).length;
    if (incompleteCount > 0) {
      return showToast(
        incompleteCount === 1
          ? "Одна строка заполнена не полностью — проверьте подсвеченные поля"
          : `${incompleteCount} строк заполнены не полностью — проверьте подсвеченные поля`
      );
    }
    const hasDupe = filled.some((r) => duplicateOrders.has(r.order.trim().toLowerCase()));
    if (hasDupe) return showToast("Есть повторяющиеся номера заказов — исправьте перед отправкой");
    const dupStores = findDuplicateStores(filled);
    const hasDupeStore = filled.some((r) => dupStores.has(r.store.trim().toLowerCase()));
    if (hasDupeStore) return showToast("На один магазин может быть только один заказ — исправьте повторяющиеся магазины");

    try {
      await setZhashylchaSubmitted(zhDate, true);
      showToast(`${ZH_DISPLAY_NAME}: данные отправлены в транспортный отдел`);
    } catch {
      showToast("Не удалось отправить — проверьте связь и попробуйте снова");
    }
  };
  const unlockZh = () => setZhashylchaSubmitted(zhDate, false).catch(() => showToast("Не удалось изменить статус"));

  const patchVehicles = useCallback(
    (updater) => {
      setZhDay((current) => {
        const next = { ...current, vehicles: updater(current.vehicles || []) };
        const key = "vehicles";
        if (saveTimers.current[key]) clearTimeout(saveTimers.current[key]);
        saveTimers.current[key] = setTimeout(() => {
          saveZhashylchaVehicles(zhDate, next.vehicles).catch(() => showToast("Не удалось сохранить — проверьте связь"));
        }, 500);
        return next;
      });
    },
    [zhDate]
  );
  const addVehicle = () =>
    patchVehicles((vs) => [
      ...vs,
      { id: Math.random().toString(36).slice(2, 10), extId: "", plate: "", carrier: "УмайГрупп", pallets: "", tons: "", skills: "", from: "21:00", to: "19:00", start: ZH_SHIP_POINT, bodyType: "РЕФ", gb: false, maxPoints: "", custom: true, ready: false },
    ]);
  const updateVehicle = (id, field, value) => patchVehicles((vs) => vs.map((v) => (v.id === id ? { ...v, [field]: value } : v)));
  const removeVehicle = (id) => patchVehicles((vs) => vs.filter((v) => v.id !== id));

  const consolidated = useMemo(() => {
    if (!zhDay.submitted) return [];
    return rows
      .filter((r) => r.order.trim())
      .map((r) => {
        const euro = parseFloat(r.euro) || 0;
        const american = parseFloat(r.american) || 0;
        const boxes = parseInt(r.boxes, 10) || 0;
        const weight = parseFloat(r.weight) || 0;
        return {
          id: r.id, order: r.order.trim(), store: r.store || "—",
          euro, american, boxes,
          total: Math.round((euro + american * EURO_AMERICAN_COEF + boxesToPallets(boxes)) * 100) / 100,
          weight: Math.round(weight * 100) / 100,
          shipPoint: ZH_SHIP_POINT,
          unloadSec: PALLET_UNLOAD_SEC,
          group: ZH_GROUP,
        };
      });
  }, [zhDay.submitted, rows]);

  const exportZh = () => {
    if (consolidated.length === 0) return showToast("Нет данных для выгрузки — сначала отправьте заказы");
    const readyCount = (zhDay.vehicles || []).length && (zhDay.vehicles || []).filter((v) => v.ready).length;
    if (!readyCount) return showToast("Сначала проставьте готовность хотя бы одного ТС");
    downloadZhashylchaWorkbook(zhDate, consolidated, zhDay.vehicles || []);
    showToast("Файл сформирован и скачан");
  };

  const dateLabel = fmtDateRu(zhDate);

  if (zhLoading) {
    return (
      <div className="flex items-center justify-center gap-2 text-sm text-stone-400 py-24">
        <Loader2 size={16} className="animate-spin" /> Загрузка данных за {dateLabel}…
      </div>
    );
  }

  if (isFuture) {
    return (
      <div className="space-y-4">
        <div className="bg-cyan-50 border border-cyan-200 rounded-xl px-4 py-3 flex items-center gap-2 text-xs text-cyan-800">
          <Moon size={14} />
          Отдельный контур: заказы подаются день в день, дата ввода всегда «сегодня» ({fmtDateRu(today)}).
        </div>
        <div className="bg-white border border-stone-200 rounded-xl px-6 py-16 text-center text-sm text-stone-400">
          {dateLabel} ещё не наступила — форма для {ZH_DISPLAY_NAME} откроется автоматически в этот день.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="bg-cyan-50 border border-cyan-200 rounded-xl px-4 py-3 flex items-center gap-2 text-xs text-cyan-800">
        <Moon size={14} />
        {isToday
          ? `Отдельный контур: свой список заказов, свои ТС и своя выгрузка — не пересекается с остальными складами. Всегда дата «сегодня» (${dateLabel}), заказы подаются день в день.`
          : `Архив за ${dateLabel} — только просмотр. Ввод и редактирование доступны исключительно на сегодняшний день (${fmtDateRu(today)}).`}
      </div>

      {/* ---- блок склада: ввод заказов ---- */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-cyan-700 mb-1">
              <span className="h-2 w-2 rounded-full bg-cyan-500" /> Склад · {ZH_DISPLAY_NAME}
            </div>
            <p className="text-sm text-stone-500">
              Заказ №, количество евро- и американских паллет (шаг 0,5), коробок и вес на {dateLabel}. Магазин выбирается из списка.
              Коробки пересчитываются в паллеты автоматически (до 20 шт — 0,5 паллеты, 20–40 — целая паллета и так далее).
            </p>
          </div>
        </div>

        {zhDay.submitted && (
          <div className="mb-4 flex items-center justify-between gap-3 bg-stone-100 border border-stone-300 rounded-lg px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-stone-700">
              <Lock size={15} className="text-stone-500" /> Данные за {dateLabel} отправлены в транспортный отдел. Редактирование заблокировано.
            </div>
            {isToday && (
              <button onClick={unlockZh} className="text-xs font-semibold text-stone-600 underline underline-offset-2 hover:text-stone-900 whitespace-nowrap">
                Вернуть на редактирование
              </button>
            )}
          </div>
        )}

        <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-stone-50 text-stone-500 text-xs uppercase tracking-wide">
                <th className="text-left font-semibold px-4 py-3 w-10">#</th>
                <th className="text-left font-semibold px-4 py-3 w-40">Заказ №</th>
                <th className="text-left font-semibold px-4 py-3">Магазин</th>
                <th className="text-left font-semibold px-4 py-3 w-28">Евро</th>
                <th className="text-left font-semibold px-4 py-3 w-28">Американцы</th>
                <th className="text-left font-semibold px-4 py-3 w-28">Коробки</th>
                <th className="text-left font-semibold px-4 py-3 w-28">Вес, кг</th>
                <th className="px-4 py-3 w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const isDupe = r.order.trim() && duplicateOrders.has(r.order.trim().toLowerCase());
                const isDupeStore = r.store && duplicateStores.has(r.store.trim().toLowerCase());
                const issues = rowIssues(r, true, "euroAmericanBoxes");
                const errBorder = "border-rose-400 bg-rose-50 focus:ring-2 focus:ring-rose-400";
                const okBorder = "border-stone-300 focus:ring-2 focus:ring-stone-400";
                return (
                  <tr key={r.id} className="border-t border-stone-100 align-top">
                    <td className="px-4 py-2 text-stone-400 font-mono text-xs pt-2.5">{i + 1}</td>
                    <td className="px-4 py-2">
                      <input
                        type="text" disabled={!isToday || zhDay.submitted} value={r.order}
                        onChange={(e) => updateRow(r.id, "order", e.target.value)}
                        placeholder="напр. 100234"
                        className={`w-full font-mono text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 ${isDupe || issues.missingOrder ? errBorder : okBorder}`}
                      />
                      {isDupe && <div className="text-xs text-rose-600 mt-1">Номер дублируется</div>}
                      {!isDupe && issues.missingOrder && <div className="text-xs text-rose-600 mt-1">Укажите номер заказа</div>}
                    </td>
                    <td className="px-4 py-2">
                      <select
                        disabled={!isToday || zhDay.submitted} value={r.store}
                        onChange={(e) => updateRow(r.id, "store", e.target.value)}
                        className={`w-full text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 bg-white ${issues.missingStore || isDupeStore ? errBorder : okBorder}`}
                      >
                        <option value="">— выбрать магазин —</option>
                        {STORES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                      {issues.missingStore && <div className="text-xs text-rose-600 mt-1">Выберите магазин</div>}
                      {!issues.missingStore && isDupeStore && <div className="text-xs text-rose-600 mt-1">На этот магазин уже есть заказ — проверьте дубли</div>}
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="text" inputMode="decimal" disabled={!isToday || zhDay.submitted} value={r.euro}
                        onChange={(e) => updateRow(r.id, "euro", e.target.value)}
                        placeholder="0"
                        className={`w-full font-mono text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 ${issues.missingQty ? errBorder : okBorder}`}
                      />
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="text" inputMode="decimal" disabled={!isToday || zhDay.submitted} value={r.american}
                        onChange={(e) => updateRow(r.id, "american", e.target.value)}
                        placeholder="0"
                        className={`w-full font-mono text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 ${issues.missingQty ? errBorder : okBorder}`}
                      />
                      {issues.missingQty && <div className="text-xs text-rose-600 mt-1">Укажите евро, американца или коробки</div>}
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="text" inputMode="numeric" disabled={!isToday || zhDay.submitted} value={r.boxes}
                        onChange={(e) => updateRow(r.id, "boxes", e.target.value)}
                        placeholder="0"
                        className={`w-full font-mono text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 ${issues.missingQty ? errBorder : okBorder}`}
                      />
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="text" inputMode="decimal" disabled={!isToday || zhDay.submitted} value={r.weight}
                        onChange={(e) => updateRow(r.id, "weight", e.target.value)}
                        placeholder="0"
                        className={`w-full font-mono text-sm rounded-md border px-2 py-1.5 outline-none disabled:bg-stone-50 disabled:text-stone-400 ${issues.missingWeight ? errBorder : okBorder}`}
                      />
                      {issues.missingWeight && <div className="text-xs text-rose-600 mt-1">Укажите вес</div>}
                    </td>
                    <td className="px-4 py-2 text-center">
                      {isToday && !zhDay.submitted && (
                        <button onClick={() => removeRow(r.id)} className="text-stone-300 hover:text-rose-500 transition-colors">
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {isToday && !zhDay.submitted && (
            <button onClick={addRow} className="w-full flex items-center justify-center gap-2 text-sm font-semibold text-stone-500 hover:text-stone-800 hover:bg-stone-50 py-3 border-t border-stone-100 transition-colors">
              <Plus size={15} /> Добавить заказ
            </button>
          )}
        </div>

        {isToday && !zhDay.submitted && (
          <div className="flex justify-end mt-4">
            <button onClick={submitZh} className="flex items-center gap-2 bg-cyan-600 text-white text-sm font-semibold px-5 py-2.5 rounded-lg hover:opacity-90 transition-opacity shadow-sm">
              <Send size={15} /> Отправить в транспортный отдел
            </button>
          </div>
        )}
      </div>

      {/* ---- блок ОТЛ: консолидация + машины + выгрузка ---- */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">
              Для ОТЛ · {ZH_DISPLAY_NAME} — {dateLabel} · {consolidated.length} заказ(ов)
            </h2>
            <p className="text-xs text-stone-400 mt-0.5">
              Итого = евро + американцы × {EURO_AMERICAN_COEF} + коробки (по ступеням 20/40) · разгрузка: {PALLET_UNLOAD_SEC} с/паллету, {POINT_UNLOAD_SEC} с/точку · товарная группа: {ZH_GROUP}
            </p>
          </div>
          <button onClick={exportZh} className="flex items-center gap-2 bg-stone-900 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-stone-700 transition-colors">
            <Download size={15} /> Скачать в Excel
          </button>
        </div>

        <div className="bg-white border border-stone-200 rounded-xl overflow-hidden mb-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-stone-50 text-stone-500 text-xs uppercase tracking-wide">
                <th className="text-left font-semibold px-4 py-3">Заказ №</th>
                <th className="text-left font-semibold px-4 py-3">Магазин</th>
                <th className="text-right font-semibold px-4 py-3">Евро</th>
                <th className="text-right font-semibold px-4 py-3">Американцы</th>
                <th className="text-right font-semibold px-4 py-3">Коробки</th>
                <th className="text-right font-semibold px-4 py-3">Итого</th>
                <th className="text-right font-semibold px-4 py-3">Вес, кг</th>
              </tr>
            </thead>
            <tbody>
              {consolidated.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-stone-400">
                    Пока нет отправленных данных. Ждём кнопку «Отправить в транспортный отдел» выше.
                  </td>
                </tr>
              ) : (
                consolidated.map((r) => (
                  <tr key={r.id} className="border-t border-stone-100">
                    <td className="px-4 py-2 font-mono">{r.order}</td>
                    <td className="px-4 py-2 text-stone-700">{r.store}</td>
                    <td className="px-4 py-2 text-right font-mono text-stone-600">{r.euro}</td>
                    <td className="px-4 py-2 text-right font-mono text-stone-600">{r.american}</td>
                    <td className="px-4 py-2 text-right font-mono text-stone-600">{r.boxes}</td>
                    <td className="px-4 py-2 text-right font-mono font-semibold text-stone-900">{r.total}</td>
                    <td className="px-4 py-2 text-right font-mono text-stone-600">{r.weight}</td>
                  </tr>
                ))
              )}
            </tbody>
            {consolidated.length > 0 && (
              <tfoot>
                <tr className="border-t border-stone-200 bg-stone-50">
                  <td colSpan={5} className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-stone-500">Итого</td>
                  <td className="px-4 py-2.5 text-right font-mono font-bold text-stone-900">
                    {Math.round(consolidated.reduce((s, r) => s + r.total, 0) * 100) / 100}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono font-bold text-stone-900">
                    {Math.round(consolidated.reduce((s, r) => s + r.weight, 0) * 100) / 100}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <h3 className="text-sm font-bold uppercase tracking-wide text-stone-500 mb-3">Транспорт ({ZH_DISPLAY_NAME})</h3>
        <div className="bg-white border border-stone-200 rounded-xl overflow-hidden overflow-x-auto">
          <table className="w-full text-sm min-w-[880px]">
            <thead>
              <tr className="bg-stone-50 text-stone-500 text-xs uppercase tracking-wide">
                <th className="text-left font-semibold px-4 py-3 w-32">Госномер</th>
                <th className="text-left font-semibold px-4 py-3 w-44">Точка старта</th>
                <th className="text-right font-semibold px-4 py-3 w-24">Вместим., палл.</th>
                <th className="text-right font-semibold px-4 py-3 w-24">Грузопод-ть, т</th>
                <th className="text-left font-semibold px-4 py-3 w-24">ГБ</th>
                <th className="text-right font-semibold px-4 py-3 w-24">Точек доставки</th>
                <th className="text-left font-semibold px-4 py-3 w-24">Погрузка с</th>
                <th className="text-left font-semibold px-4 py-3 w-32">Готов на завтра</th>
                <th className="px-4 py-3 w-10" />
              </tr>
            </thead>
            <tbody>
              {(zhDay.vehicles || []).map((v) => (
                <tr key={v.id} className="border-t border-stone-100">
                  <td className="px-4 py-2">
                    <input type="text" disabled={!isToday || !v.custom} value={v.plate} onChange={(e) => updateVehicle(v.id, "plate", e.target.value)} placeholder="Госномер" className="w-full font-mono text-sm rounded-md border border-stone-300 px-2 py-1.5 outline-none focus:ring-2 focus:ring-stone-400 disabled:bg-stone-50 disabled:text-stone-400" />
                  </td>
                  <td className="px-4 py-2">
                    <select
                      disabled={!isToday}
                      value={v.start || ""}
                      onChange={(e) => updateVehicle(v.id, "start", e.target.value)}
                      className="w-full text-sm rounded-md border border-stone-300 px-2 py-1.5 outline-none focus:ring-2 focus:ring-stone-400 bg-white disabled:bg-stone-50 disabled:text-stone-400"
                    >
                      <option value="">— выбрать точку —</option>
                      {ZH_START_OPTIONS.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <input type="text" inputMode="numeric" disabled={!isToday} value={v.pallets} onChange={(e) => updateVehicle(v.id, "pallets", sanitizeQty(e.target.value))} placeholder="0" className="w-full font-mono text-sm text-right rounded-md border border-stone-300 px-2 py-1.5 outline-none focus:ring-2 focus:ring-stone-400 disabled:bg-stone-50 disabled:text-stone-400" />
                  </td>
                  <td className="px-4 py-2">
                    <input type="text" inputMode="numeric" disabled={!isToday} value={v.tons} onChange={(e) => updateVehicle(v.id, "tons", sanitizeQty(e.target.value))} placeholder="0" className="w-full font-mono text-sm text-right rounded-md border border-stone-300 px-2 py-1.5 outline-none focus:ring-2 focus:ring-stone-400 disabled:bg-stone-50 disabled:text-stone-400" />
                  </td>
                  <td className="px-4 py-2">
                    <button
                      disabled={!isToday}
                      onClick={() => updateVehicle(v.id, "gb", !v.gb)}
                      className={`flex items-center gap-2 text-sm font-semibold px-3 py-1.5 rounded-full transition-colors disabled:opacity-50 ${v.gb ? "bg-emerald-100 text-emerald-700" : "bg-stone-100 text-stone-400"}`}
                    >
                      {v.gb ? <CheckCircle2 size={14} /> : <Circle size={14} />} {v.gb ? "Есть" : "Нет"}
                    </button>
                  </td>
                  <td className="px-4 py-2">
                    <input type="text" inputMode="numeric" disabled={!isToday} value={v.maxPoints} onChange={(e) => updateVehicle(v.id, "maxPoints", sanitizeQty(e.target.value))} placeholder="0" className="w-full font-mono text-sm text-right rounded-md border border-stone-300 px-2 py-1.5 outline-none focus:ring-2 focus:ring-stone-400 disabled:bg-stone-50 disabled:text-stone-400" />
                  </td>
                  <td className="px-4 py-2">
                    <select
                      disabled={!isToday}
                      value={v.from || "21:00"}
                      onChange={(e) => updateVehicle(v.id, "from", e.target.value)}
                      className="w-full text-sm rounded-md border border-stone-300 px-2 py-1.5 outline-none focus:ring-2 focus:ring-stone-400 bg-white disabled:bg-stone-50 disabled:text-stone-400"
                    >
                      {ZH_LOAD_TIME_OPTIONS.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <button
                      disabled={!isToday}
                      onClick={() => updateVehicle(v.id, "ready", !v.ready)}
                      className={`flex items-center gap-2 text-sm font-semibold px-3 py-1.5 rounded-full transition-colors disabled:opacity-50 ${v.ready ? "bg-emerald-100 text-emerald-700" : "bg-stone-100 text-stone-400"}`}
                    >
                      {v.ready ? <CheckCircle2 size={14} /> : <Circle size={14} />} {v.ready ? "Готов" : "Не готов"}
                    </button>
                  </td>
                  <td className="px-4 py-2 text-center">
                    {isToday && (
                      <button onClick={() => removeVehicle(v.id)} className="text-stone-300 hover:text-rose-500 transition-colors">
                        <Trash2 size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {isToday && (
            <button onClick={addVehicle} className="w-full flex items-center justify-center gap-2 text-sm font-semibold text-stone-500 hover:text-stone-800 hover:bg-stone-50 py-3 border-t border-stone-100 transition-colors">
              <Plus size={15} /> Добавить ТС
            </button>
          )}
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-stone-900 text-white text-sm font-medium px-4 py-3 rounded-lg shadow-lg flex items-center gap-2">
          <AlertTriangle size={14} className="text-amber-400" /> {toast}
        </div>
      )}
    </div>
  );
}
