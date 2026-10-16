import { syntheticCorrectionFlowDocumentPayload } from "@/evaluation/correction-flow-provider-stub";
import { SYNTHETIC_CORRECTION_FLOW_FACT } from "@/evaluation/correction-flow-qualification-fixture";
import { buildApplicationDocumentFactCatalog } from "@/lib/ai/application-document-facts";
import type { ApplicationDocumentPayload } from "@/lib/ai/application-document-claims";

// C2 authored benchmark: one complete source-backed sentence per fact ID.
// This is not provider output or a replacement for the frozen qualification wire fixture.
export function authoredDocumentQualityLetter(payload: ApplicationDocumentPayload = syntheticCorrectionFlowDocumentPayload()) {
  const catalog=buildApplicationDocumentFactCatalog(payload);
  const factId=(excerpt:string)=>{
    const fact=catalog.find(fact=>fact.excerpt===excerpt);
    if(!fact)throw new Error("The authored sample requires its declared synthetic source facts.");
    return fact.factId;
  };
  const summary=payload.resume?.summary;
  if(typeof summary!=="string"||!summary.trim())throw new Error("The authored sample requires its declared synthetic summary.");
  const evidence=[
    {claim:"I am a "+summary[0]!.toLocaleLowerCase()+summary.slice(1),sources:[summary]},
    {claim:"I directed service delivery across support, engineering, and customer success for 42 enterprise accounts.",sources:["Directed service delivery across support, engineering, and customer success for 42 enterprise accounts."]},
    {claim:"I reduced median incident review time from five business days to two by standardizing evidence capture and ownership.",sources:["Reduced median incident review time from five business days to two by standardizing evidence capture and ownership."]},
    {claim:"I improved monthly service-level reporting accuracy by 18% through documented SQL validation checks.",sources:["Improved monthly service-level reporting accuracy by 18% through documented SQL validation checks."]},
    {claim:"I mentored six service coordinators on escalation planning, evidence quality, and stakeholder communication.",sources:["Mentored six service coordinators on escalation planning, evidence quality, and stakeholder communication."]},
    {claim:SYNTHETIC_CORRECTION_FLOW_FACT,sources:[SYNTHETIC_CORRECTION_FLOW_FACT]}
  ];
  return {
    title:"Northwind Service Cloud — Service Operations Director",
    coverLetter:[
      "Taylor Boundary",
      "taylor.boundary@example.test | +1 555 010 0200 | Seattle, WA | Remote",
      "",
      "Dear Northwind Service Cloud Hiring Team,",
      "",
      "I am applying for the Service Operations Director position at Northwind Service Cloud. "+evidence[0].claim,
      "",
      evidence[1].claim+" "+evidence[2].claim,
      "",
      evidence[3].claim+" "+evidence[4].claim,
      "",
      evidence[5].claim+" I would welcome the opportunity to discuss the role further.",
      "",
      "Thank you for your time and consideration.",
      "",
      "Sincerely,",
      "Taylor Boundary"
    ].join("\n"),
    angle:"Operational accountability demonstrated through delivery, reporting, and team development.",
    claimsUsed:evidence.flatMap(entry=>entry.sources.map(source=>({claim:entry.claim,factId:factId(source)})))
  };
}
