import { doc, onSnapshot, setDoc, getDoc, runTransaction } from "firebase/firestore";
import { db } from "../firebase";
import { VEHICLES_TEMPLATE, ZHASHYLCHA_VEHICLES_TEMPLATE, KARAKOL_WAREHOUSE_IDS, REGION_WAREHOUSE_IDS, OSH_WAREHOUSE_IDS, TRANSIT_WAREHOUSE_IDS, SEVER_WAREHOUSE_IDS } from "../data/reference";

const uid = () => Math.random().toString(36).slice(2, 10);

export const seedVehiclesForDay = () =>
  VEHICLES_TEMPLATE.filter((v) => v.carrier !== "ТК").map((v) => ({
    id: uid(),
    extId: v.extId,
    plate: v.plate,
    carrier: v.carrier,
    driverLastName: v.lastName || "",
    driverFirstName: v.firstName || "",
    pallets: v.pallets,
    tons: v.tons,
    skills: v.skills,
    from: v.from,
    to: v.to,
    start: v.start || "",
    bodyType: v.bodyType || "",
    gb: Boolean(v.gb),
    maxPoints: v.maxPoints || "",
    custom: false,
    ready: false,
  }));

export const makeEmptyRow = () => ({
  id: uid(), order: "", store: "",
  pallets: "", rolls: "", euro: "", american: "", boxes: "",
  weight: "", category: "",
});

export const emptyDay = () => ({
  rows_prigorodnoe: [makeEmptyRow()],
  rows_argo: [makeEmptyRow()],
  rows_pto: [makeEmptyRow()],
  rows_sagadalieva: [makeEmptyRow()],
  rows_sagadalieva_zamorozka: [makeEmptyRow()],
  rows_hlebzavod: [makeEmptyRow()],
  rows_kkcp: [makeEmptyRow()],
  rows_kcp: [makeEmptyRow()],
  rows_sendvichi: [makeEmptyRow()],
  rows_transit_yug: [makeEmptyRow()],
  rows_transit_sever: [makeEmptyRow()],
  submitted_prigorodnoe: false,
  submitted_argo: false,
  submitted_pto: false,
  submitted_sagadalieva: false,
  submitted_sagadalieva_zamorozka: false,
  submitted_hlebzavod: false,
  submitted_kkcp: false,
  submitted_kcp: false,
  submitted_sendvichi: false,
  submitted_transit_yug: false,
  submitted_transit_sever: false,
  vehicles: seedVehiclesForDay(),
});

// Создание пустого дня — ТОЛЬКО если документа на сервере действительно нет.
// Раньше здесь был setDoc(seed, {merge:true}): при плохой связи onSnapshot мог на мгновение
// сообщить «документа нет» (данные из кэша), и отложенная запись пустого дня затирала
// заполненные склады (массивы rows_* при merge заменяются целиком). Транзакция читает
// документ с сервера и не работает офлайн, поэтому затереть данные уже не может.
const seedIfMissing = (ref, seed) =>
  runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) tx.set(ref, seed);
  }).catch((err) => console.error("[dayStore] seed creation failed", err));

const dayRef = (date) => doc(db, "shipments", date);

export function subscribeToDay(date, onChange, onError) {
  return onSnapshot(
    dayRef(date),
    (snap) => {
      if (snap.exists()) {
        // в днях, созданных до появления КЦП/Сендвичей, этих полей нет — подставляем пустые
        const data = snap.data();
        const fill = {};
        ["kcp", "sendvichi"].forEach((id) => {
          if (!data[`rows_${id}`]) fill[`rows_${id}`] = [makeEmptyRow()];
          if (data[`submitted_${id}`] === undefined) fill[`submitted_${id}`] = false;
        });
        onChange({ ...data, ...fill });
      } else {
        const seed = emptyDay();
        // merge:true — на случай, если два клиента одновременно откроют
        // новый день, вторая запись не затрёт первую, а сольётся с ней.
        seedIfMissing(dayRef(date), seed);
        onChange(seed);
      }
    },
    (err) => onError && onError(err)
  );
}

export async function ensureDayExists(date) {
  const snap = await getDoc(dayRef(date));
  if (!snap.exists()) {
    await setDoc(dayRef(date), emptyDay(), { merge: true });
  }
}

// ---------------------------------------------------------------------------
// Запись данных склада/машин на день.
//
// Раньше здесь стоял updateDoc — он требует, чтобы документ дня уже
// существовал. Если сохранение приходило раньше, чем завершалось создание
// документа в subscribeToDay (а оно не ожидалось — "выстрелил и забыл"),
// updateDoc падал с "No document to update", и это падение никто не ловил:
// на экране склада данные выглядели введёнными, а в базе не сохранялось
// ничего. setDoc(..., { merge: true }) создаёт документ при необходимости
// и в любом случае мержит указанное поле, не трогая остальные — гонка
// становится невозможной в принципе.
//
// Ошибки теперь не проглатываются: пишем в консоль и пробрасываем дальше,
// чтобы вызывающий код (например, обработчик в ShipmentApp.jsx) мог
// показать складу видимое сообщение "не удалось сохранить".
// ---------------------------------------------------------------------------

export async function saveWarehouseRows(date, whId, rows) {
  try {
    await setDoc(dayRef(date), { [`rows_${whId}`]: rows }, { merge: true });
  } catch (err) {
    console.error("[dayStore] saveWarehouseRows failed", { date, whId }, err);
    throw err;
  }
}

export async function setSubmitted(date, whId, value) {
  try {
    await setDoc(dayRef(date), { [`submitted_${whId}`]: value }, { merge: true });
  } catch (err) {
    console.error("[dayStore] setSubmitted failed", { date, whId, value }, err);
    throw err;
  }
}

export async function saveVehicles(date, vehicles) {
  try {
    await setDoc(dayRef(date), { vehicles }, { merge: true });
  } catch (err) {
    console.error("[dayStore] saveVehicles failed", { date }, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// РЦ Жашылча — отдельный контур: своя коллекция в Firestore, один общий список
// машин, всегда привязан к сегодняшней дате (заказы день в день).
// Две формы заказов: «Молоко» (rows_milk / submitted_milk — строки из файла 1С: номер,
// магазин, вес, объём) и «СОФ» (rows_sof / submitted_sof — ручной ввод, без выгрузки).
// Список на дату D подаётся до 11:00 дня D (доставка с 18:00 D до 18:00 D+1).
// Старые поля rows / submitted (прежняя форма «Молоко») остаются в базе, но не используются.
// ---------------------------------------------------------------------------

export const seedZhashylchaVehicles = () =>
  ZHASHYLCHA_VEHICLES_TEMPLATE.map((v) => ({
    id: uid(),
    extId: v.extId,
    plate: v.plate,
    carrier: v.carrier,
    pallets: v.pallets,
    tons: v.tons,
    skills: v.skills,
    from: v.from,
    to: v.to,
    start: v.start || "",
    bodyType: v.bodyType || "",
    gb: Boolean(v.gb),
    maxPoints: v.maxPoints || "",
    custom: false,
    ready: false,
  }));

export const emptyZhashylchaDay = () => ({
  rows: [makeEmptyRow()],
  submitted: false,
  rows_sof: [makeEmptyRow()],
  submitted_sof: false,
  rows_milk: [makeEmptyYugRow()],
  submitted_milk: false,
  vehicles: seedZhashylchaVehicles(),
});

// kind: "milk" (по умолчанию) — «Молоко», "sof" — «СОФ»
const zhFields = (kind) =>
  kind === "sof" ? { rows: "rows_sof", submitted: "submitted_sof" } : { rows: "rows_milk", submitted: "submitted_milk" };

const zhashylchaRef = (date) => doc(db, "shipments_zhashylcha", date);

export function subscribeToZhashylchaDay(date, onChange, onError) {
  return onSnapshot(
    zhashylchaRef(date),
    (snap) => {
      if (snap.exists()) {
        onChange(snap.data());
      } else {
        const seed = emptyZhashylchaDay();
        seedIfMissing(zhashylchaRef(date), seed);
        onChange(seed);
      }
    },
    (err) => onError && onError(err)
  );
}

export async function saveZhashylchaRows(date, rows, kind = "milk") {
  try {
    await setDoc(zhashylchaRef(date), { [zhFields(kind).rows]: rows }, { merge: true });
  } catch (err) {
    console.error("[dayStore] saveZhashylchaRows failed", { date }, err);
    throw err;
  }
}

export async function setZhashylchaSubmitted(date, value, kind = "milk") {
  try {
    await setDoc(zhashylchaRef(date), { [zhFields(kind).submitted]: value }, { merge: true });
  } catch (err) {
    console.error("[dayStore] setZhashylchaSubmitted failed", { date, value }, err);
    throw err;
  }
}

export async function saveZhashylchaVehicles(date, vehicles) {
  try {
    await setDoc(zhashylchaRef(date), { vehicles }, { merge: true });
  } catch (err) {
    console.error("[dayStore] saveZhashylchaVehicles failed", { date }, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Каракол — отдельная коллекция shipments_karakol/{YYYY-MM-DD}.
// 4 склада (Пригородное, Ак-Орго, ПТО, Садыгалиева-сыпучка), у каждого свои
// rows_<id> и submitted_<id>. Транспорта здесь нет.
// Следует календарю сверху — как основные склады.
// ---------------------------------------------------------------------------

export const emptyKarakolDay = () => {
  const day = {};
  KARAKOL_WAREHOUSE_IDS.forEach((id) => {
    day[`rows_${id}`] = [makeEmptyRow()];
    day[`submitted_${id}`] = false;
  });
  return day;
};

const karakolRef = (date) => doc(db, "shipments_karakol", date);

export function subscribeToKarakolDay(date, onChange, onError) {
  return onSnapshot(
    karakolRef(date),
    (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        // если в документе нет полей какого-то склада (например, склад добавили
        // позже, чем создали этот день) — досоздаём только недостающие поля
        const patch = {};
        KARAKOL_WAREHOUSE_IDS.forEach((id) => {
          if (!Array.isArray(data[`rows_${id}`])) patch[`rows_${id}`] = [makeEmptyRow()];
          if (typeof data[`submitted_${id}`] !== "boolean") patch[`submitted_${id}`] = false;
        });
        if (Object.keys(patch).length > 0) {
          setDoc(karakolRef(date), patch, { merge: true }).catch((err) =>
            console.error("[dayStore] karakol backfill failed for", date, err)
          );
          onChange({ ...data, ...patch });
        } else {
          onChange(data);
        }
      } else {
        const seed = emptyKarakolDay();
        seedIfMissing(karakolRef(date), seed);
        onChange(seed);
      }
    },
    (err) => onError && onError(err)
  );
}

export async function saveKarakolRows(date, whId, rows) {
  try {
    await setDoc(karakolRef(date), { [`rows_${whId}`]: rows }, { merge: true });
  } catch (err) {
    console.error("[dayStore] saveKarakolRows failed", { date, whId }, err);
    throw err;
  }
}

export async function setKarakolSubmitted(date, whId, value) {
  try {
    await setDoc(karakolRef(date), { [`submitted_${whId}`]: value }, { merge: true });
  } catch (err) {
    console.error("[dayStore] setKarakolSubmitted failed", { date, whId, value }, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Региональные вкладки с обычными формами складов (как Каракол): РЦ Базар-Коргон,
// РЦ Ош, Север. Для каждой — своя коллекция shipments_<...>/{YYYY-MM-DD},
// у каждого склада свои rows_<id> и submitted_<id>.
// ---------------------------------------------------------------------------

// yugKeys — дополнительные блоки со строками формата 1С (номер, магазин, вес, объём)
const makeRegionStore = (collectionName, whIds, yugKeys = []) => {
  const allKeys = [...whIds, ...yugKeys];
  const emptyFor = (id) => [yugKeys.includes(id) ? makeEmptyYugRow() : makeEmptyRow()];
  const refFor = (date) => doc(db, collectionName, date);
  const empty = () => {
    const day = {};
    allKeys.forEach((id) => {
      day[`rows_${id}`] = emptyFor(id);
      day[`submitted_${id}`] = false;
    });
    return day;
  };
  const subscribe = (date, onChange, onError) =>
    onSnapshot(
      refFor(date),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          const patch = {};
          allKeys.forEach((id) => {
            if (!Array.isArray(data[`rows_${id}`])) patch[`rows_${id}`] = emptyFor(id);
            if (typeof data[`submitted_${id}`] !== "boolean") patch[`submitted_${id}`] = false;
          });
          if (Object.keys(patch).length > 0) {
            setDoc(refFor(date), patch, { merge: true }).catch((err) =>
              console.error(`[dayStore] ${collectionName} backfill failed for`, date, err)
            );
            onChange({ ...data, ...patch });
          } else {
            onChange(data);
          }
        } else {
          const seed = empty();
          seedIfMissing(refFor(date), seed);
          onChange(seed);
        }
      },
      (err) => onError && onError(err)
    );
  const saveRows = async (date, whId, rows) => {
    try {
      await setDoc(refFor(date), { [`rows_${whId}`]: rows }, { merge: true });
    } catch (err) {
      console.error(`[dayStore] ${collectionName} saveRows failed`, { date, whId }, err);
      throw err;
    }
  };
  const setSubmittedFlag = async (date, whId, value) => {
    try {
      await setDoc(refFor(date), { [`submitted_${whId}`]: value }, { merge: true });
    } catch (err) {
      console.error(`[dayStore] ${collectionName} setSubmitted failed`, { date, whId, value }, err);
      throw err;
    }
  };
  return { empty, subscribe, saveRows, setSubmitted: setSubmittedFlag };
};

const bazarKorgonStore = makeRegionStore("shipments_bazar_korgon", REGION_WAREHOUSE_IDS);
export const emptyBazarKorgonDay = bazarKorgonStore.empty;
export const subscribeToBazarKorgonDay = bazarKorgonStore.subscribe;
export const saveBazarKorgonRows = bazarKorgonStore.saveRows;
export const setBazarKorgonSubmitted = bazarKorgonStore.setSubmitted;

const oshStore = makeRegionStore("shipments_osh", OSH_WAREHOUSE_IDS);
export const emptyOshDay = oshStore.empty;
export const subscribeToOshDay = oshStore.subscribe;
export const saveOshRows = oshStore.saveRows;
export const setOshSubmitted = oshStore.setSubmitted;

// вкладка «Транзиты»: Транзит Юг и Транзит Север → Базар-Коргон / Ош, отдельные коллекции
const transitBkStore = makeRegionStore("shipments_transit_bk", TRANSIT_WAREHOUSE_IDS);
export const emptyTransitBkDay = transitBkStore.empty;
export const subscribeToTransitBkDay = transitBkStore.subscribe;
export const saveTransitBkRows = transitBkStore.saveRows;
export const setTransitBkSubmitted = transitBkStore.setSubmitted;

const transitOshStore = makeRegionStore("shipments_transit_osh", TRANSIT_WAREHOUSE_IDS);
export const emptyTransitOshDay = transitOshStore.empty;
export const subscribeToTransitOshDay = transitOshStore.subscribe;
export const saveTransitOshRows = transitOshStore.saveRows;
export const setTransitOshSubmitted = transitOshStore.setSubmitted;

// Возвраты (общий контур): отдельная коллекция shipments_returns
const returnsStore = makeRegionStore("shipments_returns", ["returns"]);
export const emptyReturnsDay = returnsStore.empty;
export const subscribeToReturnsDay = returnsStore.subscribe;
export const saveReturnsRows = returnsStore.saveRows;
export const setReturnsSubmitted = returnsStore.setSubmitted;

// Север: 3 склада с обычной формой + РЦ Жашылча (Молоко и СОФ) со строками из файла 1С
export const SEVER_ZH_KEYS = ["zh_milk", "zh_sof"];
const severStore = makeRegionStore("shipments_sever", SEVER_WAREHOUSE_IDS, SEVER_ZH_KEYS);
export const emptySeverDay = severStore.empty;
export const subscribeToSeverDay = severStore.subscribe;
export const saveSeverRows = severStore.saveRows;
export const setSeverSubmitted = severStore.setSubmitted;

// ---------------------------------------------------------------------------
// Холод Юг — коллекция shipments_holod_yug/{YYYY-MM-DD}, где дата — ДАТА ОТГРУЗКИ
// (понедельник, среда или суббота). Внутри склады:
//   sagadalieva_zamorozka, hlebzavod, kkcp — строки как у обычных складов (makeEmptyRow),
//   zhashylcha            — строки из файла 1С: номер, магазин, вес, объём,
//   transit_yug           — вручную: номер, магазин, вес, товарная группа.
// Данные копятся до дня отгрузки: на каждую дату отгрузки — свой документ.
// ---------------------------------------------------------------------------

export const HOLOD_YUG_KEYS = ["sagadalieva_zamorozka", "zhashylcha", "transit_yug", "hlebzavod", "kkcp"];

export const makeEmptyYugRow = () => ({
  id: uid(), order: "", store: "", rawStore: "", weight: "", volume: "", boxes: "", category: "",
});

// склады с обычной формой заказов (как на основных вкладках): Садыгалиева (заморозка), Хлебзавод, ККЦП
const YUG_PLAIN_KEYS = ["sagadalieva_zamorozka", "hlebzavod", "kkcp"];
const emptyYugRowsFor = (key) => [YUG_PLAIN_KEYS.includes(key) ? makeEmptyRow() : makeEmptyYugRow()];

export const emptyHolodYugDay = () => {
  const day = {};
  HOLOD_YUG_KEYS.forEach((key) => {
    day[`rows_${key}`] = emptyYugRowsFor(key);
    day[`submitted_${key}`] = false;
  });
  return day;
};

const holodYugRef = (date) => doc(db, "shipments_holod_yug", date);

export function subscribeToHolodYugDay(date, onChange, onError) {
  return onSnapshot(
    holodYugRef(date),
    (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        // досоздаём только недостающие поля, существующие данные не трогаем
        const patch = {};
        HOLOD_YUG_KEYS.forEach((key) => {
          if (!Array.isArray(data[`rows_${key}`])) patch[`rows_${key}`] = emptyYugRowsFor(key);
          if (typeof data[`submitted_${key}`] !== "boolean") patch[`submitted_${key}`] = false;
        });
        if (Object.keys(patch).length > 0) {
          setDoc(holodYugRef(date), patch, { merge: true }).catch((err) =>
            console.error("[dayStore] holod_yug backfill failed for", date, err)
          );
          onChange({ ...data, ...patch });
        } else {
          onChange(data);
        }
      } else {
        const seed = emptyHolodYugDay();
        seedIfMissing(holodYugRef(date), seed);
        onChange(seed);
      }
    },
    (err) => onError && onError(err)
  );
}

export async function saveHolodYugRows(date, key, rows) {
  try {
    await setDoc(holodYugRef(date), { [`rows_${key}`]: rows }, { merge: true });
  } catch (err) {
    console.error("[dayStore] saveHolodYugRows failed", { date, key }, err);
    throw err;
  }
}

export async function setHolodYugSubmitted(date, key, value) {
  try {
    await setDoc(holodYugRef(date), { [`submitted_${key}`]: value }, { merge: true });
  } catch (err) {
    console.error("[dayStore] setHolodYugSubmitted failed", { date, key, value }, err);
    throw err;
  }
}


// ---------------------------------------------------------------------------
// Разрешения ОТЛ на подачу после срока (23:30 накануне).
// Один служебный документ shipments/_unlocks; ключ: «<вкладка>__<дата>__<склад>» → true.
// Лежит в уже открытой коллекции shipments, новые правила Firestore не нужны.
// ---------------------------------------------------------------------------
const unlocksRef = () => doc(db, "shipments", "_unlocks");
export const unlockKey = (scope, date, whId) => `${scope}__${date}__${whId}`.replace(/\./g, "_");

export function subscribeToUnlocks(onChange, onError) {
  return onSnapshot(
    unlocksRef(),
    (snap) => onChange(snap.exists() ? snap.data() : {}),
    (err) => onError && onError(err)
  );
}

export async function setUnlockFlag(key, value) {
  try {
    await setDoc(unlocksRef(), { [key]: value }, { merge: true });
  } catch (err) {
    console.error("[dayStore] setUnlockFlag failed", { key, value }, err);
    throw err;
  }
}
