import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { startNextTestServer } from "@/tests/browser/next-test-server";
import { realisticDocumentQualityPayload } from "@/evaluation/document-quality-career-fixture";
import { syntheticTailoredResumeOutput, syntheticCoverLetterOutput } from "@/evaluation/correction-flow-provider-stub";
import { SYNTHETIC_CORRECTION_FLOW_FACT } from "@/evaluation/correction-flow-qualification-fixture";
import { buildEvidenceCorrectionReview } from "@/lib/jobs/evidence-correction-review";
import { assembleTailoredResumeProviderOutput, assembleCoverLetterProviderOutput } from "@/lib/ai/application-document-facts";
import { validateTailoredResumeClaims, validateCoverLetterClaims } from "@/lib/ai/application-document-claims";

import { Prisma, PrismaClient } from "@prisma/client";
import type { NextRequest } from "next/server";

import { createDocumentExportRouteHandlers } from "@/lib/documents/document-export-route";
import { hashAiInput } from "@/lib/ai/input-hash";
import { JOB_MATCH_MODEL, JOB_MATCH_PROMPT_VERSION } from "@/lib/ai/job-match-version";
import { validateAndNormalizeJobMatchOutput, type MatchInput } from "@/lib/ai/job-match";
import { assembleAndValidateResumeV9 } from "@/lib/ai/resume";
import {
  acceptedEvidenceFactsFromSnapshot,
  CURRENT_EVIDENCE_SNAPSHOT_SELECT,
  reviewedEvidenceFromSnapshot
} from "@/lib/jobs/evidence-snapshot-contracts";
import { saveEvidenceSnapshot } from "@/lib/jobs/evidence-snapshots";
import { createJobMatchRunner } from "@/lib/jobs";
import { buildCurrentJobMatchInput, currentJobMatchInputHash } from "@/lib/jobs/current-job-match";
import { readApplicationDocumentEvidence } from "@/lib/jobs/application-document-evidence";
import {
  createCoverLetterRouteHandler,
  createTailoredResumeRouteHandler
} from "@/lib/jobs/application-document-generation-routes";
import { extractResumeDocxText } from "@/lib/resume-docx-text";
import {
  assertPostgresTestMajorVersion,
  validatePostgresTestEnvironment,
  verifyLivePostgresTestDatabase
} from "@/tests/postgres/postgres-test-harness";
import {
  fullSizeSyntheticDocxExtractedText,
  fullSizeSyntheticProviderOutput
} from "@/tests/fixtures/resume-estimator-boundary-data";
import { providerV9FromCanonical } from "@/tests/fixtures/resume-v9-provider-data";

const degreeFact = "Bachelor of Arts in Business Administration";
const originalOwnerFact = "Synthetic owner confirms leading 40-person global delivery programs.";
const removedOwnerFact = "Synthetic owner confirms an obsolete certification.";
const replacementOwnerFact = "Synthetic owner confirms leading cross-functional service portfolio reviews.";
const jobRequirements = [
  "Business education in Zephyrite governance",
  "Global delivery scale in Asterism programs",
  "Legacy certification for Quenby systems"
] as const;
const missingRequirementKeywords = ["Zephyrite", "Asterism", "Quenby"] as const;

test("actual owned product job route reviews full career and exports current files without navigation mutations", {timeout:120_000}, async () => {
  const config=validatePostgresTestEnvironment(process.env);
  assertPostgresTestMajorVersion(await verifyLivePostgresTestDatabase(config));
  const client=new PrismaClient({datasources:{db:{url:config.url}}});
  const payload=realisticDocumentQualityPayload(),resumeData=payload.resume!;
  const user=await client.user.create({data:{email:`product-review-${randomUUID()}@example.test`,name:"Synthetic Product Reviewer"}});
  let nextServer:Awaited<ReturnType<typeof startNextTestServer>>|undefined;
  const browser=await chromium.launch({headless:true,channel:"chromium"});
  const outputDir="/tmp/ap-pr35-pdf-font-evidence";await mkdir(outputDir,{recursive:true});
  try {
    const job=await client.jobPosting.create({data:{userId:user.id,title:"Service Operations Director",company:"Northwind Service Cloud",normalizedTitle:randomUUID(),normalizedCompany:randomUUID(),normalizedLocation:"remote",sourceUrl:"https://example.test/product-review",normalizedApplyUrl:"https://example.test/product-review",sourceType:"MANUAL",description:String(payload.job!.description),requirements:[...(payload.job!.requirements as string[]),"Current Quenby certification"],preferredQualifications:["Business education"],benefits:[],detectedTechStack:["SQL"],missingKeywords:[],supportedKeywords:[],concerns:[]}});
    const resume=await client.resume.create({data:{userId:user.id,isMaster:true,title:"Synthetic three-job master",rawText:String(resumeData.rawText),summary:String(resumeData.summary),skills:resumeData.skills as string[],achievements:resumeData.achievements as string[],workHistory:resumeData.workHistory as Prisma.InputJsonValue,projects:resumeData.projects as Prisma.InputJsonValue,education:resumeData.education as Prisma.InputJsonValue,certifications:resumeData.certifications as Prisma.InputJsonValue}});
    const input=buildCurrentJobMatchInput({job,resume,profile:null,reviewedEvidence:null});
    const initialOutput={...noGapMatch(input),requirementGaps:[{requirement:job.requirements.at(-1)!,jobRequirement:{ref:`job.requirements[${job.requirements.length-1}]`,excerpt:job.requirements.at(-1)!},missingKeywords:["Quenby"]}]};
    const analysis=await client.aIAnalysis.create({data:{userId:user.id,jobPostingId:job.id,type:"JOB_MATCH",model:JOB_MATCH_MODEL,promptName:"jobMatchPrompt",promptVersion:JOB_MATCH_PROMPT_VERSION,inputHash:currentJobMatchInputHash(input),input:{fixture:"product-review"},output:initialOutput as Prisma.InputJsonValue}});
    const review=buildEvidenceCorrectionReview({jobId:job.id,resumeId:resume.id,resumeUpdatedAt:resume.updatedAt.toISOString(),resume,analysisId:analysis.id,analysisInputHash:analysis.inputHash,analysisModel:analysis.model,analysisPromptVersion:analysis.promptVersion,analysisOutput:analysis.output});
    const saved=await saveEvidenceSnapshot(user.id,job.id,{schema:"apply-pilot/evidence-snapshot-save/v2",requestId:randomUUID(),resumeId:resume.id,resumeUpdatedAt:resume.updatedAt.toISOString(),reviewedAnalysis:{id:analysis.id,inputHash:analysis.inputHash!,model:JOB_MATCH_MODEL,promptVersion:JOB_MATCH_PROMPT_VERSION},acceptedFactActions:[],decisions:[{gapId:review.gaps[0]!.id,kind:"OWNER_ATTESTATION",attestedFact:SYNTHETIC_CORRECTION_FLOW_FACT,ownerAttested:true,reuseScope:"JOB_ONLY",masterProfileOptIn:false}]});
    const matcher=createJobMatchRunner({prismaClient:client,score:async matchInput=>{assert.ok(matchInput.reviewedEvidence?.facts.some(fact=>fact.fact===SYNTHETIC_CORRECTION_FLOW_FACT));return noGapMatch(matchInput);}});
    await matcher(user.id,job.id,{force:true});
    const tailored=assembleTailoredResumeProviderOutput(payload,syntheticTailoredResumeOutput(payload));validateTailoredResumeClaims(payload,tailored);
    const letter=assembleCoverLetterProviderOutput(payload,syntheticCoverLetterOutput(payload));validateCoverLetterClaims(payload,letter);
    const version=await client.resumeVersion.create({data:{userId:user.id,resumeId:resume.id,jobPostingId:job.id,evidenceSnapshotId:saved.snapshot.id,title:"Synthetic complete tailored résumé",fullText:tailored.resumeText,skills:[],bullets:[]}});
    const customVersion=await client.resumeVersion.create({data:{userId:user.id,resumeId:resume.id,jobPostingId:job.id,evidenceSnapshotId:saved.snapshot.id,title:"Synthetic Georgia custom format",fullText:tailored.resumeText,skills:[],bullets:[],template:"MODERN",pageSize:"A4",fontFamily:"GEORGIA",fontSize:12,lineSpacing:150,accentColor:"#A1B2C3",createdAt:new Date("2026-10-01T00:00:00Z")}});
    const coverDocument=await client.generatedDocument.create({data:{userId:user.id,jobPostingId:job.id,evidenceSnapshotId:saved.snapshot.id,type:"COVER_LETTER",title:letter.title,content:letter.coverLetter}});
    nextServer=await startNextTestServer({environment:{...process.env,ALLOW_DEMO_USER:"true",DEFAULT_DEMO_USER_ID:user.id,AUTH_SECRET:"synthetic-product-review-local-secret"},readinessPath:"/login",startupTimeoutMs:60_000});
    const origin=nextServer.origin,page=await browser.newPage({viewport:{width:1440,height:1000}}),api:string[]=[],errors:string[]=[];
    page.on("request",request=>{const url=new URL(request.url());if(url.pathname.startsWith("/api/")&&url.pathname!=="/api/auth/session")api.push(url.pathname);});
    page.on("pageerror",error=>errors.push(error.message));
    const response=await page.goto(`${origin}/jobs/${job.id}`,{waitUntil:"networkidle"});
    assert.equal(response?.status(),200,nextServer.getLogs());
    await page.locator("[data-product-source]").getByText(/Harbor Customer Solutions/).waitFor();
    assert.equal(await page.locator("[data-product-source]").getByText(/480-hour/).count(),1);
    const source=await page.locator("[data-product-source]").boundingBox();assert.ok(source&&source.width>=450);
    const initialGeneration=(await client.jobPosting.findUniqueOrThrow({where:{id:job.id}})).evidenceSnapshotGeneration;
    for(const [name,viewport] of [["desktop",{width:1440,height:1000}],["mobile",{width:390,height:844}]] as const) {
      await page.setViewportSize(viewport);
      for(const theme of ["light","dark","system"] as const) {
        await page.locator("summary").filter({hasText:/^Appearance$/}).click();
        await page.locator(`[data-theme-choice="${theme}"] input`).check({force:true});
        await page.locator("summary").filter({hasText:/^Appearance$/}).click();
        if(theme==="system"){await page.emulateMedia({colorScheme:"dark"});await page.waitForFunction(()=>document.documentElement.dataset.productTheme==="dark");await page.emulateMedia({colorScheme:"light"});await page.waitForFunction(()=>document.documentElement.dataset.productTheme==="light");}
        await page.getByRole("button",{name:"1. Background and target job",exact:true}).click();
        await page.screenshot({path:`${outputDir}/${name}-${theme}-source.png`});
        await page.getByRole("button",{name:"Continue to corrections",exact:true}).click();
        assert.match(await page.locator('[data-product-review-stage="corrections"]').innerText(),/Current accepted job-only facts/u);
        await page.getByRole("button",{name:"Continue to documents",exact:true}).click();
        await page.getByRole("button",{name:"Review cover letter",exact:true}).click();
        if(theme!=="light") {
          await page.emulateMedia({colorScheme:"dark"});
          if(theme==="system")await page.waitForFunction(()=>document.documentElement.dataset.productTheme==="dark");
          const contrasts=await page.locator('.application-review-top > p, [data-selected-document="cover"] [data-document-preview] > p:first-of-type').evaluateAll(elements=>elements.map(element=>{
            let ancestor:Element|null=element,background="";
            while(ancestor){background=getComputedStyle(ancestor).backgroundColor;if(background!=="rgba(0, 0, 0, 0)"&&background!=="transparent")break;ancestor=ancestor.parentElement;}
            const [a,b]=[getComputedStyle(element).color,background].map(value=>value.match(/[\d.]+/g)!.slice(0,3).map(Number).map(channel=>{const s=channel/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;}).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i]!,0));
            return(Math.max(a!,b!)+.05)/(Math.min(a!,b!)+.05);
          }));
          assert.equal(contrasts.length,2);assert.ok(contrasts.every(ratio=>ratio>=4.5),"Dark review metadata contrast: "+JSON.stringify(contrasts));
        }
        await page.waitForFunction(()=>document.activeElement?.matches('[data-selected-document="cover"] .application-document-title'));
        const titleBounds=await page.locator('[data-selected-document="cover"] .application-document-title').boundingBox(),navBounds=await page.locator('.application-document-nav').boundingBox();
        assert.ok(titleBounds&&navBounds&&titleBounds.y>=navBounds.y+navBounds.height,"The focused document title must clear the sticky document navigation: "+JSON.stringify({name,theme,titleBounds,navBounds}));
        const opener=name==="desktop"?page.locator('[data-selected-document="cover"] svg text').filter({hasText:"I am applying"}).first():page.locator('[data-selected-document="cover"] [data-reading-content] p').filter({hasText:"I am applying"});
        await page.screenshot({path:`${outputDir}/${name}-${theme}-letter.png`});
        const opening=await opener.boundingBox();assert.ok(opening&&opening.y>=0&&opening.y+opening.height<=viewport.height,"The actual product document opening must be visible without manual scrolling: "+JSON.stringify({name,theme,opening}));
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      }
    }
    assert.deepEqual(api,[]);assert.deepEqual(errors,[]);
    assert.equal((await client.jobPosting.findUniqueOrThrow({where:{id:job.id}})).evidenceSnapshotGeneration,initialGeneration);
    await page.reload({waitUntil:"networkidle"});assert.equal(await page.evaluate(()=>localStorage.getItem("apply-pilot-theme")),"system");
    await page.getByRole("button",{name:"3. Tailored documents",exact:true}).click();
    await page.locator('[data-selected-document="resume"] summary').filter({hasText:/^Edit document text$/}).click();
    const draft=tailored.resumeText+"\nUnsaved synthetic owner edit";
    await page.getByLabel("Tailored résumé text").fill(draft);
    const beforeSwitchRequests=api.length;
    await page.getByRole("button",{name:"Review cover letter",exact:true}).click();
    await page.getByRole("button",{name:"Review résumé",exact:true}).click();
    await page.locator('[data-selected-document="resume"] summary').filter({hasText:/^Edit document text$/}).click();
    assert.equal(await page.getByLabel("Tailored résumé text").inputValue(),draft,"Switching documents must preserve an unsaved owner draft.");
    assert.equal(api.length,beforeSwitchRequests,"Keeping a draft must not save or generate implicitly.");
    assert.equal(await page.getByRole("button",{name:"Preview actual PDF",exact:true}).isDisabled(),true);
    await page.getByRole("button",{name:"Discard unsaved edits",exact:true}).click();
    assert.equal(await page.getByLabel("Tailored résumé text").inputValue(),tailored.resumeText);
    for(const [type,id] of [["resumeVersionId",version.id],["documentId",coverDocument.id]] as const)for(const format of ["pdf","docx"] as const){
      const exported=await page.request.post(origin+"/api/documents/export",{data:{[type]:id,format}});
      assert.equal(exported.status(),200);await writeFile(`${outputDir}/${type==="resumeVersionId"?"resume":"cover-letter"}.${format}`,await exported.body());
    }
    for(const format of ["pdf","docx"] as const){const exported=await page.request.post(origin+"/api/documents/export",{data:{resumeVersionId:customVersion.id,format}});assert.equal(exported.status(),200);await writeFile(`${outputDir}/custom-resume.${format}`,await exported.body());}
    await page.locator('[data-selected-document="resume"] summary').filter({hasText:/^Selected version and formatting$/}).click();
    await page.getByLabel("Résumé version",{exact:true}).selectOption(customVersion.id);
    await page.getByText(/PDF uses Helvetica. DOCX uses Georgia/).waitFor();
    for(const [name,viewport] of [["desktop",{width:1440,height:1000}],["mobile",{width:390,height:844}]] as const){await page.setViewportSize(viewport);await page.screenshot({path:`${outputDir}/${name}-system-georgia-preview.png`});}
    await page.locator('[data-selected-document="resume"] summary').filter({hasText:/^Selected version and formatting$/}).click();
    await page.getByLabel("Résumé version",{exact:true}).selectOption(version.id);
    // Exercise the real font control, actual export handler and exact preview bytes for both artifacts.
    const fontChecks:Array<{kind:string;font:string;hash:string;pages:number}>=[];
    for (const kind of ["resume","cover"] as const) {
      await page.getByRole("button",{name:kind === "resume" ? "Review résumé" : "Review cover letter",exact:true}).click();
      for (const pdfFont of ["HELVETICA","TIMES"] as const) {
        const requestsBefore:number=api.length;
        await page.getByLabel("PDF font",{exact:true}).selectOption(pdfFont);
        assert.equal(api.length,requestsBefore,"Font choice must not save, approve or generate.");
        assert.equal(await page.locator("[data-actual-product-pdf]").count(),0,"A changed font retires the old preview.");
        const responsePromise=page.waitForResponse(response=>response.url().endsWith("/api/documents/export") && response.request().postDataJSON().format === "pdf");
        await page.getByRole("button",{name:"Preview actual PDF",exact:true}).click();
        const exported=await responsePromise;assert.equal(exported.status(),200);
        assert.equal(exported.request().postDataJSON().pdfFont,pdfFont);
        // Chromium can expose an empty CDP response.body() for PDF attachments. Read the actual
        // preview blob and independently compare it to the same authenticated production handler.
        const independent=await page.request.post(origin+"/api/documents/export",{data:exported.request().postDataJSON()});
        assert.equal(independent.status(),200);
        const bytes=await independent.body();
        assert.match(bytes.toString("latin1"),pdfFont === "TIMES" ? /BaseFont \/Times-Roman\b/ : /BaseFont \/Helvetica\b/);
        await page.locator("[data-actual-product-pdf] iframe").waitFor();
        const previewBytes=await page.locator("[data-actual-product-pdf] iframe").evaluate(async element=>Array.from(new Uint8Array(await (await fetch((element as HTMLIFrameElement).src)).arrayBuffer())));
        assert.deepEqual(Buffer.from(previewBytes),bytes,"The browser preview must use the actual response bytes.");
        const downloadPromise=page.waitForEvent("download");
        await page.getByRole("link",{name:"Download this exact PDF",exact:true}).click();
        const downloaded=await downloadPromise,path=await downloaded.path();assert.ok(path);
        assert.deepEqual(await readFile(path),bytes,"Exact preview download must be byte identical.");
        await writeFile(`${outputDir}/${kind}-${pdfFont.toLowerCase()}.pdf`,bytes);
        const pages=Number(bytes.toString("latin1").match(/\/Count (\d+)/)![1]);
        fontChecks.push({kind,font:pdfFont,hash:createHash("sha256").update(bytes).digest("hex"),pages});
        for (const width of [1440,320,390]) {
          await page.setViewportSize({width,height:width === 1440 ? 1000 : 844});
          await page.getByLabel("PDF font",{exact:true}).scrollIntoViewIfNeeded();
          const bounds=await page.getByLabel("PDF font",{exact:true}).boundingBox();assert.ok(bounds&&bounds.height>=44&&bounds.x>=0&&bounds.x+bounds.width<=width+1);
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
          assert.equal(await page.getByRole("link",{name:"Open this exact PDF in a new tab",exact:true}).isVisible(),true);
          await page.screenshot({path:`${outputDir}/pdf-font-${kind}-${pdfFont.toLowerCase()}-${width}.png`});
          await page.locator("[data-actual-product-pdf] iframe").scrollIntoViewIfNeeded();
          await page.screenshot({path:`${outputDir}/actual-pdf-${kind}-${pdfFont.toLowerCase()}-${width}.png`});
        }
      }
    }
    await writeFile(`${outputDir}/pdf-font-checks.json`,JSON.stringify(fontChecks,null,2));
    // A pending response for a retired font must never appear under its replacement choice.
    await page.getByRole("button",{name:"Review résumé",exact:true}).click();
    let releaseFont!:()=>void,markFontSeen!:()=>void,markFontDone!:()=>void;
    const fontDelayed=new Promise<void>(resolve=>{releaseFont=resolve;}),fontSeen=new Promise<void>(resolve=>{markFontSeen=resolve;}),fontDone=new Promise<void>(resolve=>{markFontDone=resolve;});
    await page.route("**/api/documents/export",async route=>{const result=await route.fetch();markFontSeen();await fontDelayed;await route.fulfill({response:result}).catch(()=>undefined);markFontDone();});
    await page.getByRole("button",{name:"Preview actual PDF",exact:true}).click();await fontSeen;
    await page.getByLabel("PDF font",{exact:true}).selectOption("TIMES");releaseFont();await fontDone;
    assert.equal(await page.locator("[data-actual-product-pdf]").count(),0);
    await page.unroute("**/api/documents/export");
    await page.getByLabel("PDF font",{exact:true}).selectOption("HELVETICA");
    // Verify the ordinary résumé editor also presents separate font choices and preserves edit invalidation.
    const editor=await browser.newPage({viewport:{width:1440,height:1000}});
    await editor.goto(`${origin}/resumes/${customVersion.id}`,{waitUntil:"networkidle"});
    assert.equal(await editor.getByLabel("DOCX font",{exact:true}).inputValue(),"GEORGIA");
    assert.deepEqual(await editor.getByLabel("DOCX font",{exact:true}).locator("option").evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value)),["ARIAL","CALIBRI","GEORGIA"]);
    await editor.getByLabel("PDF font",{exact:true}).selectOption("TIMES");
    await editor.getByRole("button",{name:"Preview actual PDF",exact:true}).click();await editor.locator("[data-actual-product-pdf] iframe").waitFor();
    assert.equal(await editor.getByRole("button",{name:"Save version",exact:true}).isDisabled(),true);
    for(const width of [1440,320,390]){
      await editor.setViewportSize({width,height:width===1440?1000:844});
      assert.equal(await editor.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await editor.getByLabel("PDF font",{exact:true}).scrollIntoViewIfNeeded();
      const control=await editor.getByLabel("PDF font",{exact:true}).boundingBox();assert.ok(control&&control.height>=44&&control.x>=0&&control.x+control.width<=width+1);
      await editor.screenshot({path:`${outputDir}/pdf-font-resume-editor-${width}.png`});
    }
    await editor.getByLabel("PDF font",{exact:true}).selectOption("HELVETICA");
    assert.equal(await editor.locator("[data-actual-product-pdf]").count(),0);
    await editor.getByLabel("Resume text",{exact:true}).fill(tailored.resumeText+"\nSynthetic owner edit");
    assert.equal(await editor.getByRole("button",{name:"Preview actual PDF",exact:true}).isDisabled(),true);
    await editor.getByRole("button",{name:"Save version",exact:true}).click();
    await editor.getByText("Regenerate this document from current reviewed evidence before exporting.",{exact:true}).waitFor();
    assert.equal(await editor.locator("[data-actual-product-pdf]").count(),0);
    const edited=await client.resumeVersion.findUniqueOrThrow({where:{id:customVersion.id}});assert.equal(edited.evidenceSnapshotId,null);
    for(const pdfFont of ["HELVETICA","TIMES"]){const rejected=await editor.request.post(origin+"/api/documents/export",{data:{resumeVersionId:customVersion.id,format:"pdf",pdfFont}});assert.equal(rejected.status(),409);}
    await editor.close();
    await page.getByRole("button",{name:"3. Tailored documents",exact:true}).click();
    await page.getByRole("button",{name:"Review résumé",exact:true}).click();
    assert.equal(await page.getByRole("button",{name:"Preview actual PDF",exact:true}).count(),1,JSON.stringify({stage:await page.locator('[data-product-review-stage="documents"]').getAttribute("hidden"),buttons:await page.locator('[data-product-documents] button').allTextContents()}));
    let releaseDelayed!:()=>void,markDelayedSeen!:()=>void,markDelayedDone!:()=>void;
    const delayed=new Promise<void>(resolve=>{releaseDelayed=resolve;}),seen=new Promise<void>(resolve=>{markDelayedSeen=resolve;}),done=new Promise<void>(resolve=>{markDelayedDone=resolve;});
    await page.route("**/api/documents/export",async route=>{const result=await route.fetch();markDelayedSeen();await delayed;await route.fulfill({response:result}).catch(()=>undefined);markDelayedDone();});
    await page.getByRole("button",{name:"Preview actual PDF",exact:true}).click();await seen;
    await page.getByRole("button",{name:"Review cover letter",exact:true}).click();releaseDelayed();await done;
    assert.equal(await page.locator("[data-actual-product-pdf]").count(),0,"A delayed résumé response cannot publish into a different selected document.");
    await page.unroute("**/api/documents/export");
    await page.getByRole("button",{name:"Preview actual PDF",exact:true}).click();await page.locator("[data-actual-product-pdf] iframe").waitFor();
    await page.getByRole("button",{name:"2. Missing-fact corrections",exact:true}).click();await page.getByRole("button",{name:"Save reviewed evidence",exact:true}).click();
    await page.getByText(/Saved reviewed snapshot/).waitFor();
    await page.getByRole("button",{name:"3. Tailored documents",exact:true}).click();
    assert.equal(await page.getByRole("button",{name:"Preview actual PDF",exact:true}).isDisabled(),true);
    assert.equal(await page.locator("[data-actual-product-pdf]").count(),0);
    let matchCalls=0;
    await page.route(`**/api/jobs/${job.id}/match`,async route=>{matchCalls++;if(matchCalls===1){await route.fulfill({status:428,contentType:"application/json",body:JSON.stringify({code:"AI_COST_CONFIRMATION_REQUIRED",maximumCostMicros:72720})});return;}assert.equal(route.request().headers()["x-ai-cost-confirmed"],"true");await matcher(user.id,job.id,{force:true});await route.fulfill({status:200,contentType:"application/json",body:"{}"});});
    page.on("dialog",dialog=>void dialog.accept());
    await page.getByRole("button",{name:"2. Missing-fact corrections",exact:true}).click();await page.getByRole("button",{name:/Reassess/}).click();
    await page.waitForFunction(()=>!document.querySelector('[data-product-review-stage="documents"] fieldset[disabled]'));
    assert.equal(matchCalls,2);
    await page.getByRole("button",{name:"3. Tailored documents",exact:true}).click();
    const stale=await page.request.post(origin+"/api/documents/export",{data:{resumeVersionId:version.id,format:"pdf"}});assert.equal(stale.status(),409);
    assert.equal(await page.getByRole("button",{name:"Preview actual PDF",exact:true}).isDisabled(),true);
    await writeFile(`${outputDir}/route-check.json`,JSON.stringify({actualRoute:`/jobs/${job.id}`,sourceJobs:3,navigationApiCalls:0,navigationEvidenceMutations:0,matchCalls,delayedDifferentDocumentResponseIgnored:true,explicitPdfFontChecks:fontChecks,docxGeorgiaPreserved:true,exported:["resume.pdf","resume.docx","cover-letter.pdf","cover-letter.docx","custom-resume.pdf","custom-resume.docx"],staleExportStatus:stale.status(),consoleErrors:errors},null,2));
    await page.close();
  }finally{await browser.close();await nextServer?.stop();await client.user.delete({where:{id:user.id}});await client.$disconnect();}
});

test("linked synthetic correction journey persists reviewed facts into both generated and exported documents", async () => {
  const config = validatePostgresTestEnvironment(process.env);
  const live = await verifyLivePostgresTestDatabase(config);
  assertPostgresTestMajorVersion(live);
  const client = new PrismaClient({ datasources: { db: { url: config.url } } });
  const canonicalFixture = fullSizeSyntheticProviderOutput();
  const docx = await readFile(new URL("../fixtures/synthetic-resume-estimator-boundary.docx", import.meta.url));
  const extracted = await extractResumeDocxText(docx);
  assert.equal(extracted, fullSizeSyntheticDocxExtractedText);
  const providerProjection = providerV9FromCanonical(extracted, canonicalFixture);
  const parsed = assembleAndValidateResumeV9(extracted, providerProjection);
  assert.equal(parsed.contractVersion, "9");
  assert.equal(parsed.workHistory.length, canonicalFixture.workHistory.length);
  assert.equal(parsed.projects.length, canonicalFixture.projects.length);
  assert.deepEqual(parsed.sourceSections.at(-1), canonicalFixture.sourceSections.at(-1));

  const user = await client.user.create({ data: { email: `linked-correction-${randomUUID()}@example.test` } });
  try {
    const job = await client.jobPosting.create({ data: {
      userId: user.id,
      title: "Service Operations Director",
      normalizedTitle: `service-operations-director-${randomUUID()}`,
      company: "Synthetic Employer",
      normalizedCompany: `synthetic-employer-${randomUUID()}`,
      normalizedLocation: "remote-linked-correction",
      sourceUrl: `https://example.test/jobs/${randomUUID()}`,
      normalizedApplyUrl: `https://example.test/apply/${randomUUID()}`,
      description: "Lead service delivery, business operations, TypeScript, and PostgreSQL programs.",
      requirements: [...jobRequirements],
      preferredQualifications: [], benefits: [], detectedTechStack: ["TypeScript", "PostgreSQL"],
      sourceType: "MANUAL", missingKeywords: [], supportedKeywords: [], concerns: []
    } });
    const resume = await client.resume.create({ data: {
      userId: user.id,
      isMaster: true,
      title: "Linked Synthetic Master Resume",
      rawText: extracted,
      summary: parsed.summary,
      skills: parsed.skills,
      achievements: parsed.achievements,
      workHistory: parsed.workHistory as Prisma.InputJsonValue,
      projects: parsed.projects as Prisma.InputJsonValue,
      education: parsed.education as Prisma.InputJsonValue,
      certifications: parsed.certifications as Prisma.InputJsonValue
    } });
    const plainInput = buildCurrentJobMatchInput({ job, resume, profile: null, reviewedEvidence: null });
    const initialOutput = validateAndNormalizeJobMatchOutput(plainInput, {
      contractVersion: "3",
      overallFitScore: 45,
      resumeKeywordScore: 45,
      skillsMatchScore: 45,
      experienceMatchScore: 45,
      careerGoalScore: 45,
      locationWorkStyleScore: 45,
      compensationScore: null,
      confidenceScore: 90,
      confidenceBasis: "Synthetic gaps cite exact structured requirements.",
      factualMatches: [],
      requirementGaps: jobRequirements.map((requirement, index) => ({
        requirement,
        jobRequirement: { ref: `job.requirements[${index}]`, excerpt: requirement },
        missingKeywords: [missingRequirementKeywords[index]!]
      })),
      advice: {
        keywordsToEmphasize: [],
        resumeAngle: "Resolve only with reviewed evidence.",
        coverLetterAngle: "Resolve only with reviewed evidence."
      },
      recommendation: "consider"
    }).normalized;
    const analysis = await client.aIAnalysis.create({ data: {
      userId: user.id,
      jobPostingId: job.id,
      type: "JOB_MATCH",
      model: JOB_MATCH_MODEL,
      promptName: "jobMatchPrompt",
      promptVersion: JOB_MATCH_PROMPT_VERSION,
      inputHash: currentJobMatchInputHash(plainInput),
      input: { fixture: "linked-correction" },
      output: { ...initialOutput, promptVersion: JOB_MATCH_PROMPT_VERSION }
    } });
    const initial = await saveEvidenceSnapshot(user.id, job.id, {
      schema: "apply-pilot/evidence-snapshot-save/v1",
      requestId: `linked-initial-${randomUUID()}`,
      resumeId: resume.id,
      resumeUpdatedAt: resume.updatedAt.toISOString(),
      reviewedAnalysis: {
        id: analysis.id,
        inputHash: analysis.inputHash!,
        model: JOB_MATCH_MODEL,
        promptVersion: JOB_MATCH_PROMPT_VERSION
      },
      decisions: [
        {
          gapId: "gap:0",
          kind: "SOURCE_CORRECTION",
          sourceFactId: "fact:resume.rawText",
          sourceExcerpt: degreeFact,
          correctedFact: degreeFact,
          reuseScope: "JOB_ONLY",
          masterProfileOptIn: false
        },
        {
          gapId: "gap:1",
          kind: "OWNER_ATTESTATION",
          attestedFact: originalOwnerFact,
          ownerAttested: true,
          reuseScope: "JOB_ONLY",
          masterProfileOptIn: false
        },
        {
          gapId: "gap:2",
          kind: "OWNER_ATTESTATION",
          attestedFact: removedOwnerFact,
          ownerAttested: true,
          reuseScope: "JOB_ONLY",
          masterProfileOptIn: false
        }
      ]
    });

    const scoredInputs: MatchInput[] = [];
    const runner = createJobMatchRunner({ prismaClient: client, score: async (input) => {
      scoredInputs.push(input);
      return noGapMatch(input);
    } });
    await runner(user.id, job.id, { force: true });
    const firstReassessment = await client.aIAnalysis.findFirstOrThrow({ where: {
      userId: user.id, jobPostingId: job.id, evidenceSnapshotId: initial.snapshot.id, type: "JOB_MATCH"
    }, orderBy: { createdAt: "desc" } });
    const initialSnapshot = await client.evidenceSnapshot.findUniqueOrThrow({ where: { id: initial.snapshot.id } });
    const accepted = acceptedEvidenceFactsFromSnapshot(initialSnapshot);
    assert.deepEqual(accepted.map((fact) => fact.fact), [degreeFact, originalOwnerFact, removedOwnerFact]);

    const final = await saveEvidenceSnapshot(user.id, job.id, {
      schema: "apply-pilot/evidence-snapshot-save/v2",
      requestId: `linked-final-${randomUUID()}`,
      resumeId: resume.id,
      resumeUpdatedAt: resume.updatedAt.toISOString(),
      reviewedAnalysis: {
        id: firstReassessment.id,
        inputHash: firstReassessment.inputHash!,
        model: JOB_MATCH_MODEL,
        promptVersion: JOB_MATCH_PROMPT_VERSION
      },
      decisions: [],
      acceptedFactActions: [
        { factId: accepted[0]!.factId, action: "RETAIN" },
        {
          factId: accepted[1]!.factId,
          action: "REPLACE_OWNER_ATTESTATION",
          attestedFact: replacementOwnerFact,
          ownerAttested: true,
          reuseScope: "JOB_ONLY",
          masterProfileOptIn: false
        },
        { factId: accepted[2]!.factId, action: "REMOVE" }
      ]
    });
    await runner(user.id, job.id, { force: true });
    const finalSnapshot = await client.evidenceSnapshot.findUniqueOrThrow({ where: { id: final.snapshot.id } });
    assert.deepEqual(reviewedEvidenceFromSnapshot(finalSnapshot).facts.map((fact) => ({
      fact: fact.fact, provenance: fact.provenance
    })), [
      { fact: degreeFact, provenance: "SUBMITTED_RESUME" },
      { fact: replacementOwnerFact, provenance: "OWNER_ATTESTED" }
    ]);
    const finalScoreInput = scoredInputs.at(-1)!;
    assert.deepEqual(finalScoreInput.reviewedEvidence?.facts.map((fact) => fact.fact), [
      degreeFact, replacementOwnerFact
    ]);
    assert.doesNotMatch(JSON.stringify(finalScoreInput), new RegExp(removedOwnerFact, "u"));

    const resumePost = createTailoredResumeRouteHandler({
      prismaClient: client as never,
      requireUserId: async () => user.id,
      checkRateLimit: async () => undefined,
      readApplicationDocumentEvidence,
      tailorResume: (async (payload: unknown) => {
        assertFinalDocumentPayload(payload);
        const promptVersion = "6";
        return {
          professionalSummary: `${degreeFact}. ${replacementOwnerFact}`,
          skillsSection: ["TypeScript", "PostgreSQL", "Service delivery"],
          bulletRewrites: [],
          rolesOrProjectsToEmphasize: ["Service Operations Director"],
          unsupportedKeywords: [],
          formattingWarnings: [],
          resumeText: `SYNTHETIC TAILORED RESUME\n${degreeFact}\n${replacementOwnerFact}`,
          claimEvidence: [
            { claim: degreeFact, citations: [{ ref: "reviewedEvidence.facts[0].fact", excerpt: degreeFact }] },
            { claim: replacementOwnerFact, citations: [{ ref: "reviewedEvidence.facts[1].fact", excerpt: replacementOwnerFact }] }
          ],
          model: "stubbed-openai",
          promptVersion,
          inputHash: hashAiInput("resumeTailorPrompt", promptVersion, payload),
          usage: stubUsage("resumeTailorPrompt", promptVersion, payload)
        };
      }) as never,
      writeAuditLog: async () => undefined
    });
    const coverPost = createCoverLetterRouteHandler({
      prismaClient: client as never,
      requireUserId: async () => user.id,
      checkRateLimit: async () => undefined,
      readApplicationDocumentEvidence,
      draftCoverLetter: (async (payload: unknown) => {
        assertFinalDocumentPayload(payload);
        const promptVersion = "6";
        return {
          title: "Synthetic Employer Service Operations Director cover letter",
          coverLetter: `Dear Synthetic Employer,\n\n${degreeFact}. ${replacementOwnerFact}\n\nSincerely,\nTaylor Boundary`,
          angle: "Use only retained and replaced reviewed evidence.",
          claimsUsed: [
            { claim: degreeFact, citations: [{ ref: "reviewedEvidence.facts[0].fact", excerpt: degreeFact }] },
            { claim: replacementOwnerFact, citations: [{ ref: "reviewedEvidence.facts[1].fact", excerpt: replacementOwnerFact }] }
          ],
          model: "stubbed-openai",
          promptVersion,
          inputHash: hashAiInput("coverLetterPrompt", promptVersion, payload),
          usage: stubUsage("coverLetterPrompt", promptVersion, payload)
        };
      }) as never,
      writeAuditLog: async () => undefined
    });
    const resumeResponse = await resumePost(new Request("http://localhost/api/jobs/x/tailored-resume", {
      method: "POST"
    }) as NextRequest, { params: Promise.resolve({ id: job.id }) });
    const coverResponse = await coverPost(new Request("http://localhost/api/jobs/x/cover-letter", {
      method: "POST"
    }) as NextRequest, { params: Promise.resolve({ id: job.id }) });
    assert.equal(resumeResponse.status, 200);
    assert.equal(coverResponse.status, 200);
    const resumeBody = await resumeResponse.json();
    const coverBody = await coverResponse.json();
    assert.equal(resumeBody.version.evidenceSnapshotId, final.snapshot.id);
    assert.equal(coverBody.document.evidenceSnapshotId, final.snapshot.id);

    const exportHandlers = createDocumentExportRouteHandlers({
      requireUserId: async () => user.id,
      checkRateLimit: async () => undefined,
      findGeneratedDocument: ({ id, userId }) => client.generatedDocument.findFirst({
        where: { id, userId },
        include: { jobPosting: { select: exportJobEvidenceSelect } }
      }),
      findResumeVersion: ({ id, userId }) => client.resumeVersion.findFirst({
        where: { id, userId },
        include: { jobPosting: { select: exportJobEvidenceSelect } }
      })
    });
    const exportedResume = await exportHandlers.POST(exportRequest({ resumeVersionId: resumeBody.version.id }));
    const exportedCover = await exportHandlers.POST(exportRequest({ documentId: coverBody.document.id }));
    assert.equal(exportedResume.status, 200);
    assert.equal(exportedCover.status, 200);
    const resumeText = await extractResumeDocxText(Buffer.from(await exportedResume.arrayBuffer()));
    const coverText = await extractResumeDocxText(Buffer.from(await exportedCover.arrayBuffer()));
    for (const output of [resumeText, coverText]) {
      assert.match(output, new RegExp(degreeFact, "u"));
      assert.match(output, new RegExp(replacementOwnerFact, "u"));
      assert.doesNotMatch(output, new RegExp(removedOwnerFact, "u"));
    }
  } finally {
    await client.user.delete({ where: { id: user.id } });
    await client.$disconnect();
  }
});

const exportJobEvidenceSelect = {
  currentEvidenceSnapshotId: true,
  evidenceSnapshotGeneration: true,
  currentEvidenceSnapshot: { select: CURRENT_EVIDENCE_SNAPSHOT_SELECT },
  user: { select: { resumes: {
    where: { isMaster: true },
    orderBy: { updatedAt: "desc" as const },
    take: 1,
    select: { id: true, updatedAt: true }
  } } }
} as const;

function exportRequest(input: { documentId?: string; resumeVersionId?: string }) {
  return new Request("http://localhost/api/documents/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, format: "docx" })
  }) as NextRequest;
}

function assertFinalDocumentPayload(payload: unknown) {
  const serialized = JSON.stringify(payload);
  assert.match(serialized, new RegExp(degreeFact, "u"));
  assert.match(serialized, new RegExp(replacementOwnerFact, "u"));
  assert.doesNotMatch(serialized, new RegExp(removedOwnerFact, "u"));
}

function stubUsage(promptName: string, promptVersion: string, payload: unknown) {
  return {
    provider: "openai" as const,
    model: "stubbed-openai",
    promptVersion,
    requestHash: hashAiInput(promptName, promptVersion, payload),
    inputTokens: 1,
    outputTokens: 1,
    cachedInputTokens: 0,
    estimatedCostMicros: 0,
    mocked: true
  };
}

function noGapMatch(input: MatchInput) {
  const inputHash = currentJobMatchInputHash(input);
  return {
    contractVersion: "3" as const,
    overallFitScore: 90,
    resumeKeywordScore: 90,
    skillsMatchScore: 90,
    experienceMatchScore: 90,
    careerGoalScore: 90,
    locationWorkStyleScore: 90,
    compensationScore: null,
    confidenceScore: 90,
    confidenceBasis: "Synthetic reviewed evidence is explicit.",
    factualMatches: [], requirementGaps: [],
    advice: { keywordsToEmphasize: [], resumeAngle: "Use reviewed evidence.", coverLetterAngle: "Use reviewed evidence." },
    recommendation: "apply now" as const,
    compensationAssessment: { score: null, reason: "missing_both" as const },
    confidenceAssessment: { score: 90, label: "Uncalibrated model self-assessment" as const,
      basis: "Synthetic reviewed evidence is explicit." },
    whyGoodMatch: ["Reviewed evidence supports the requirements."],
    concerns: [], missingKeywords: [], supportedKeywords: ["business", "service delivery"],
    keywordsToEmphasize: [], suggestedResumeAngle: "Use reviewed evidence.",
    suggestedCoverLetterAngle: "Use reviewed evidence.",
    model: JOB_MATCH_MODEL,
    promptVersion: JOB_MATCH_PROMPT_VERSION,
    inputHash,
    usage: { provider: "gemini" as const, model: JOB_MATCH_MODEL, promptVersion: JOB_MATCH_PROMPT_VERSION,
      requestHash: inputHash, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0,
      estimatedCostMicros: 0, mocked: true }
  };
}
