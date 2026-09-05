import { isMainModule } from "./is-main-module.mjs";
import {
  evaluateRound,
  runCli,
} from "../skills/knights-of-the-round-table/scripts/review-round.mjs";

export { evaluateRound };

if (isMainModule(import.meta.url)) {
  runCli();
}
