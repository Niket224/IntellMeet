
import { useContext } from "react";
import { MeetingContext } from "../context/MeetingContext";

export default function useMeetings() {
  const context = useContext(MeetingContext);

  if (!context) {
    throw new Error("useMeetings must be used within MeetingProvider");
  }

  return context;
}
