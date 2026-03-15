import type { Application } from "./schema";

export interface ApplicationWithApplicant extends Omit<Application, "appliedAt" | "startTime"> {
  applicantName: string;
  applicantEmail: string;
  referredBy: string | null;
  appliedAt: Date | string;
  applicantWhatsapp?: string | null;
  applicantTelegram?: string | null;
  applicantCountry?: string | null;
  applicantExperience?: string | null;
  applicantAvailability?: string | null;
  applicantMotivation?: string | null;
  applicantLinkedin?: string | null;
  applicantGender?: string | null;
  applicantNationality?: string | null;
  applicantPhone?: string | null;
  applicantDevice?: string | null;
  applicantPreferredContact?: string | null;
  applicantHasComputerAccess?: string | null;
}

export interface TrainingSessionWithTrainer {
  id: string;
  trainerId: string;
  trainerName?: string;
  startTime: Date | string;
  durationMinutes: string;
  maxAttendees: string;
  status: "open" | "filled" | "completed";
}
