#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { collectAiballDiscoveryCore } from "../../shared/aiball-discovery-core.mjs";
import { evaluateProfessionalEligibility, mastersEducationEligible, rankProfessionalOpportunity, roleIsProfileRelevant } from "./professional-eligibility.mjs";

const eligibility = { evaluateProfessionalEligibility, mastersEducationEligible, rankProfessionalOpportunity, roleIsProfileRelevant };
export function collectAiballDiscovery(options = {}) { return collectAiballDiscoveryCore({ ...options, eligibility }); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cityIndex = process.argv.indexOf("--city");
  collectAiballDiscovery({ city: cityIndex >= 0 ? process.argv[cityIndex + 1] : "北京" })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(JSON.stringify({ status: "aiball-discovery-failed", error: error.message }, null, 2)); process.exitCode = 1; });
}
