import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ApplicationReviewWorkspace } from "@/components/application-review-workspace";
import { realisticDocumentQualityPayload } from "@/evaluation/document-quality-career-fixture";

test("the actual product workspace renders full source and target with existing correction/generation/document controls", () => {
  const payload=realisticDocumentQualityPayload();
  const element=createElement(ApplicationReviewWorkspace,{
    sourceText:payload.resume!.rawText as string,
    job:{title:"Service Operations Director",company:"Northwind Service Cloud",description:"Lead operational governance.",requirements:["Enterprise delivery"],preferredQualifications:["Business education"]},
    correctionReview:null,resumeVersions:[],coverLetters:[],
    generationControls:createElement("span",null,"Existing consent-controlled generation")
  });
  const untouched=()=>{throw new Error("Rendering must not navigate or refresh.");};
  const html=renderToStaticMarkup(createElement(AppRouterContext.Provider,{value:{bfcacheId:"synthetic-review",back:untouched,forward:untouched,push:untouched,replace:untouched,refresh:untouched,prefetch:untouched}},element));
  for(const text of ["Harbor Customer Solutions","Business Administration","480-hour","Background and target job","Missing-fact corrections","Tailored documents","Existing consent-controlled generation"])assert.ok(html.includes(text));
  assert.equal((html.match(/data-application-review-workspace/gu)||[]).length,1);
});
