import { Button } from "./components/button";
import { theme, darken } from "@/theme/colors";

export function render(): string {
  return Button() + darken(theme.primary);
}
