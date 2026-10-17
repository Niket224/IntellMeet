
import {
  CalendarDays,
  Clock3,
  Users,
  Video,
  ArrowUpRight,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useMeetings } from "../context/MeetingContext";

const stats = [
  {
    title: "Total Meetings",
    value: "24",
    detail: "Meetings this month",
    icon: Video,
  },
  {
    title: "Hours in Meetings",
    value: "18.5",
    detail: "Hours this month",
    icon: Clock3,
  },
  {
    title: "Team Members",
    value: "12",
    detail: "In your workspace",
    icon: Users,
  },
];

export default function DashboardPage() {
  const navigate = useNavigate();
  const { meetings } = useMeetings();

  // Display created meetings first, followed by the sample meetings.
  const sampleMeetings = [
    {
      id: "weekly-team-sync",
      title: "Weekly Team Sync",
      time: "10:00 AM",
      date: "Today",
      members: "6 participants",
    },
    {
      id: "project-planning",
      title: "Project Planning",
      time: "2:30 PM",
      date: "Today",
      members: "4 participants",
    },
    {
      id: "design-review",
      title: "Design Review",
      time: "11:00 AM",
      date: "Tomorrow",
      members: "5 participants",
    },
  ];

  const upcomingMeetings = [
    ...meetings.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      time: new Date(meeting.createdAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      date: "Created meeting",
      members: meeting.type,
    })),
    ...sampleMeetings,
  ];

  return (
    <div className="dashboard">
      <section className="dashboard-heading">
        <div>
          <h1>Dashboard</h1>
          <p>Manage your meetings and collaborate with your team.</p>
        </div>

        <button
          className="primary-button"
          onClick={() => {
            window.dispatchEvent(new Event("open-new-meeting-modal"));
          }}
        >
          <Video size={18} />
          Start a Meeting
        </button>
      </section>

      <section className="stats-grid">
        {stats.map(({ title, value, detail, icon: Icon }) => (
          <article className="stat-card" key={title}>
            <div className="stat-top">
              <span>{title}</span>
              <Icon size={21} />
            </div>
            <h2>{title === "Total Meetings" ? 24 + meetings.length : value}</h2>
            <p>{detail}</p>
          </article>
        ))}
      </section>

      <section className="meetings-section">
        <div className="section-heading">
          <div>
            <h2>Upcoming Meetings</h2>
            <p>Stay prepared for your next collaboration.</p>
          </div>

          <button
            className="text-button"
            onClick={() => navigate("/meetings")}
          >
            View all <ArrowUpRight size={16} />
          </button>
        </div>

        <div className="meeting-list">
          {upcomingMeetings.map((meeting) => (
            <article className="meeting-card" key={meeting.id}>
              <div className="meeting-icon">
                <CalendarDays size={22} />
              </div>

              <div className="meeting-info">
                <h3>{meeting.title}</h3>
                <p>
                  {meeting.date} · {meeting.time}
                </p>
              </div>

              <span className="meeting-members">
                <Users size={15} />
                {meeting.members}
              </span>

              <button
                className="join-button"
                onClick={() => navigate(`/meetings/${meeting.id}`)}
              >
                View
              </button>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
