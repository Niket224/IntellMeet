
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  CalendarDays,
  Clock3,
  Search,
  Users,
  Video,
  ArrowUpRight,
} from "lucide-react";
import { useMeetings, type Meeting } from "../context/MeetingContext";

export default function MeetingsPage() {
  const navigate = useNavigate();
  const { meetings } = useMeetings();
  const [search, setSearch] = useState("");

  const filteredMeetings = useMemo(() => {
    return meetings.filter((meeting: Meeting) =>
      meeting.title.toLowerCase().includes(search.toLowerCase())
    );
  }, [meetings, search]);

  return (
    <main className="all-meetings-page">
      <button
        className="meetings-back-button"
        onClick={() => navigate("/dashboard")}
      >
        <ArrowLeft size={17} />
        Back to Dashboard
      </button>

      <section className="all-meetings-heading">
        <div>
          <span className="meetings-eyebrow">YOUR WORKSPACE</span>
          <h1>All Meetings</h1>
          <p>View, manage, and join your team's meetings.</p>
        </div>

        <div className="meetings-heading-icon">
          <Video size={25} />
        </div>
      </section>

      <section className="meetings-toolbar">
        <div className="meetings-search">
          <Search size={19} />
          <input
            type="search"
            placeholder="Search meetings by title..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search meetings"
          />
        </div>

        <span className="meeting-count">
          {filteredMeetings.length}{" "}
          {filteredMeetings.length === 1 ? "meeting" : "meetings"}
        </span>
      </section>

      {filteredMeetings.length > 0 ? (
        <section className="all-meetings-grid">
          {filteredMeetings.map((meeting) => (
            <article className="all-meeting-card" key={meeting.id}>
              <div className="all-meeting-card-top">
                <div className="all-meeting-icon">
                  <CalendarDays size={22} />
                </div>

                <span className="meeting-status">
                  <span className="status-dot" />
                  Scheduled
                </span>
              </div>

              <h2>{meeting.title}</h2>

              <p className="all-meeting-type">
                {meeting.type || "Team meeting"}
              </p>

              <div className="all-meeting-meta">
                <span>
                  <Clock3 size={16} />
                  {meeting.createdAt
                    ? new Date(meeting.createdAt).toLocaleDateString()
                    : "Date not set"}
                </span>

                <span>
                  <Users size={16} />
                  Meeting room
                </span>
              </div>

              <button
                className="all-meeting-view-button"
                onClick={() => navigate(`/meetings/${meeting.id}`)}
              >
                View meeting
                <ArrowUpRight size={17} />
              </button>
            </article>
          ))}
        </section>
      ) : (
        <section className="meetings-empty-state">
          <div className="empty-meetings-icon">
            <Search size={26} />
          </div>

          <h2>
            {search ? "No matching meetings" : "No meetings yet"}
          </h2>

          <p>
            {search
              ? "Try a different search term."
              : "Create a new meeting to get started with your team."}
          </p>

          {search && (
            <button
              className="clear-meetings-search"
              onClick={() => setSearch("")}
            >
              Clear search
            </button>
          )}
        </section>
      )}
    </main>
  );
}
