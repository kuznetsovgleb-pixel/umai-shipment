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
    ready: false,
  }));

export const makeEmptyRow = () => ({
  id: uid(), order: "", store: "",
  pallets: "", rolls: "", euro: "", american: "", boxes: "",
  weight: "",
});

export const emptyDay = () => ({
  rows_prigorodnoe: [makeEmptyRow()],
  rows_argo: [makeEmptyRow()],
  rows_pto: [makeEmptyRow()],
  rows_sagadalieva: [makeEmptyRow()],
  rows_sagadalieva_zamorozka: [makeEmptyRow()],
  rows_hlebzavod: [makeEmptyRow()],
  rows_kkcp: [makeEmptyRow()],
  submitted_prigorodnoe: false,
  submitted_argo: false,
  submitted_pto: false,
  submitted_sagadalieva: false,
  submitted_sagadalieva_zamorozka: false,
  submitted_hlebzavod: false,
  submitted_kkcp: false,
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

export async function saveWarehouseRows(date, whId, rows) {
  await updateDoc(dayRef(date), { [`rows_${whId}`]: rows });
}

export async function setSubmitted(date, whId, value) {
  await updateDoc(dayRef(date), { [`submitted_${whId}`]: value });
}

export async function saveVehicles(date, vehicles) {
  await updateDoc(dayRef(date), { vehicles });
}
