import { normalize as fmtNorm } from "./util/format";
import { normalize as parseNorm } from "./util/parse";

export function go(x: string): string {
  return fmtNorm(x) + parseNorm(x);
}
