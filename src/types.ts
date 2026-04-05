export type DashboardActivitySummary = {
  id: number;
  name: string;
  date: string;
  timeLabel: string | null;
  sortKey: string;
  distanceKm: number;
  durationSeconds: number;
  paceSecondsPerKm: number | null;
  averageHeartRate: number | null;
  elevationGain: number | null;
  trainingEffect: number | null;
  trainingLoad: number | null;
  workoutId: number | null;
  activityKey: string;
  activityLabel: string;
  isRunLike: boolean;
};

export type DashboardData = {
  provider: {
    key: 'garmin' | 'strava';
    label: string;
    supportsWorkoutPush: boolean;
    supportsWellness: boolean;
  };
  athlete: {
    name: string;
    location: string | null;
    primaryDevice: string | null;
    avatarPath: string | null;
    raceDate: string;
    daysToRace: number;
  };
  goal: {
    raceDate: string;
    distanceKm: number;
    label: string;
    raceTitle: string;
    category: 'speed' | 'tenk' | 'half' | 'marathon';
    daysToRace: number;
    totalWeeks: number;
  };
  overview: {
    steps: number | null;
    activeCalories: number | null;
    distanceKm: number | null;
    sleepHours: number | null;
    sleepScore: number | null;
    hrv: number | null;
    readiness: number | null;
    vo2Max: number | null;
    trainingStatus: string | null;
    weightKg: number | null;
    averageWeeklyKm: number | null;
    longestRunKm: number | null;
    predictedGoalSeconds: number | null;
  };
  wellnessTrend: Array<{
    date: string;
    label: string;
    steps: number | null;
    sleepHours: number | null;
    hrv: number | null;
    readiness: number | null;
  }>;
  weeklyRunning: Array<{
    weekLabel: string;
    distanceKm: number;
    durationHours: number;
    runCount: number;
  }>;
  vo2Trend: Array<{
    date: string;
    label: string;
    value: number | null;
  }>;
  recentActivities: DashboardActivitySummary[];
  recentRuns: DashboardActivitySummary[];
  fitnessSummary: {
    title: string;
    body: string;
  };
  adaptive: {
    overall: 'push' | 'steady' | 'protect';
    primaryNeed: string;
    volume: {
      action: 'subir' | 'mantener' | 'bajar';
      deltaKm: number;
      rationale: string;
    };
    pace: {
      action: 'acelerar' | 'mantener' | 'aflojar';
      secondsPerKm: number;
      rationale: string;
    };
    recovery: {
      action: 'proteger' | 'normal' | 'apretar';
      rationale: string;
    };
    signals: {
      recent7Km: number;
      baselineWeeklyKm: number | null;
      volumeRatio: number | null;
      acuteChronicRatio: number | null;
      loadBalanceFeedback: string | null;
      qualitySessions14d: number;
      lastLongRunKm: number | null;
      plannedSessions7d: number;
      completedSessions7d: number;
      missedSessions7d: number;
      movedSessions7d: number;
      complianceRate7d: number | null;
      missedKeySessionThisWeek: boolean;
      keySessionRelocatedTo: string | null;
      qualityPaceDeltaSeconds: number | null;
      easyPaceDeltaSeconds: number | null;
      lowSleepDays7d: number;
      lowReadinessDays7d: number;
      hrvDelta: number | null;
    };
  };
  advice: Array<{
    title: string;
    body: string;
    tone: 'accent' | 'calm' | 'warning';
  }>;
  checkIn: {
    needsToday: boolean;
    latest: {
      date: string;
      energy: 'low' | 'ok' | 'high';
      legs: 'heavy' | 'normal' | 'fresh';
      mood: 'flat' | 'steady' | 'great';
      note: string | null;
      createdAt: string;
    } | null;
    recent: Array<{
      date: string;
      energy: 'low' | 'ok' | 'high';
      legs: 'heavy' | 'normal' | 'fresh';
      mood: 'flat' | 'steady' | 'great';
      note: string | null;
      createdAt: string;
    }>;
  };
  coach: {
    enabled: boolean;
    source: 'gemma4' | 'fallback';
    model: string | null;
    generatedAt: string | null;
    todayMessage: string | null;
    weeklyReview: {
      headline: string;
      summary: string;
      status: 'protect' | 'steady' | 'push';
      nextMove: string;
    } | null;
    latestDebrief: {
      runId: number;
      runName: string;
      summary: string;
      nextStep: string;
      generatedAt: string;
    } | null;
  };
  plan: {
    summary: string;
    level: 'conservador' | 'equilibrado' | 'ambicioso';
    paces: {
      easy: string | null;
      steady: string | null;
      tempo: string | null;
      race: string | null;
    };
    weeks: Array<{
      title: string;
      focus: string;
      targetKm: number | null;
      coachNote?: string | null;
      days: Array<{
        date: string;
        weekday: string;
        title: string;
        intent: string;
        intensity: 'suave' | 'medio' | 'alto' | 'recuperacion' | 'descanso' | 'carrera';
        distanceKm: number | null;
        notes: string;
        status: 'planned' | 'done' | 'missed' | 'moved' | 'adjusted';
        outcome: string | null;
        canSendToGarmin: boolean;
      }>;
    }>;
  };
  fetchedAt: string;
  fallbackReason?: string;
};

export type UserGoal = {
  raceDate: string;
  distanceKm: number;
};

export type WhatIfScenario = {
  headline: string;
  summary: string;
  risk: 'low' | 'medium' | 'high';
  stance: string;
  adjustments: string[];
  sampleWeek: string[];
  recommendedGoal: {
    raceDate: string;
    distanceKm: number;
  };
};

export type SessionPayload = {
  authenticated: true;
  provider: 'garmin' | 'strava';
  sessionId: string;
  accountLabel: string;
  goal: UserGoal;
};

export type ActivityRouteSample = {
  point: [number, number];
  paceSecondsPerKm: number | null;
  timestampSeconds: number | null;
};

export type ActivityRoute = {
  points: Array<[number, number]>;
  samples: ActivityRouteSample[];
  source: 'garmin' | 'strava';
};
