
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from "react-router-dom";

import { MeetingProvider } from "./context/MeetingContext";
import DashboardLayout from "./layouts/DashboardLayout";
import DashboardPage from "./pages/DashboardPage";
import MeetingsPage from "./pages/MeetingsPage";
import MeetingDetailsPage from "./pages/MeetingDetailsPage";

function PlaceholderPage({ title }: { title: string }) {
  return (
    <main style={{ padding: "24px" }}>
      <h1>{title}</h1>
      <p>Welcome to IntelMeet.</p>
    </main>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <MeetingProvider>
        <Routes>
          <Route element={<DashboardLayout />}>
            <Route
              path="/"
              element={<Navigate to="/dashboard" replace />}
            />

            <Route
              path="/dashboard"
              element={<DashboardPage />}
            />

            <Route
              path="/meetings"
              element={<MeetingsPage />}
            />

            <Route
              path="/meetings/:meetingId"
              element={<MeetingDetailsPage />}
            />

            <Route
              path="/workspace"
              element={<PlaceholderPage title="Workspace" />}
            />

            <Route
              path="/tasks"
              element={<PlaceholderPage title="Tasks" />}
            />

            <Route
              path="/history"
              element={<PlaceholderPage title="History" />}
            />

            <Route
              path="/notifications"
              element={<PlaceholderPage title="Notifications" />}
            />

            <Route
              path="/settings"
              element={<PlaceholderPage title="Settings" />}
            />

            <Route
              path="*"
              element={<Navigate to="/dashboard" replace />}
            />
          </Route>
        </Routes>
      </MeetingProvider>
    </BrowserRouter>
  );
}
