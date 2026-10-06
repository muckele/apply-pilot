import { notFound } from "next/navigation";

import { SyntheticOneJobReview } from "@/components/synthetic-one-job-review";
import { SYNTHETIC_ONE_JOB_FIXTURE } from "@/evaluation/synthetic-one-job-fixture";

export const dynamic = "force-dynamic";

export default function SyntheticOneJobPage() {
  if (process.env.NODE_ENV === "production" || process.env.APPLY_PILOT_SYNTHETIC_ONE_JOB_PREVIEW !== "true") {
    notFound();
  }
  return <SyntheticOneJobReview fixture={SYNTHETIC_ONE_JOB_FIXTURE} />;
}
