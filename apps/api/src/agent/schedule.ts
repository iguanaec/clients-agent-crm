/** Ventana horaria "HH:MM". Si `end` <= `start` cruza medianoche (17:00 -> 08:00). */
export interface Window {
  start: string;
  end: string;
}

/** Ventanas por día de semana (0=domingo..6=sábado), con `default` como respaldo. */
export interface Schedule {
  default: Window[];
  byDay?: Partial<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, Window[]>>;
}

export const DEFAULT_SCHEDULE: Schedule = {
  default: [{ start: "17:00", end: "08:00" }],
};

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Hora local y día de semana en la zona dada. */
export function localParts(now: Date, timeZone: string): { minutes: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const hour = Number(get("hour")) % 24;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { minutes: hour * 60 + Number(get("minute")), day: days.indexOf(get("weekday")) };
}

/**
 * ¿Está activo el agente en `now`?
 * Una ventana que cruza medianoche pertenece al día en que EMPIEZA: 17:00 del viernes
 * a 08:00 del sábado usa las ventanas del viernes.
 */
export function isAgentActive(schedule: Schedule, timeZone: string, now: Date): boolean {
  const { minutes, day } = localParts(now, timeZone);
  const windowsFor = (d: number) =>
    schedule.byDay?.[d as 0 | 1 | 2 | 3 | 4 | 5 | 6] ?? schedule.default;

  for (const w of windowsFor(day)) {
    const s = toMinutes(w.start);
    const e = toMinutes(w.end);
    if (s < e) {
      if (minutes >= s && minutes < e) return true;
    } else if (minutes >= s) {
      return true; // tramo nocturno de hoy
    }
  }
  // tramo de madrugada de una ventana que empezó ayer
  for (const w of windowsFor((day + 6) % 7)) {
    const s = toMinutes(w.start);
    const e = toMinutes(w.end);
    if (s >= e && minutes < e) return true;
  }
  return false;
}
