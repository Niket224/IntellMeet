
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, CalendarDays, Copy, Video } from "lucide-react";
import { useMeetings } from "../context/MeetingContext";

export default function MeetingDetailsPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const navigate = useNavigate();
  const { meetings } = useMeetings();

  const meeting = meetings.find((item) => item.id === meetingId);

  if (!meeting) {
    return (
      <main className="meeting-details">
        <h2>Meeting not found</h2>
        <p>
          This meeting is not available in your current meeting list.
        </p>
        <button
          className="meeting-view-button"
          onClick={() => navigate("/dashboard")}
        >
          Back to Dashboard
        </button>
      </main>
    );
  }

  const selectedMeeting = meeting;

  async function copyLink() {
    if (!selectedMeeting.link) {
      alert("This sample meeting does not have a shareable link.");
      return;
    }

    try {
      await navigator.clipboard.writeText(selectedMeeting.link);
      alert("Meeting link copied!");
    } catch {
      alert("Unable to copy the link. Please try again.");
    }
  }

  return (
    <main className="meeting-details">
      <button
        className="view-all-button"
        onClick={() => navigate("/dashboard")}
      >
        <ArrowLeft size={18} />
        Back to Dashboard
      </button>

      <section className="meeting-detail-card">
        <div className="meeting-icon">
          <Video size={24} />
        </div>

        <h1>{selectedMeeting.title}</h1>
        <p>{selectedMeeting.type}</p>

        <div className="meeting-detail-meta">
          <CalendarDays size={18} />
          <span>
            Created{" "}
            {new Date(selectedMeeting.createdAt).toLocaleString()}
          </span>
        </div>

        <button className="primary-button" onClick={copyLink}>
          <Copy size={18} />
          Copy Meeting Link
        </button>

        <p className="meeting-note">
          Live video and audio will be connected when the meeting service is ready.
        </p>
      </section>
    </main>
  );
}
