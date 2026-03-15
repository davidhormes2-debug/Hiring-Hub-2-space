import { db } from "./db";
import { trainingSessions, users, trainerWeeklyAvailability } from "@shared/schema";
import { eq, sql, and, lt } from "drizzle-orm";
import { logger } from "./logger";

let sessionInterval: ReturnType<typeof setInterval> | null = null;

const DEFAULT_SLOTS = [
  { startHour: 10, startMinute: 0, timezone: "UTC", slotIndex: "1" },
  { startHour: 13, startMinute: 0, timezone: "UTC", slotIndex: "2" },
  { startHour: 16, startMinute: 0, timezone: "UTC", slotIndex: "3" },
  { startHour: 15, startMinute: 0, timezone: "EST", slotIndex: "4" },
  { startHour: 18, startMinute: 0, timezone: "EST", slotIndex: "5" },
];

function getUtcOffsetHours(timezone: string): number {
  if (timezone === "EST") return 5;
  return 0;
}

const DAYS_OF_WEEK = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const DEFAULT_ACTIVE_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function getDayName(date: Date): string {
  return DAYS_OF_WEEK[date.getUTCDay()];
}

export async function runDailySessionMaintenance(): Promise<{
  archived: number;
  created: number;
  closedFuture: number;
  completedTraining: number;
}> {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const tomorrowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  const todayDayName = getDayName(now);

  let archived = 0;
  let created = 0;
  let closedFuture = 0;
  let completedTraining = 0;

  await db.transaction(async (tx) => {
    const archiveResult = await tx.update(trainingSessions)
      .set({ isArchived: "true", archivedAt: now })
      .where(
        and(
          sql`(${trainingSessions.startTime} + (CAST(${trainingSessions.durationMinutes} AS integer) || ' minutes')::interval) < ${now}`,
          sql`(${trainingSessions.isArchived} = 'false' OR ${trainingSessions.isArchived} IS NULL)`
        )
      )
      .returning();
    archived = archiveResult.length;

    if (archiveResult.length > 0) {
      completedTraining = 0;
    }

    closedFuture = 0;

    const trainers = await tx.select().from(users).where(eq(users.role, "trainer"));

    for (const trainer of trainers) {
      const existingToday = await tx.select().from(trainingSessions).where(
        and(
          eq(trainingSessions.trainerId, trainer.id),
          sql`${trainingSessions.startTime} >= ${todayStart}`,
          sql`${trainingSessions.startTime} < ${tomorrowStart}`,
          sql`(${trainingSessions.isArchived} = 'false' OR ${trainingSessions.isArchived} IS NULL)`
        )
      );

      if (existingToday.length > 0) continue;

      const customSlots = await tx.select().from(trainerWeeklyAvailability).where(
        and(
          eq(trainerWeeklyAvailability.trainerId, trainer.id),
          eq(trainerWeeklyAvailability.dayOfWeek, todayDayName as any),
          eq(trainerWeeklyAvailability.isActive, "true")
        )
      );

      if (customSlots.length > 0) {
        for (const slot of customSlots) {
          const [hours, minutes] = slot.startTime.split(":").map(Number);
          const sessionStart = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
            hours, minutes, 0
          ));

          if (sessionStart > now || (sessionStart.getTime() + parseInt(slot.durationMinutes) * 60000) > now.getTime()) {
            await tx.insert(trainingSessions).values({
              trainerId: trainer.id,
              startTime: sessionStart,
              durationMinutes: slot.durationMinutes,
              maxAttendees: slot.maxAttendees,
              status: "open",
              isArchived: "false",
            });
            created++;
          }
        }
      } else {
        if (!DEFAULT_ACTIVE_DAYS.includes(todayDayName)) continue;

        for (const slot of DEFAULT_SLOTS) {
          const sessionStart = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
            slot.startHour, slot.startMinute, 0
          ));

          if (sessionStart > now || (sessionStart.getTime() + 120 * 60000) > now.getTime()) {
            await tx.insert(trainingSessions).values({
              trainerId: trainer.id,
              startTime: sessionStart,
              durationMinutes: "120",
              maxAttendees: "5",
              status: "open",
              isArchived: "false",
            });
            created++;
          }
        }
      }
    }
  });

  logger.info("Daily session maintenance completed", { archived, created, closedFuture, completedTraining });
  return { archived, created, closedFuture, completedTraining };
}

export function startSessionScheduler(): void {
  if (sessionInterval) {
    clearInterval(sessionInterval);
  }

  logger.info("Starting daily session scheduler");

  runDailySessionMaintenance()
    .then(result => logger.info("Initial session maintenance", result))
    .catch(err => logger.error("Initial session maintenance failed", err));

  sessionInterval = setInterval(async () => {
    try {
      const result = await runDailySessionMaintenance();
      if (result.archived > 0 || result.created > 0 || result.closedFuture > 0 || result.completedTraining > 0) {
        logger.info("Session maintenance completed", result);
      }
    } catch (err) {
      logger.error("Session scheduler error", err);
    }
  }, 15 * 60 * 1000);
}

export function stopSessionScheduler(): void {
  if (sessionInterval) {
    clearInterval(sessionInterval);
    sessionInterval = null;
    logger.info("Session scheduler stopped");
  }
}
