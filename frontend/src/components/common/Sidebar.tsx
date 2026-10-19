
import { useState } from "react";
import NewMeetingModal from "./NewMeetingModal";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Video,
  Users,
  CheckSquare,
  Bell,
  Settings,
  History,
  Plus,
} from "lucide-react";

const menuItems = [
  { name: "Dashboard", path: "/dashboard", icon: LayoutDashboard },
  { name: "Meetings", path: "/meetings", icon: Video },
  { name: "Workspace", path: "/workspace", icon: Users },
  { name: "Tasks", path: "/tasks", icon: CheckSquare },
  { name: "History", path: "/history", icon: History },
  { name: "Notifications", path: "/notifications", icon: Bell },
  { name: "Settings", path: "/settings", icon: Settings },
];

export default function Sidebar() {
    const [showMeetingModal, setShowMeetingModal] = useState(false);
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-icon">I</div>
        <span>IntelMeet</span>
      </div>

      <button
  className="new-meeting"
  onClick={() => setShowMeetingModal(true)}
>
  <Plus size={18} />
  New Meeting
</button>

      <p className="menu-label">MENU</p>

      <nav className="sidebar-nav">
        {menuItems.map(({ name, path, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) =>
              `nav-link ${isActive ? "active" : ""}`
            }
          >
            <Icon size={19} />
            <span>{name}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-bottom">
        <div className="profile-avatar">U</div>
        <div>
          <strong>Your Profile</strong>
          <p>Team Member</p>
        </div>
      </div>
      {showMeetingModal && (
  <NewMeetingModal
    onClose={() => setShowMeetingModal(false)}
  />
)}
    </aside>
  );
}
