
import { Bell, Search, HelpCircle } from "lucide-react";

export default function Navbar() {
  return (
    <header className="topbar">
      <div>
        <h2>Welcome back!</h2>
        <p>Here's what's happening with your meetings.</p>
      </div>

      <div className="topbar-actions">
        <label className="search-box">
          <Search size={18} />
          <input placeholder="Search anything..." />
        </label>

        <button className="topbar-icon" aria-label="Help">
          <HelpCircle size={20} />
        </button>

        <button className="topbar-icon" aria-label="Notifications">
          <Bell size={20} />
          <span className="notification-dot" />
        </button>
      </div>
    </header>
  );
}
