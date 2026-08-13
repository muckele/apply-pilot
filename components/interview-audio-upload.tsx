"use client";

import { upload } from "@vercel/blob/client";
import { CheckCircle2, LoaderCircle, Mic } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";

import { INTERVIEW_CONSENT_STATEMENT } from "@/lib/interviews/audio-policy";

type Props = {
  interviewId: string;
  directUploadEnabled: boolean;
  directUploadMaxMb: number;
  serverUploadMaxMb: number;
};

function safeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "interview-audio.bin";
}

export function InterviewAudioUpload({
  interviewId,
  directUploadEnabled,
  directUploadMaxMb,
  serverUploadMaxMb
}: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);

  async function submitDirectUpload(event: FormEvent<HTMLFormElement>) {
    if (!directUploadEnabled) {
      return;
    }

    event.preventDefault();
    setError("");
    setComplete(false);

    const file = fileRef.current?.files?.[0];
    if (!consentConfirmed) {
      setError("Confirm participant consent before uploading audio.");
      return;
    }
    if (!file) {
      setError("Choose an audio file before uploading.");
      return;
    }
    if (file.size > directUploadMaxMb * 1024 * 1024) {
      setError(`Audio must be ${directUploadMaxMb} MB or smaller.`);
      return;
    }

    try {
      setUploading(true);
      setProgress(0);
      const blob = await upload(`interviews/${interviewId}/${safeFilename(file.name)}`, file, {
        access: "private",
        handleUploadUrl: `/api/interviews/${interviewId}/audio/upload`,
        clientPayload: JSON.stringify({
          consentConfirmed: true,
          consentStatement: INTERVIEW_CONSENT_STATEMENT
        }),
        multipart: file.size > 5 * 1024 * 1024,
        onUploadProgress: ({ percentage }) => setProgress(Math.round(percentage))
      });
      const response = await fetch(`/api/interviews/${interviewId}/audio/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blobUrl: blob.url,
          consentConfirmed: true,
          consentStatement: INTERVIEW_CONSENT_STATEMENT
        })
      });
      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "The uploaded audio could not be attached to this interview.");
      }

      setComplete(true);
      setProgress(100);
      if (fileRef.current) {
        fileRef.current.value = "";
      }
      router.refresh();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Audio upload failed.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <form
      className="space-y-4 p-5 text-sm text-slate-700"
      action={directUploadEnabled ? undefined : `/api/interviews/${interviewId}/audio`}
      method="post"
      encType={directUploadEnabled ? undefined : "multipart/form-data"}
      onSubmit={submitDirectUpload}
    >
      <label className="flex gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <input
          type="checkbox"
          name="consentConfirmed"
          value="true"
          checked={consentConfirmed}
          onChange={(event) => setConsentConfirmed(event.target.checked)}
          className="mt-1"
        />
        <span>{INTERVIEW_CONSENT_STATEMENT}</span>
      </label>
      <input type="hidden" name="consentStatement" value={INTERVIEW_CONSENT_STATEMENT} />
      <label className="block font-medium">
        Audio file
        <input
          ref={fileRef}
          name="file"
          type="file"
          accept="audio/*,video/mp4,video/webm"
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
          required
        />
      </label>
      <p className="text-xs text-slate-500">
        Maximum {directUploadEnabled ? directUploadMaxMb : serverUploadMaxMb} MB
        {directUploadEnabled ? " · uploaded directly to private storage" : " · server upload fallback"}
      </p>
      {uploading ? (
        <div className="h-2 overflow-hidden rounded-full bg-slate-100" aria-label={`Upload ${progress}% complete`}>
          <div className="h-full bg-brand-600 transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
      {error ? <p className="text-sm font-medium text-rose-700" role="alert">{error}</p> : null}
      {complete ? (
        <p className="inline-flex items-center gap-2 text-sm font-medium text-emerald-700">
          <CheckCircle2 size={16} aria-hidden="true" />
          Audio saved
        </p>
      ) : null}
      <button
        type="submit"
        disabled={uploading}
        className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {uploading ? <LoaderCircle className="animate-spin" size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
        {uploading ? `Uploading ${progress}%` : "Upload consented audio"}
      </button>
    </form>
  );
}
