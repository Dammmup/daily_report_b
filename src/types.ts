export type Role = "intern" | "lead" | "admin";

export type Category =
  | "data-analytics"
  | "system-analytics"
  | "machine-learning"
  | "marketing"
  | "sales"
  | "erp-development"
  | "data-security";

export type User = {
  id: string;
  name: string;
  email?: string | null;
  role: Role;
  category?: Category;
  categoryLabel?: string;
  avatarColor: string;
  firstLoginCompleted: boolean;
  emailVerified: boolean;
  telegramChatId?: string;
  telegramDigestEnabled?: boolean;
  telegramDigestTime?: string;
  telegramDigestContent?: "productivity" | "reports" | "full";
  telegramUsername?: string;
  telegramActivityMessages?: number;
  telegramActivityScore?: number;
  telegramActivitySummary?: string;
  lastActiveAt: string;
};

export type Attendance = {
  id: string;
  userId: string;
  date: string;
  checkInAt: string;
  checkOutAt?: string;
  mood: "focused" | "normal" | "blocked";
};

export type DailyReport = {
  id: string;
  userId: string;
  date: string;
  yesterday: string;
  todayPlan: string;
  blockers: string;
  source?: "web" | "telegram";
  createdAt: string;
  aiReview?: AiReview;
};

export type Survey = {
  id: string;
  userId: string;
  answers: {
    traits: string[];
    skills: string;
    experience: string;
    learningStyle: string;
    goal: string;
  };
  analysis: StrengthProfile;
  createdAt: string;
};

export type StrengthProfile = {
  strengths: string[];
  weaknesses: string[];
  skillsSummary?: string;
  experienceSummary?: string;
  goalAlignment?: string;
  suggestedTrack?: string;
  mentorFocus?: string[];
  recommendation: string;
  riskLevel: "low" | "medium" | "high";
};

export type AiReview = {
  productivityScore: number;
  summary: string;
  risks: string[];
  nextActions: string[];
  deadlineImpactDays: number;
  criteria?: {
    resultClarity: number;
    planClarity: number;
    blockerControl: number;
    initiative: number;
  };
  explanation?: string;
  confidence?: "low" | "medium" | "high";
  model: string;
};

export type ProjectPlan = {
  id: string;
  leadId: string;
  title: string;
  category: Category;
  version: number;
  status: "draft" | "approved" | "completed" | "archived";
  startDate: string;
  baseDeadline: string;
  adjustedDeadline: string;
  milestones: string[];
  steps: ProjectPlanStep[];
  issues: ProjectIssue[];
  aiRationale: string;
};

export type ProjectPlanStep = {
  id: string;
  title: string;
  description: string;
  deadline: string;
  status: "todo" | "in_progress" | "done" | "canceled";
  assignedTo?: string;
  source: "ai" | "manual";
};

export type ProjectIssue = {
  id: string;
  title: string;
  severity: "low" | "medium" | "high";
  impactDays: number;
  status: "open" | "resolved";
  createdAt: string;
};

export type Database = {
  users: User[];
  attendance: Attendance[];
  reports: DailyReport[];
  surveys: Survey[];
  plans: ProjectPlan[];
};

export type PlanFitCandidate = {
  user: User;
  score: number;
  matchReason: string;
  risks: string[];
  source: "same_department" | "other_department";
  surveyAnalysis?: StrengthProfile;
  averageScore: number;
  reportsCount: number;
};

export type AssignmentDraftItem = {
  stepId: string;
  stepTitle: string;
  stepDescription: string;
  deadline: string;
  recommendedUser: User;
  score: number;
  confidence: "low" | "medium" | "high";
  source: "same_department" | "other_department";
  assignable: boolean;
  reason: string;
  risks: string[];
  alternatives: PlanFitCandidate[];
};

export type AssignmentDraft = {
  plan: {
    id: string;
    title: string;
    category: Category;
    categoryLabel: string;
    adjustedDeadline: string;
  } | null;
  summary: string;
  items: AssignmentDraftItem[];
  skippedSteps: {
    stepId: string;
    title: string;
    reason: string;
  }[];
};

export type DecisionCenter = {
  scope: "department" | "all";
  plan?: {
    id: string;
    title: string;
    category: Category;
    categoryLabel: string;
    adjustedDeadline: string;
    milestones: string[];
  };
  recommended: PlanFitCandidate[];
  attention: {
    user: User;
    reason: string;
    severity: "low" | "medium" | "high";
  }[];
  missingReports: User[];
  blockerReports: {
    user: User;
    date: string;
    blockers: string;
    aiSummary?: string;
  }[];
  summary: string;
};
