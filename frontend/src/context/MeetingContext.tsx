
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Meeting = {
  id: string;
  title: string;
  type: string;
  link: string;
  createdAt: string;
};

type MeetingContextType = {
  meetings: Meeting[];
  addMeeting: (title: string, type: string) => Meeting;
};

export const MeetingContext = createContext<MeetingContextType | undefined>(
  undefined
);

const sampleMeetings: Meeting[] = [
  {
    id: "sample-1",
    title: "Weekly Team Sync",
    type: "Team meeting",
    link: "",
    createdAt: new Date().toISOString(),
  },
  {
    id: "sample-2",
    title: "Project Planning",
    type: "Project discussion",
    link: "",
    createdAt: new Date().toISOString(),
  },
  {
    id: "sample-3",
    title: "Design Review",
    type: "Team meeting",
    link: "",
    createdAt: new Date().toISOString(),
  },
];

export function MeetingProvider({ children }: { children: ReactNode }) {
  const [meetings, setMeetings] = useState<Meeting[]>(() => {
    try {
      const saved = localStorage.getItem("intelmeet-meetings");
      return saved ? JSON.parse(saved) as Meeting[] : sampleMeetings;
    } catch {
      return sampleMeetings;
    }
  });

  useEffect(() => {
    localStorage.setItem("intelmeet-meetings", JSON.stringify(meetings));
  }, [meetings]);

  function addMeeting(title: string, type: string): Meeting {
    const id = crypto.randomUUID().slice(0, 8);
    const meeting: Meeting = {
      id,
      title,
      type,
      link: `${window.location.origin}/meeting/${id}`,
      createdAt: new Date().toISOString(),
    };

    setMeetings((previous) => [meeting, ...previous]);
    return meeting;
  }

  return (
    <MeetingContext.Provider value={{ meetings, addMeeting }}>
      {children}
    </MeetingContext.Provider>
  );
}

export function useMeetings() {
  const context = useContext(MeetingContext);

  if (!context) {
    throw new Error("useMeetings must be used inside MeetingProvider");
  }

  return context;
}
