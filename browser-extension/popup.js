const byId = (id) => document.getElementById(id);
const panels = ["job", "answers", "settings"];
let savedJobPath = null;

function setStatus(message, isError = false) {
  const status = byId("status");
  status.textContent = message;
  status.style.color = isError ? "#b91c1c" : "#475569";
}

function selectPanel(name) {
  for (const panel of panels) {
    byId(`${panel}-tab`).classList.toggle("active", panel === name);
    byId(`${panel}-panel`).classList.toggle("active", panel === name);
  }
  setStatus("");
}

function normalizedAppUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Use an HTTP or HTTPS app URL.");
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !localHost) throw new Error("Use HTTPS unless JobMatch CRM is running on this computer.");
  return url.origin;
}

async function getConnection() {
  const local = await chrome.storage.local.get(["appUrl"]);
  const session = await chrome.storage.session.get(["browserToken"]);
  if (!local.appUrl || !session.browserToken) throw new Error("Connect the extension from the Setup tab first.");
  return { appUrl: local.appUrl, token: session.browserToken };
}

function extractJobFromPage() {
  function stripHtml(value) {
    const doc = new DOMParser().parseFromString(String(value || ""), "text/html");
    return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }

  function findJobPosting(value) {
    if (!value || typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findJobPosting(item);
        if (found) return found;
      }
      return null;
    }
    const type = value["@type"];
    if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return value;
    if (value["@graph"]) return findJobPosting(value["@graph"]);
    return null;
  }

  function firstText(selectors) {
    for (const selector of selectors) {
      const text = document.querySelector(selector)?.textContent?.trim();
      if (text) return text;
    }
    return "";
  }

  function locationFromStructured(job) {
    const location = Array.isArray(job?.jobLocation) ? job.jobLocation[0] : job?.jobLocation;
    const address = location?.address || location;
    if (typeof address === "string") return address;
    return [address?.addressLocality, address?.addressRegion, address?.addressCountry]
      .filter(Boolean)
      .join(", ");
  }

  let structured = null;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      structured = findJobPosting(JSON.parse(script.textContent || "null"));
      if (structured) break;
    } catch {
      // Ignore malformed third-party JSON-LD and continue with visible content.
    }
  }

  const title = String(structured?.title || firstText(["h1", "[itemprop='title']"]) || document.title).trim();
  const company = String(
    structured?.hiringOrganization?.name ||
      firstText(["[itemprop='hiringOrganization']", "[data-testid*='company']", ".company-name"]) ||
      document.querySelector("meta[property='og:site_name']")?.getAttribute("content") ||
      ""
  ).trim();
  const structuredDescription = stripHtml(structured?.description || structured?.responsibilities || "");
  const visibleDescription = firstText([
    "[itemprop='description']",
    "[data-testid*='job-description']",
    ".job-description",
    "main",
    "article"
  ]);
  const description = (structuredDescription || visibleDescription).slice(0, 50000);
  const jobLocation = String(
    locationFromStructured(structured) ||
      firstText(["[itemprop='jobLocation']", "[data-testid*='location']", ".job-location"])
  ).trim();
  const pageText = `${title} ${jobLocation} ${description.slice(0, 4000)}`.toLowerCase();
  const remoteStatus = structured?.jobLocationType === "TELECOMMUTE" || /\bremote\b/.test(pageText)
    ? "Remote"
    : /\bhybrid\b/.test(pageText)
      ? "Hybrid"
      : "";
  const canonical = document.querySelector("link[rel='canonical']")?.href;
  const salary = structured?.baseSalary?.value || structured?.estimatedSalary?.value;
  const salaryUnit = String(structured?.baseSalary?.value?.unitText || structured?.baseSalary?.unitText || "").toUpperCase();
  const annualSalary = !salaryUnit || salaryUnit === "YEAR";

  return {
    title,
    company,
    location: jobLocation,
    remoteStatus,
    sourceUrl: canonical || window.location.href,
    applyUrl: structured?.url || canonical || window.location.href,
    datePosted: structured?.datePosted || "",
    salaryMin: annualSalary ? salary?.minValue || salary?.value || "" : "",
    salaryMax: annualSalary ? salary?.maxValue || salary?.value || "" : "",
    description
  };
}

async function extractActiveJob() {
  setStatus("Reading the active tab...");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) throw new Error("Open a public HTTP or HTTPS job page first.");

  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractJobFromPage });
  const job = results[0]?.result;
  if (!job) throw new Error("No job information could be read from this page.");

  byId("title").value = job.title || "";
  byId("company").value = job.company || "";
  byId("location").value = job.location || "";
  byId("remote-status").value = job.remoteStatus || "";
  byId("source-url").value = job.sourceUrl || tab.url;
  byId("apply-url").value = job.applyUrl || job.sourceUrl || tab.url;
  byId("date-posted").value = String(job.datePosted || "").slice(0, 10);
  byId("salary-min").value = job.salaryMin || "";
  byId("salary-max").value = job.salaryMax || "";
  byId("description").value = job.description || "";
  setStatus("Review every field, then save the job.");
}

async function saveJob(event) {
  event.preventDefault();
  const { appUrl, token } = await getConnection();
  const button = byId("save");
  button.disabled = true;
  setStatus("Saving reviewed job...");

  try {
    const response = await fetch(`${appUrl}/api/browser-capture`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: byId("title").value,
        company: byId("company").value,
        location: byId("location").value,
        remoteStatus: byId("remote-status").value || undefined,
        sourceUrl: byId("source-url").value,
        applyUrl: byId("apply-url").value,
        datePosted: byId("date-posted").value || undefined,
        salaryMin: byId("salary-min").value ? Number(byId("salary-min").value) : undefined,
        salaryMax: byId("salary-max").value ? Number(byId("salary-max").value) : undefined,
        description: byId("description").value,
        runMatch: byId("run-match").checked
      })
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(json?.error || "JobMatch CRM rejected the capture.");

    savedJobPath = json.path;
    byId("open-job").classList.remove("hidden");
    setStatus(`Saved ${json.job.title} at ${json.job.company}. No application was submitted.`);
  } finally {
    button.disabled = false;
  }
}

async function loadAnswers() {
  const { appUrl, token } = await getConnection();
  setStatus("Loading reviewed answers...");
  const response = await fetch(`${appUrl}/api/browser-capture/answers`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.error || "Answers could not be loaded.");

  const list = byId("answers-list");
  list.textContent = "";
  for (const answer of json.answers) {
    const card = document.createElement("article");
    card.className = "answer";
    const category = document.createElement("span");
    category.className = "category";
    category.textContent = answer.category.replaceAll("_", " ");
    const heading = document.createElement("h2");
    heading.textContent = answer.question;
    const text = document.createElement("p");
    text.textContent = answer.sensitive ? "Sensitive answer. Click copy to use the reviewed value." : answer.answer;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy answer";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(answer.answer);
      setStatus("Answer copied. Review it in the application before using it.");
    });
    card.append(category, heading, text, copy);
    list.append(card);
  }
  setStatus(json.answers.length ? "Answers loaded. Nothing is filled or submitted automatically." : "No active answers found.");
}

async function saveSettings() {
  const appUrl = normalizedAppUrl(byId("app-url").value);
  const token = byId("browser-token").value.trim();
  if (!token.startsWith("jmc_")) throw new Error("Paste a browser token generated by JobMatch CRM.");

  const granted = await chrome.permissions.request({ origins: [`${appUrl}/*`] });
  if (!granted) throw new Error("Chrome needs permission to connect only to your JobMatch CRM origin.");

  await chrome.storage.local.set({ appUrl });
  await chrome.storage.session.set({ browserToken: token });
  byId("browser-token").value = "";
  setStatus("This browser session is connected.");
  selectPanel("job");
}

async function initialize() {
  const local = await chrome.storage.local.get(["appUrl"]);
  if (local.appUrl) byId("app-url").value = local.appUrl;

  for (const panel of panels) byId(`${panel}-tab`).addEventListener("click", () => selectPanel(panel));
  byId("extract").addEventListener("click", () => extractActiveJob().catch((error) => setStatus(error.message, true)));
  byId("job-form").addEventListener("submit", (event) => saveJob(event).catch((error) => setStatus(error.message, true)));
  byId("load-answers").addEventListener("click", () => loadAnswers().catch((error) => setStatus(error.message, true)));
  byId("save-settings").addEventListener("click", () => saveSettings().catch((error) => setStatus(error.message, true)));
  byId("open-job").addEventListener("click", async () => {
    const { appUrl } = await getConnection();
    if (savedJobPath) await chrome.tabs.create({ url: `${appUrl}${savedJobPath}` });
  });

  const session = await chrome.storage.session.get(["browserToken"]);
  selectPanel(local.appUrl && session.browserToken ? "job" : "settings");
}

initialize().catch((error) => setStatus(error.message, true));
