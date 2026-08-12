"use client";

import { FormEvent, useState } from "react";
import { Loader2, Plus, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";

type JobContact = {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  profileUrl: string | null;
  notes: string | null;
};

type JobContactNotesFormProps = {
  jobPostingId: string;
  applicationId?: string | null;
  contacts: JobContact[];
};

async function readError(response: Response) {
  const json = (await response.json().catch(() => null)) as { error?: string } | null;
  return json?.error ?? "Could not save contact.";
}

export function JobContactNotesForm({ jobPostingId, applicationId, contacts }: JobContactNotesFormProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [profileUrl, setProfileUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);

    try {
      const response = await fetch("/api/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobPostingId,
          applicationId: applicationId ?? undefined,
          name,
          email,
          role,
          profileUrl,
          notes
        })
      });

      if (!response.ok) {
        setMessage(await readError(response));
        return;
      }

      setName("");
      setEmail("");
      setRole("");
      setProfileUrl("");
      setNotes("");
      setMessage("Contact saved.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save contact.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-5 p-5">
      <form onSubmit={submit} className="space-y-3">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Recruiter or hiring manager"
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          required
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Email"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
          <input
            value={role}
            onChange={(event) => setRole(event.target.value)}
            placeholder="Role"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </div>
        <input
          type="url"
          value={profileUrl}
          onChange={(event) => setProfileUrl(event.target.value)}
          placeholder="Profile URL"
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
        />
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Notes"
          rows={5}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={pending || !name.trim()}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? <Loader2 className="animate-spin" size={16} /> : <Plus size={16} />}
          Save contact
        </button>
        {message ? <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">{message}</p> : null}
      </form>

      <div className="space-y-3">
        <p className="text-xs font-semibold uppercase text-slate-500">Saved contacts</p>
        {contacts.length ? (
          contacts.map((contact) => (
            <div key={contact.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-start gap-2">
                <UserRound size={16} className="mt-0.5 text-slate-500" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-950">{contact.name}</p>
                  <p className="text-xs text-slate-500">
                    {[contact.role, contact.email].filter(Boolean).join(" - ") || "No role or email saved"}
                  </p>
                  {contact.profileUrl ? (
                    <a
                      href={contact.profileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 block truncate text-xs font-medium text-brand-700 hover:text-brand-800"
                    >
                      {contact.profileUrl}
                    </a>
                  ) : null}
                  {contact.notes ? <p className="mt-2 text-xs leading-5 text-slate-600">{contact.notes}</p> : null}
                </div>
              </div>
            </div>
          ))
        ) : (
          <p className="text-xs leading-5 text-slate-500">No contacts saved for this job yet.</p>
        )}
      </div>
    </div>
  );
}
