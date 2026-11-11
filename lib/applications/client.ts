// Client helpers for the Apply page: make sure an application exists and attach documents to it
// without changing its status (the server keeps status, dates and follow-up when no status is sent).

async function failureMessage(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON; use the fallback.
  }
  return fallback;
}

export async function ensureApplication(jobId: string, fetchImpl: typeof fetch = fetch): Promise<{ id: string }> {
  const response = await fetchImpl("/api/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobPostingId: jobId, status: "SAVED" })
  });
  if (!response.ok) throw new Error(await failureMessage(response, "Could not save this job."));
  const body = (await response.json()) as { application?: { id?: unknown } };
  const id = body.application?.id;
  if (typeof id !== "string" || !id) throw new Error("Could not save this job.");
  return { id };
}

export async function attachDocuments(
  applicationId: string,
  docs: { resumeVersionId?: string; coverLetterVersionId?: string },
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const body: { resumeVersionId?: string; coverLetterVersionId?: string } = {};
  if (docs.resumeVersionId !== undefined) body.resumeVersionId = docs.resumeVersionId;
  if (docs.coverLetterVersionId !== undefined) body.coverLetterVersionId = docs.coverLetterVersionId;
  const response = await fetchImpl(`/api/applications/${encodeURIComponent(applicationId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await failureMessage(response, "Could not attach these documents."));
}
