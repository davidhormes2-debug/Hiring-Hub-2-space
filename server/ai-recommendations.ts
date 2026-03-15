import OpenAI from "openai";
import { storage } from "./storage";
import { logger } from "./logger";

function getOpenAIClient() {
  if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    return null;
  }
  return new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });
}

export interface ContentRecommendation {
  id: string;
  title: string;
  description: string;
  type: "article" | "video" | "template" | "tip" | "resource";
  priority: "high" | "medium" | "low";
  reason: string;
  actionUrl?: string;
  tags: string[];
}

export interface TrainerInsights {
  trainerId: string;
  recommendations: ContentRecommendation[];
  summary: string;
  performanceScore: number;
  areasToImprove: string[];
  strengths: string[];
  nextSteps: string[];
}

async function getTrainerContext(trainerId: string) {
  const [trainer, sessions, applications, materials, feedback] = await Promise.all([
    storage.getUser(trainerId),
    storage.getTrainingSessionsByTrainer(trainerId),
    storage.getAllApplications(),
    storage.getTrainingMaterialsByTrainer(trainerId),
    storage.getAllFeedback()
  ]);

  const trainerApps = applications.filter(app => app.trainerId === trainerId);
  const trainerFeedback = feedback.filter(f => f.trainerId === trainerId);
  
  const completedTrainings = trainerApps.filter(app => app.trainingStatus === "completed").length;
  const activeTrainees = trainerApps.filter(app => 
    app.trainingStatus === "scheduled" || app.trainingStatus === "confirmed"
  ).length;
  const upcomingSessions = sessions.filter(s => 
    new Date(s.startTime) > new Date() && s.status === "open"
  ).length;
  
  const avgRating = trainerFeedback.length > 0
    ? trainerFeedback.reduce((sum, f) => sum + (parseInt(f.trainerRating || "0") || 0), 0) / trainerFeedback.length
    : 0;

  return {
    trainer,
    stats: {
      totalSessions: sessions.length,
      upcomingSessions,
      completedTrainings,
      activeTrainees,
      totalMaterials: materials.length,
      avgRating,
      totalFeedback: trainerFeedback.length
    },
    recentFeedback: trainerFeedback.slice(0, 5),
    materials: materials.map(m => ({ name: m.fileName, category: m.category }))
  };
}

export async function generateTrainerRecommendations(trainerId: string): Promise<TrainerInsights> {
  const context = await getTrainerContext(trainerId);
  
  if (!context.trainer) {
    throw new Error("Trainer not found");
  }

  const prompt = `You are an AI assistant helping trainers improve their training effectiveness. Analyze this trainer's data and provide personalized recommendations.

TRAINER PROFILE:
- Name: ${context.trainer.name}
- Email: ${context.trainer.email}
- Certified: ${context.trainer.isCertified === "true" ? "Yes" : "No"}

TRAINING STATISTICS:
- Total Sessions Created: ${context.stats.totalSessions}
- Upcoming Sessions: ${context.stats.upcomingSessions}
- Completed Trainings: ${context.stats.completedTrainings}
- Active Trainees: ${context.stats.activeTrainees}
- Training Materials Uploaded: ${context.stats.totalMaterials}
- Average Rating: ${context.stats.avgRating.toFixed(1)}/5
- Total Feedback Received: ${context.stats.totalFeedback}

UPLOADED MATERIALS:
${context.materials.length > 0 ? context.materials.map(m => `- ${m.name} (${m.category})`).join("\n") : "No materials uploaded yet"}

RECENT FEEDBACK COMMENTS:
${context.recentFeedback.length > 0 ? context.recentFeedback.map(f => `- "${f.comments || 'No comment'}" (Rating: ${f.trainerRating || 'N/A'})`).join("\n") : "No feedback received yet"}

Based on this data, provide a JSON response with:
1. 5 personalized content recommendations (articles, videos, templates, tips, resources)
2. A brief summary of the trainer's current performance
3. A performance score (0-100)
4. 3 areas to improve
5. 3 strengths
6. 3 actionable next steps

Response format:
{
  "recommendations": [
    {
      "id": "rec_1",
      "title": "Recommendation title",
      "description": "Brief description of the recommendation",
      "type": "article|video|template|tip|resource",
      "priority": "high|medium|low",
      "reason": "Why this is recommended for this trainer",
      "tags": ["tag1", "tag2"]
    }
  ],
  "summary": "Brief performance summary",
  "performanceScore": 75,
  "areasToImprove": ["area1", "area2", "area3"],
  "strengths": ["strength1", "strength2", "strength3"],
  "nextSteps": ["step1", "step2", "step3"]
}`;

  try {
    const client = getOpenAIClient();
    if (!client) throw new Error("OpenAI not configured");
    const response = await client.chat.completions.create({
      model: "gpt-5-nano",
      messages: [
        { 
          role: "system", 
          content: "You are a training coach AI. Respond with valid JSON only."
        },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 1200
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No response from AI");
    }

    const parsed = JSON.parse(content);
    
    return {
      trainerId,
      recommendations: parsed.recommendations || [],
      summary: parsed.summary || "Unable to generate summary",
      performanceScore: parsed.performanceScore || 50,
      areasToImprove: parsed.areasToImprove || [],
      strengths: parsed.strengths || [],
      nextSteps: parsed.nextSteps || []
    };
  } catch (error) {
    logger.error("Error generating recommendations", error, { trainerId });
    return {
      trainerId,
      recommendations: [
        {
          id: "rec_default_1",
          title: "Upload Training Materials",
          description: "Add PDFs, documents, or videos to help your trainees prepare",
          type: "tip",
          priority: "high",
          reason: "Having materials ready improves trainee preparation",
          tags: ["materials", "preparation"]
        },
        {
          id: "rec_default_2",
          title: "Schedule Regular Sessions",
          description: "Create consistent weekly training slots to accommodate more trainees",
          type: "tip",
          priority: "medium",
          reason: "Regular availability helps trainees plan ahead",
          tags: ["scheduling", "availability"]
        },
        {
          id: "rec_default_3",
          title: "Request Feedback",
          description: "Ask trainees to rate their experience after each session",
          type: "tip",
          priority: "medium",
          reason: "Feedback helps you continuously improve",
          tags: ["feedback", "improvement"]
        }
      ],
      summary: "Continue building your training profile by adding materials and scheduling sessions.",
      performanceScore: 50,
      areasToImprove: ["Add more training materials", "Schedule more sessions", "Collect trainee feedback"],
      strengths: ["Active trainer account", "Platform access", "Ready to train"],
      nextSteps: ["Upload your first training material", "Create a weekly training slot", "Complete a training session"]
    };
  }
}

export async function getQuickTip(trainerId: string): Promise<{ tip: string; category: string }> {
  const context = await getTrainerContext(trainerId);
  
  const prompt = `Based on this trainer's stats, give ONE quick actionable tip in 1-2 sentences.
Stats: ${context.stats.upcomingSessions} upcoming sessions, ${context.stats.completedTrainings} completed trainings, ${context.stats.totalMaterials} materials uploaded, ${context.stats.avgRating.toFixed(1)} avg rating.
Respond with JSON: {"tip": "your tip here", "category": "scheduling|materials|engagement|feedback|growth"}`;

  try {
    const client = getOpenAIClient();
    if (!client) throw new Error("OpenAI not configured");
    const response = await client.chat.completions.create({
      model: "gpt-5-nano",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_completion_tokens: 150
    });

    const content = response.choices[0]?.message?.content;
    return content ? JSON.parse(content) : { tip: "Keep up the great work!", category: "growth" };
  } catch {
    return { tip: "Schedule your next training session to keep momentum going!", category: "scheduling" };
  }
}

export interface AdminInsights {
  recommendations: ContentRecommendation[];
  summary: string;
  platformHealthScore: number;
  keyMetrics: {
    totalApplications: number;
    pendingReview: number;
    completedTrainings: number;
    activeTrainers: number;
    avgTrainerRating: number;
  };
  alerts: string[];
  opportunities: string[];
  actionItems: string[];
}

async function getAdminContext() {
  const [applications, users, sessions, feedback] = await Promise.all([
    storage.getAllApplications(),
    storage.getAllUsers(),
    storage.getAllTrainingSessions(),
    storage.getAllFeedback()
  ]);

  const trainers = users.filter(u => u.role === "trainer");
  const applicants = users.filter(u => u.role === "applicant");
  const pendingReview = applications.filter(a => a.status === "under_review").length;
  const accepted = applications.filter(a => a.status === "accepted").length;
  const rejected = applications.filter(a => a.status === "rejected").length;
  const completedTrainings = applications.filter(a => a.trainingStatus === "completed").length;
  const activeTrainees = applications.filter(a => 
    a.trainingStatus === "scheduled" || a.trainingStatus === "confirmed"
  ).length;
  
  const avgTrainerRating = feedback.length > 0
    ? feedback.reduce((sum, f) => sum + (parseInt(f.trainerRating || "0") || 0), 0) / feedback.length
    : 0;
  
  const upcomingSessions = sessions.filter(s => 
    new Date(s.startTime) > new Date() && s.status === "open"
  ).length;

  return {
    stats: {
      totalApplications: applications.length,
      pendingReview,
      accepted,
      rejected,
      completedTrainings,
      activeTrainees,
      totalTrainers: trainers.length,
      certifiedTrainers: trainers.filter(t => t.isCertified === "true").length,
      totalApplicants: applicants.length,
      upcomingSessions,
      avgTrainerRating,
      totalFeedback: feedback.length
    },
    recentApplications: applications.slice(-10).reverse(),
    recentFeedback: feedback.slice(-5)
  };
}

export async function generateAdminInsights(): Promise<AdminInsights> {
  const context = await getAdminContext();

  const prompt = `You are an AI assistant helping platform administrators optimize their recruitment and training operations. Analyze this platform data and provide actionable insights.

PLATFORM STATISTICS:
- Total Applications: ${context.stats.totalApplications}
- Pending Review: ${context.stats.pendingReview}
- Accepted: ${context.stats.accepted}
- Rejected: ${context.stats.rejected}
- Completed Trainings: ${context.stats.completedTrainings}
- Active Trainees: ${context.stats.activeTrainees}
- Total Trainers: ${context.stats.totalTrainers}
- Certified Trainers: ${context.stats.certifiedTrainers}
- Upcoming Sessions: ${context.stats.upcomingSessions}
- Average Trainer Rating: ${context.stats.avgTrainerRating.toFixed(1)}/5
- Total Feedback: ${context.stats.totalFeedback}

RECENT FEEDBACK:
${context.recentFeedback.map(f => `- Rating: ${f.rating || 'N/A'}/5, Trainer: ${f.trainerRating || 'N/A'}/5 - "${f.comments || 'No comment'}"`).join("\n") || "No recent feedback"}

Based on this data, provide a JSON response with:
1. 5 strategic recommendations for improving platform operations
2. A brief summary of platform health
3. A platform health score (0-100)
4. 3 alerts or issues requiring attention
5. 3 growth opportunities
6. 3 immediate action items

Response format:
{
  "recommendations": [
    {
      "id": "rec_1",
      "title": "Recommendation title",
      "description": "Brief description",
      "type": "article|video|template|tip|resource",
      "priority": "high|medium|low",
      "reason": "Why this is important",
      "tags": ["tag1", "tag2"]
    }
  ],
  "summary": "Brief platform health summary",
  "platformHealthScore": 75,
  "alerts": ["alert1", "alert2", "alert3"],
  "opportunities": ["opportunity1", "opportunity2", "opportunity3"],
  "actionItems": ["action1", "action2", "action3"]
}`;

  try {
    const client = getOpenAIClient();
    if (!client) throw new Error("OpenAI not configured");
    const response = await client.chat.completions.create({
      model: "gpt-5-nano",
      messages: [
        { 
          role: "system", 
          content: "You are a platform operations AI. Respond with valid JSON only."
        },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 1200
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("No response from AI");

    const parsed = JSON.parse(content);
    
    return {
      recommendations: parsed.recommendations || [],
      summary: parsed.summary || "Platform analysis unavailable",
      platformHealthScore: parsed.platformHealthScore || 50,
      keyMetrics: {
        totalApplications: context.stats.totalApplications,
        pendingReview: context.stats.pendingReview,
        completedTrainings: context.stats.completedTrainings,
        activeTrainers: context.stats.totalTrainers,
        avgTrainerRating: context.stats.avgTrainerRating
      },
      alerts: parsed.alerts || [],
      opportunities: parsed.opportunities || [],
      actionItems: parsed.actionItems || []
    };
  } catch (error) {
    logger.error("Error generating admin insights", error);
    
    // Generate intelligent fallback based on actual data
    const alerts: string[] = [];
    const opportunities: string[] = [];
    const actionItems: string[] = [];
    const recommendations: ContentRecommendation[] = [];
    
    // Data-driven alerts
    if (context.stats.pendingReview > 0) {
      alerts.push(`${context.stats.pendingReview} application(s) awaiting review`);
      actionItems.push(`Review ${context.stats.pendingReview} pending application(s)`);
      recommendations.push({
        id: "rec_pending",
        title: "Review Pending Applications",
        description: "Clear the backlog of pending applications to improve response times",
        type: "tip",
        priority: "high",
        reason: "Fast response times improve applicant experience",
        tags: ["applications", "efficiency"]
      });
    }
    
    if (context.stats.activeTrainees > 0 && context.stats.upcomingSessions === 0) {
      alerts.push("No upcoming training sessions scheduled");
      actionItems.push("Schedule training sessions for active trainees");
    }
    
    if (context.stats.totalTrainers === 0) {
      alerts.push("No trainers available on the platform");
    } else if (context.stats.certifiedTrainers === 0) {
      alerts.push("No certified trainers available");
    }
    
    if (context.stats.totalFeedback === 0 && context.stats.completedTrainings > 0) {
      opportunities.push("Collect feedback from completed trainings");
    }
    
    // Data-driven opportunities
    if (context.stats.totalTrainers < 3) {
      opportunities.push("Expand trainer network for better coverage");
    }
    if (context.stats.upcomingSessions > 0) {
      opportunities.push(`${context.stats.upcomingSessions} training session(s) scheduled`);
    }
    if (context.stats.completedTrainings > 0) {
      opportunities.push(`${context.stats.completedTrainings} training(s) completed successfully`);
    }
    
    // Fill with defaults if empty
    if (alerts.length === 0) alerts.push("No critical issues detected");
    if (opportunities.length === 0) opportunities.push("Platform running smoothly");
    if (actionItems.length === 0) actionItems.push("Continue monitoring platform performance");
    
    // Calculate health score based on data
    let healthScore = 70;
    if (context.stats.pendingReview > 5) healthScore -= 15;
    else if (context.stats.pendingReview > 0) healthScore -= 5;
    if (context.stats.totalTrainers > 0) healthScore += 10;
    if (context.stats.completedTrainings > 0) healthScore += 10;
    if (context.stats.avgTrainerRating >= 4) healthScore += 10;
    healthScore = Math.min(100, Math.max(0, healthScore));
    
    // Generate summary based on state
    let summary = "Platform is operational.";
    if (context.stats.pendingReview > 0) {
      summary += ` ${context.stats.pendingReview} application(s) need review.`;
    }
    if (context.stats.upcomingSessions > 0) {
      summary += ` ${context.stats.upcomingSessions} training session(s) upcoming.`;
    }
    if (context.stats.completedTrainings > 0) {
      summary += ` ${context.stats.completedTrainings} training(s) completed.`;
    }
    
    return {
      recommendations: recommendations.length > 0 ? recommendations : [{
        id: "rec_default",
        title: "Keep Up the Good Work",
        description: "Continue monitoring platform performance and engaging with applicants",
        type: "tip",
        priority: "low",
        reason: "Consistent engagement improves platform success",
        tags: ["general", "maintenance"]
      }],
      summary,
      platformHealthScore: healthScore,
      keyMetrics: {
        totalApplications: context.stats.totalApplications,
        pendingReview: context.stats.pendingReview,
        completedTrainings: context.stats.completedTrainings,
        activeTrainers: context.stats.totalTrainers,
        avgTrainerRating: context.stats.avgTrainerRating
      },
      alerts: alerts.slice(0, 3),
      opportunities: opportunities.slice(0, 3),
      actionItems: actionItems.slice(0, 3)
    };
  }
}

// ============ Trainee Performance Recommendations ============

export interface TraineePerformanceData {
  traineeId: string;
  traineeName: string;
  traineeEmail: string;
  applicationId: string;
  appliedAt: Date;
  status: string;
  trainingStatus: string | null;
  traineeConfirmed: boolean;
  trainerConfirmed: boolean;
  sessionScheduled: boolean;
  daysSinceApplication: number;
  performanceScore: number;
  needsAttention: boolean;
  attentionReason: string | null;
}

export interface TraineeContentRecommendation {
  traineeId: string;
  traineeName: string;
  recommendedContent: {
    type: "material" | "communication" | "followup" | "resource";
    title: string;
    description: string;
    priority: "urgent" | "high" | "medium" | "low";
    reason: string;
  }[];
  suggestedAction: string;
}

export interface TraineePerformanceInsights {
  trainerId: string;
  totalTrainees: number;
  needsAttentionCount: number;
  trainees: TraineePerformanceData[];
  contentRecommendations: TraineeContentRecommendation[];
  overallInsights: {
    summary: string;
    topPriorities: string[];
    suggestedFocus: string;
    performanceDistribution: {
      excellent: number;
      good: number;
      needsWork: number;
      atRisk: number;
    };
  };
}

function calculateTraineePerformanceScore(
  trainee: TraineePerformanceData
): { score: number; needsAttention: boolean; reason: string | null } {
  let score = 50; // Base score
  let needsAttention = false;
  let reason: string | null = null;

  // Application status scoring
  if (trainee.status === "accepted") score += 20;
  else if (trainee.status === "under_review") score += 5;
  else if (trainee.status === "rejected") score -= 20;

  // Training status scoring
  if (trainee.trainingStatus === "completed") {
    score += 30;
  } else if (trainee.trainingStatus === "confirmed") {
    score += 20;
    if (trainee.traineeConfirmed && trainee.trainerConfirmed) {
      score += 10;
    }
  } else if (trainee.trainingStatus === "scheduled") {
    score += 10;
  } else if (trainee.trainingStatus === null && trainee.status === "accepted") {
    // Accepted but no training scheduled - needs attention
    needsAttention = true;
    reason = "No training scheduled yet";
  }

  // Time-based factors
  if (trainee.daysSinceApplication > 14 && trainee.trainingStatus !== "completed") {
    score -= 10;
    if (trainee.daysSinceApplication > 30) {
      needsAttention = true;
      reason = reason || "Application stale - no progress in 30+ days";
      score -= 10;
    }
  }

  // Confirmation status
  if (trainee.trainingStatus === "scheduled" && !trainee.traineeConfirmed) {
    if (trainee.daysSinceApplication > 7) {
      needsAttention = true;
      reason = reason || "Waiting for trainee confirmation";
    }
  }

  // Normalize score
  score = Math.max(0, Math.min(100, score));

  return { score, needsAttention, reason };
}

async function getTraineePerformanceContext(trainerId: string) {
  const [applications, users, sessions, materials] = await Promise.all([
    storage.getAllApplications(),
    storage.getAllUsers(),
    storage.getTrainingSessionsByTrainer(trainerId),
    storage.getTrainingMaterialsByTrainer(trainerId)
  ]);

  const trainerApps = applications.filter(app => app.trainerId === trainerId);
  const now = new Date();

  const trainees: TraineePerformanceData[] = [];

  for (const app of trainerApps) {
    const user = users.find(u => u.id === app.applicantId);
    if (!user) continue;

    const daysSince = Math.floor((now.getTime() - new Date(app.appliedAt).getTime()) / (1000 * 60 * 60 * 24));
    
    const baseData: TraineePerformanceData = {
      traineeId: app.applicantId,
      traineeName: user.name,
      traineeEmail: user.email,
      applicationId: app.id,
      appliedAt: new Date(app.appliedAt),
      status: app.status,
      trainingStatus: app.trainingStatus,
      traineeConfirmed: app.traineeConfirmed === "true",
      trainerConfirmed: app.trainerConfirmed === "true",
      sessionScheduled: !!app.trainingSessionId,
      daysSinceApplication: daysSince,
      performanceScore: 0,
      needsAttention: false,
      attentionReason: null
    };

    const { score, needsAttention, reason } = calculateTraineePerformanceScore(baseData);
    baseData.performanceScore = score;
    baseData.needsAttention = needsAttention;
    baseData.attentionReason = reason;

    trainees.push(baseData);
  }

  // Sort by needs attention first, then by performance score (lowest first)
  trainees.sort((a, b) => {
    if (a.needsAttention && !b.needsAttention) return -1;
    if (!a.needsAttention && b.needsAttention) return 1;
    return a.performanceScore - b.performanceScore;
  });

  return {
    trainees,
    materials: materials.map(m => ({ name: m.fileName, category: m.category, id: m.id })),
    sessionCount: sessions.length
  };
}

export async function generateTraineePerformanceInsights(trainerId: string): Promise<TraineePerformanceInsights> {
  const context = await getTraineePerformanceContext(trainerId);
  
  const needsAttentionTrainees = context.trainees.filter(t => t.needsAttention);
  
  // Calculate performance distribution
  const performanceDistribution = {
    excellent: context.trainees.filter(t => t.performanceScore >= 80).length,
    good: context.trainees.filter(t => t.performanceScore >= 60 && t.performanceScore < 80).length,
    needsWork: context.trainees.filter(t => t.performanceScore >= 40 && t.performanceScore < 60).length,
    atRisk: context.trainees.filter(t => t.performanceScore < 40).length
  };

  // Generate content recommendations for trainees needing attention
  const contentRecommendations: TraineeContentRecommendation[] = [];
  
  for (const trainee of needsAttentionTrainees.slice(0, 5)) {
    const recommendations: TraineeContentRecommendation["recommendedContent"] = [];
    
    if (trainee.attentionReason?.includes("No training scheduled")) {
      recommendations.push({
        type: "communication",
        title: "Schedule Training Session",
        description: `Reach out to ${trainee.traineeName} to schedule their training session`,
        priority: "urgent",
        reason: "Trainee accepted but hasn't started training"
      });
      recommendations.push({
        type: "material",
        title: "Send Preparation Materials",
        description: "Share onboarding materials to prepare them before the session",
        priority: "high",
        reason: "Early engagement improves retention"
      });
    }
    
    if (trainee.attentionReason?.includes("confirmation")) {
      recommendations.push({
        type: "followup",
        title: "Send Reminder",
        description: `Send a gentle reminder to ${trainee.traineeName} to confirm their session`,
        priority: "high",
        reason: "Unconfirmed sessions may indicate disengagement"
      });
    }
    
    if (trainee.attentionReason?.includes("stale") || trainee.daysSinceApplication > 21) {
      recommendations.push({
        type: "communication",
        title: "Re-engagement Outreach",
        description: `Check in with ${trainee.traineeName} - they may have questions or concerns`,
        priority: "urgent",
        reason: "Long periods without progress indicate potential dropout"
      });
      recommendations.push({
        type: "resource",
        title: "Share Success Stories",
        description: "Send testimonials from successful associates to reignite motivation",
        priority: "medium",
        reason: "Social proof can motivate hesitant trainees"
      });
    }

    if (recommendations.length === 0) {
      recommendations.push({
        type: "followup",
        title: "General Check-in",
        description: `Schedule a brief check-in with ${trainee.traineeName}`,
        priority: "medium",
        reason: "Regular communication builds engagement"
      });
    }

    contentRecommendations.push({
      traineeId: trainee.traineeId,
      traineeName: trainee.traineeName,
      recommendedContent: recommendations,
      suggestedAction: recommendations[0]?.title || "Review trainee progress"
    });
  }

  // Generate AI-powered overall insights if there are trainees
  let overallInsights = {
    summary: "No trainees assigned yet. Wait for admins to assign trainees to you.",
    topPriorities: ["Set up your time slots", "Upload training materials", "Wait for trainee assignments"],
    suggestedFocus: "Preparation",
    performanceDistribution
  };

  if (context.trainees.length > 0) {
    const needsAttentionCount = needsAttentionTrainees.length;
    const completedCount = context.trainees.filter(t => t.trainingStatus === "completed").length;
    const avgScore = context.trainees.reduce((sum, t) => sum + t.performanceScore, 0) / context.trainees.length;

    let summary = "";
    let suggestedFocus = "";
    const priorities: string[] = [];

    if (needsAttentionCount === 0) {
      summary = `All ${context.trainees.length} trainees are progressing well. Average performance score: ${avgScore.toFixed(0)}/100.`;
      suggestedFocus = "Maintain momentum";
      priorities.push("Continue regular check-ins", "Prepare for upcoming sessions", "Collect feedback from completed trainees");
    } else if (needsAttentionCount === 1) {
      summary = `${needsAttentionCount} trainee needs attention out of ${context.trainees.length}. ${needsAttentionTrainees[0]?.traineeName} - ${needsAttentionTrainees[0]?.attentionReason}.`;
      suggestedFocus = "Individual attention";
      priorities.push(`Follow up with ${needsAttentionTrainees[0]?.traineeName}`, "Review their application details", "Schedule personal outreach");
    } else {
      summary = `${needsAttentionCount} trainees need attention out of ${context.trainees.length}. Focus on re-engagement and scheduling.`;
      suggestedFocus = "Batch follow-ups";
      priorities.push("Send batch reminder emails", "Review stale applications", "Schedule group sessions if possible");
    }

    if (completedCount > 0) {
      priorities.push(`Celebrate ${completedCount} completed trainings!`);
    }

    if (performanceDistribution.atRisk > 0) {
      priorities.unshift(`Urgent: ${performanceDistribution.atRisk} trainees at risk of dropout`);
    }

    overallInsights = {
      summary,
      topPriorities: priorities.slice(0, 3),
      suggestedFocus,
      performanceDistribution
    };
  }

  return {
    trainerId,
    totalTrainees: context.trainees.length,
    needsAttentionCount: needsAttentionTrainees.length,
    trainees: context.trainees,
    contentRecommendations,
    overallInsights
  };
}
