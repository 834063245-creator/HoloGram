import leftpad from "leftpad";

export function pad(s: string): string {
  return leftpad(s, 10);
}
