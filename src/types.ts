export type DashboardData = {
  athlete: {
    name: string;
    location: string | null;
    primaryDevice: string | null;
    raceDate: string;
    daysToRace: number;
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
    predictedHalfSeconds: number | null;
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
  recentRuns: Array<{
    id: number;
    name: string;
    date: string;
    distanceKm: number;
    durationSeconds: number;
    paceSecondsPerKm: number | null;
    averageHeartRate: number | null;
    elevationGain: number | null;
    trainingEffect: number | null;
  }>;
  advice: Array<{
    title: string;
    body: string;
    tone: 'accent' | 'calm' | 'warning';
  }>;
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
      days: Array<{
        date: string;
        weekday: string;
        title: string;
        intent: string;
        intensity: 'suave' | 'medio' | 'alto' | 'recuperacion' | 'descanso' | 'carrera';
        distanceKm: number | null;
        notes: string;
      }>;
    }>;
  };
  fetchedAt: string;
  fallbackReason?: string;
};
