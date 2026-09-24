import { doc, onSnapshot, setDoc, getDoc } from "firebase/firestore";
import { db } from "../firebase";
import { VEHICLES_TEMPLATE, ZHASHYLCHA_VEHICLES_TEMPLATE } from "../data/reference";

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
  rows_transit_yug: [makeEmptyRow()],
  rows_transit_sever: [makeEmptyRow()],
  submitted_prigorodnoe: false,
  submitted_argo: false,
  submitted_pto: false,
  submitted_sagadalieva: false,
  submitted_sagadalieva_zamorozka: false,
  submitted_hlebzavod: false,
  submitted_kkcp: false,
  submitted_transit_yug: false,
  submitted_transit_sever: false,
  vehicles: seedVehiclesForDay(),
});

const dayRef = (date) => doc(db, "shipments", date);

export function subscribeToDay(date, onChange, onError) {
  return onSnapshot(
    dayRef(date),
    (snap) => {
      if (snap.exists()) {
        onChange(snap.data());
      } else {
        const seed = emptyDay();
        // merge:true — на случай, если два клиента одновременно откроют
        // новый день, вторая запись не затрёт первую, а сольётся с ней.
        setDoc(dayRef(date), seed, { merge: true }).catch((err) =>
          console.error("[dayStore] seed creation failed for", date, err)
        );
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
// Жашылча (ночь) — полностью отдельный контур: своя коллекция в Firestore,
// свой список машин, всегда привязан к сегодняшней дате (заказы день в день)
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
  vehicles: seedZhashylchaVehicles(),
});

const zhashylchaRef = (date) => doc(db, "shipments_zhashylcha", date);

export function subscribeToZhashylchaDay(date, onChange, onError) {
  return onSnapshot(
    zhashylchaRef(date),
    (snap) => {
      if (snap.exists()) {
        onChange(snap.data());
      } else {
        const seed = emptyZhashylchaDay();
        setDoc(zhashylchaRef(date), seed, { merge: true }).catch((err) =>
          console.error("[dayStore] zhashylcha seed creation failed for", date, err)
        );
        onChange(seed);
      }
    },
    (err) => onError && onError(err)
  );
}

export async function saveZhashylchaRows(date, rows) {
  try {
    await setDoc(zhashylchaRef(date), { rows }, { merge: true });
  } catch (err) {
    console.error("[dayStore] saveZhashylchaRows failed", { date }, err);
    throw err;
  }
}

export async function setZhashylchaSubmitted(date, value) {
  try {
    await setDoc(zhashylchaRef(date), { submitted: value }, { merge: true });
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
