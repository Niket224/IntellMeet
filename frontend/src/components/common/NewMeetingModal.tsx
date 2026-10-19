
import { useState } from "react";
import { X, Video, Copy, Check } from "lucide-react";

type Props = {
  onClose: () => void;
};

export default function NewMeetingModal({ onClose }: Props) {
  const [title, setTitle] = useState("");
  const [meetingType, setMeetingType] = useState("Instant meeting");
  const [meetingLink, setMeetingLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  function createMeeting(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!title.trim()) {
      setError("Please enter a meeting title.");
      return;
    }

    const meetingId = crypto.randomUUID().slice(0, 8);
    const link = `${window.location.origin}/meeting/${meetingId}`;

    setMeetingLink(link);
    setError("");
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(meetingLink);
      setCopied(true);
    } catch {
      setError("Unable to copy automatically. Please copy the link manually.");
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <section
        className="meeting-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="meeting-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title-icon">
            <Video size={22} />
          </div>

          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
        </div>

        <h2 id="meeting-modal-title">Create a new meeting</h2>
        <p className="modal-description">
          Set up a meeting and share its link with your team.
        </p>

        {!meetingLink ? (
          <form onSubmit={createMeeting}>
            <label className="form-label" htmlFor="meeting-title">
              Meeting title
            </label>
            <input
              id="meeting-title"
              className="form-input"
              placeholder="e.g. Weekly Team Sync"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
            />

            <label className="form-label" htmlFor="meeting-type">
              Meeting type
            </label>
            <select
              id="meeting-type"
              className="form-input"
              value={meetingType}
              onChange={(event) => setMeetingType(event.target.value)}
            >
              <option>Instant meeting</option>
              <option>Team meeting</option>
              <option>Project discussion</option>
            </select>

            {error && <p className="form-error">{error}</p>}

            <button className="primary-button modal-submit" type="submit">
              <Video size={18} />
              Create meeting
            </button>
          </form>
        ) : (
          <div className="meeting-created">
            <div className="success-icon">
              <Check size={24} />
            </div>

            <h3>Meeting created!</h3>
            <p>
              {title.trim()} · {meetingType}
            </p>

            <label className="form-label" htmlFor="meeting-link">
              Meeting link
            </label>
            <input
              id="meeting-link"
              className="form-input"
              value={meetingLink}
              readOnly
              onFocus={(event) => event.target.select()}
            />

            {error && <p className="form-error">{error}</p>}

            <button
              type="button"
              className="primary-button modal-submit"
              onClick={copyLink}
            >
              {copied ? <Check size={18} /> : <Copy size={18} />}
              {copied ? "Copied!" : "Copy meeting link"}
            </button>

            <button
              type="button"
              className="secondary-button modal-submit"
              onClick={onClose}
            >
              Done
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
