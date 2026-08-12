# JobMatch CRM Capture Extension

This Manifest V3 extension reads only the active tab after the user clicks **Read active job page**. It extracts Schema.org `JobPosting` JSON-LD when available, falls back to visible page text, and shows every field for review before saving.

It does not run in the background on job sites, scrape search result pages, fill application forms, submit applications, or send email.

## Local installation

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `browser-extension` directory.
4. In JobMatch CRM, open **Settings > Integrations**, generate a browser token, and copy the app URL.
5. Open the extension’s **Setup** tab and enter both values.

The app URL is stored in `chrome.storage.local`. The scoped browser token is stored in `chrome.storage.session`, so it is cleared when the browser session ends. Revoke tokens from JobMatch CRM at any time.
