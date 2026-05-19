import type { JobSourceType } from "@prisma/client";

import { AshbyProvider } from "@/lib/job-sources/ashby";
import { GenericCompanyCareersProvider } from "@/lib/job-sources/generic-company-careers";
import { GreenhouseProvider } from "@/lib/job-sources/greenhouse";
import { LeverProvider } from "@/lib/job-sources/lever";
import { ManualJobImportProvider } from "@/lib/job-sources/manual";
import type { JobSourceProvider } from "@/lib/job-sources/types";

const providers: Record<JobSourceType, JobSourceProvider | null> = {
  MANUAL: new ManualJobImportProvider(),
  GREENHOUSE: new GreenhouseProvider(),
  LEVER: new LeverProvider(),
  ASHBY: new AshbyProvider(),
  COMPANY_CAREERS: new GenericCompanyCareersProvider(),
  WORKABLE: null,
  USAJOBS: null,
  REMOTIVE: null,
  RSS: null
};

export function getJobSourceProvider(type: JobSourceType) {
  const provider = providers[type];

  if (!provider) {
    throw new Error(`${type} provider is not implemented yet. Add it in lib/job-sources/index.ts.`);
  }

  return provider;
}

// Add additional compliant providers here. Each provider must implement JobSourceProvider,
// avoid prohibited job-board scraping, and clearly document the API or permission model it uses.
export * from "@/lib/job-sources/types";
