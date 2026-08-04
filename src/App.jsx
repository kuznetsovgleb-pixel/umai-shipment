import React from "react";
import ShipmentApp from "./components/ShipmentApp";

// Без авторизации: страница открыта по ссылке всем, у кого она есть.
// Все данные общие — см. предупреждение в шапке интерфейса и README.
export default function App() {
  return <ShipmentApp />;
}
