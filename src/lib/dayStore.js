import { doc, onSnapshot, setDoc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
import { VEHICLES_TEMPLATE } from "../data/reference";

const uid = () => Math.random().toString(36).slice(2, 10);

export const seedVehiclesForDay = () =>
  VEHICLES_TEMPLATE.map((v) => ({
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
    custom: false,
    ready: false, // готовность подтверждается заново каждый день
  }));

export const makeEmptyRow = () => ({ id: uid(), order: "", store: "", pallets: "", rolls: "" });

export const emptyDay = () => ({
  rows_prigorodnoe: [makeEmptyRow()],
  rows_argo: [makeEmptyRow()],
  rows_pto: [makeEmptyRow()],
  rows_sagadalieva: [makeEmptyRow()],
  submitted_prigorodnoe: false,
  submitted_argo: false,
  submitted_pto: false,
  submitted_sagadalieva: false,
  vehicles: seedVehiclesForDay(),
});

const dayRef = (date) => doc(db, "shipments", date);

// подписка на документ дня в реальном времени — все, кто открыл эту дату,
// видят изменения друг друга без ручного обновления страницы
export function subscribeToDay(date, onChange, onError) {
  return onSnapshot(
    dayRef(date),
    (snap) => {
      if (snap.exists()) {
        onChange(snap.data());
      } else {
        // документа на эту дату ещё нет — создаём пустой (не блокируем чтение)
        const seed = emptyDay();
        setDoc(dayRef(date), seed).catch(() => {});
        onChange(seed);
      }
    },
    (err) => onError && onError(err)
  );
}

export async function ensureDayExists(date) {
  const snap = await getDoc(dayRef(date));
  if (!snap.exists()) {
    await setDoc(dayRef(date), emptyDay());
  }
}

// склад пишет только свои строки + свой флаг отправки (см. firestore.rules)
export async function saveWarehouseRows(date, whId, rows) {
  await updateDoc(dayRef(date), { [`rows_${whId}`]: rows });
}

export async function setSubmitted(date, whId, value) {
  await updateDoc(dayRef(date), { [`submitted_${whId}`]: value });
}

// ОТЛ пишет только машины
export async function saveVehicles(date, vehicles) {
  await updateDoc(dayRef(date), { vehicles });
}
