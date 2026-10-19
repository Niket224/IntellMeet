import { Outlet } from "react-router-dom";
import Sidebar from "../components/common/Sidebar";
import Navbar from "../components/common/Navbar";

export default function DashboardLayout() {
  return (
    <div className="app-layout">
      <Sidebar />

      <div className="main-content">
        <Navbar />
        <Outlet />
      </div>
    </div>
  );
}