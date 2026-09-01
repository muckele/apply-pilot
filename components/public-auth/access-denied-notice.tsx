import { CircleSlash2 } from "lucide-react";

export function AccessDeniedNotice({ action }: { action?: React.ReactNode }) {
  return (
    <div className="public-access-denied" role="status">
      <CircleSlash2 aria-hidden="true" />
      <div>
        <strong>Access not available.</strong>
        <p>This Google account is not approved for this deployment.</p>
      </div>
      {action}
    </div>
  );
}
